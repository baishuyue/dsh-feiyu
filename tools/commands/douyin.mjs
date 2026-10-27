// douyin —— 抖音互动（刷视频 / 读评论 / 发评论@），Playwright 浏览器自动化。
// 个人号没有公开 API，只能靠 patchright + 本地 Chrome 模拟人操作 douyin.com。
// 底层脚本：D:\social-auto-upload\douyin_interact.py（login/feed/comments/comment 四个子命令）。
//
//   node feiyu.mjs douyin login                        # 扫码登录一次（cookie 存 ~/.feiyu-ai）
//   node feiyu.mjs douyin feed                         # 刷 feed 采集视频（JSON）
//   node feiyu.mjs douyin comments --vid <id>          # 读某视频热评
//   node feiyu.mjs douyin comment --vid <id> --message "…" [--go]   # 发评论（默认干跑）
//   node feiyu.mjs douyin interact                     # 全流程：feed→选题→LLM评论→发（DRY）
//
// 风控铁律：评论默认 DRY（只打印不真发），interact 全程 DRY；确认选题准了再手动 --go。
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { config } from '../lib/config.mjs'
import { dataPath } from '../lib/paths.mjs'
import * as memory from '../lib/memory.mjs'
import { sanitizeFor, autoTag } from '../lib/stickers.mjs'
import { classifyComment, replyable, stickerFallback } from '../lib/comment-kind.mjs'
import { chooseKind, decorateText, pickCommentImage, describeKind } from '../lib/reply-style.mjs'
import { acquire } from '../lib/lock.mjs'

function arg(argv, name) {
  const i = argv.indexOf(name)
  return i >= 0 ? String(argv[i + 1] ?? '') : ''
}

function pyPath(cfg) {
  return cfg.douyin?.python || 'D:/social-auto-upload/.venv/Scripts/python.exe'
}
function scriptPath(cfg) {
  return cfg.douyin?.script || 'D:/social-auto-upload/douyin_interact.py'
}
function cookiePath(cfg) {
  return cfg.douyin?.cookie || dataPath('douyin-cookies.json')
}

// 抖音独立 dryRun（默认开）：不跟随全局 guard.dryRun，抖音要单独确认后才真发
function douyinDry(cfg) {
  return cfg.douyin?.dryRun !== false
}

function runPy(argv, cfg, { soft = false } = {}) {
  const cmd = [scriptPath(cfg), ...argv, '--cookie', cookiePath(cfg)]
  try {
    return execFileSync(pyPath(cfg), cmd, { encoding: 'utf8', timeout: 300000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    // 失败时 python 的日志全在 stdout（[reply] ✗ … ），以前只打印 stderr → 空报错，白跑一次
    const out = String(e.stdout ?? '').trim().split('\n').filter(Boolean).slice(-6).join('\n')
    const err = String(e.stderr ?? '').trim().slice(-400)
    // soft：调用方自己 try/catch（比如批量回复里某一条失败，不该把整轮干掉）
    if (soft) throw new Error((out || err || ('exit ' + (e.status ?? '?'))).replace(/\s+/g, ' ').slice(0, 160))
    console.error(`✗ 抖音脚本失败（exit ${e.status ?? '?'}）${out ? '\n' + out : ''}${err ? '\n' + err : ''}`)
    process.exit(1)
  }
}

function parseFeedJson(out) {
  // feed 输出里混着日志行，抽最后一个 { ... } JSON
  const m = out.match(/\{[\s\S]*\}/)
  if (!m) return { videos: [] }
  try { return JSON.parse(m[0]) } catch { return { videos: [] } }
}

// 口味过滤（仿 B站 feed：标题/文案命中偏好；静态偏好没中时再问她自己养成的兴趣）
function matchPrefs(v, cfg) {
  const like = cfg.preferences?.like || []
  const dislike = cfg.preferences?.dislike || []
  const hay = (v.desc + ' ' + v.author).toLowerCase()
  for (const w of dislike) if (w && hay.includes(String(w).toLowerCase())) return false
  if (like.some(w => w && hay.includes(String(w).toLowerCase()))) return true
  const grams = memory.interestGrams()
  if (grams.size && memory.interestScore(hay, grams) >= 3) return true
  return !like.length
}

// 自己账号（cookie 登录的那个 = 顾思苡）的 sec_uid。
// ⚠️ 10-25 主人纠正：douyin.owner 是主人自己（朴昌范），**她的作品在顾思苡号上** ——
// 运营"自己作品评论区"必须扫 self，不是 owner（以前扫错号，跑到主人的旅行视频下回复了）。
function selfSecUid(cfg, { refresh = false } = {}) {
  const CACHE = dataPath('douyin-self.json')
  if (!refresh) {
    try {
      const j = JSON.parse(fs.readFileSync(CACHE, 'utf8'))
      if (j && j.sec_uid) return String(j.sec_uid)
    } catch {}
  }
  try {
    const out = runPy(['self-info'], cfg)
    const m = out.match(/\{[\s\S]*\}/)
    if (m) {
      const j = JSON.parse(m[0])
      if (j && j.sec_uid) {
        try { fs.writeFileSync(CACHE, JSON.stringify(j)) } catch {}
        return String(j.sec_uid)
      }
    }
  } catch {}
  return String(cfg.douyin?.self?.sec_uid || '')
}

export function run(argv = []) {
  const cmd = argv[0] || 'help'
  const cfg = config()

  if (cmd === 'self' || cmd === 'self-info') {
    console.log(runPy(['self-info'], cfg))
    return
  }

  // ── 运营模式（10-25）：扫自己视频的新评论 → 她自己判断回谁、回什么 → comment-reply 真发 ──
  if (cmd === 'engage') {
    const eg = cfg.douyin?.engage ?? {}
    if (eg.enabled === false) { console.log('douyin.engage.enabled 是关的'); return }
    // 单实例锁（10-26）：调度器 120 分钟一跑 + 手动跑，两个 engage 会各拿一份水位互相覆盖 ——
    // 实测把 douyin-engage.json 写成只剩 2 个键（历史全丢，老评论会被当成新的重答一遍）。
    const releaseEngage = acquire('douyin-engage')
    if (!releaseEngage) { console.log('已有一个 douyin engage 在跑，这轮跳过（避免并发送重复回复）'); return }
    // --dry：只跑到"她打算回谁、回什么"就停，绝不发 —— 测试整条链路又不动真账号
    const dry = douyinDry(cfg) || argv.includes('--dry')
    const secUid = argv.includes('--owner')
      ? String(cfg.douyin?.owner?.sec_uid || '')
      : selfSecUid(cfg)
    if (!secUid) { console.error('✗ 读不到自己账号 sec_uid：先跑 node feiyu.mjs douyin self'); return }
    // ① 自己的投稿列表
    const vidsJson = parseFeedJson(runPy(['my-videos', '--sec-uid', secUid], cfg))
    const videos = (vidsJson.videos || []).slice(0, 3)
    if (!videos.length) { console.log('没扫到投稿（登录态/主页结构变了？）'); return }
    console.log(`自己的投稿 ${videos.length} 个：${videos.map((v) => v.desc.slice(0, 12)).join(' / ')}`)
    // ② 各视频的评论（水位：**按 cid**）
    // 10-26 修「同一个人只能被回一次」：以前水位键是 `vid:用户:文本前24字`，加上 python 侧
    // 只读一级评论、压根看不见子回复，等于每人只能被回一句。现在按 cid 记（每条评论 cid 唯一），
    // 对方再回一句就是新 cid → 还能接着聊；配 perUser 日上限防止追着一个人刷屏。
    const WM = dataPath('douyin-engage.json')
    let wm = { seen: [], perUser: {} }
    try { wm = JSON.parse(fs.readFileSync(WM, 'utf8')) } catch {}
    if (!Array.isArray(wm.seen)) wm.seen = []
    const today = new Date().toLocaleDateString('sv-SE')
    if (!wm.perUser || wm.perUser.day !== today) wm.perUser = { day: today, counts: {} }
    const capPerUserRaw = Number(eg.maxPerUserPerDay ?? 5)
    const capPerUser = capPerUserRaw > 0 ? capPerUserRaw : Infinity
    const selfUid = String(secUid || '')
    const news = []
    for (const v of videos) {
      const cj = parseFeedJson(runPy(['comments', '--vid', v.vid], cfg))
      const rows = cj.comments || []
      // 线程表：一级评论 cid → 它下面所有子回复（按时间正序）。
      // 光有"最新那句"不够 —— 她会把一级评论当成一个没人理过的新问题重答一遍（10-26 实锤：
      // 昨天 21:53 已经答过「蟹黄饭好吃吗」，今早 11:46 又答了一次）。所以要把整串对话一起给她。
      const byParent = new Map()
      for (const r of rows) {
        if (!r.is_reply || !r.parent_cid) continue
        if (!byParent.has(r.parent_cid)) byParent.set(r.parent_cid, [])
        byParent.get(r.parent_cid).push(r)
      }
      for (const arr of byParent.values()) arr.sort((a, b) => Number(a.create_time || 0) - Number(b.create_time || 0))
      // 她已经在这些串里答过话了 → 串里的一级评论不再是"待回"，只当上下文
      const answeredParents = new Set()
      for (const [pid, arr] of byParent) {
        if (arr.some((r) => selfUid && String(r.user_sec_uid || '') === selfUid)) answeredParents.add(pid)
      }
      const selfSeenText = new Set()   // 她自己的回复原文，用于旧水位兼容（见下）
      for (const r of rows) {
        const meTxt = String(r.text || '').trim()
        if (meTxt && selfUid && String(r.user_sec_uid || '') === selfUid) selfSeenText.add(meTxt)
      }
      for (const c of rows) {
        // 10-27：以前这里是 `if (!c.text) continue` —— 纯表情包评论 text 是空串，整条被丢掉，
        // 所以主人只看到"她回了我的话，别人的表情包评论一条都没理"。现在按类型判，什么都能回。
        if (selfUid && String(c.user_sec_uid || '') === selfUid) continue   // 自己的回复不是"待办"
        const k = classifyComment({ text: c.text, sticker: c.sticker, hasSticker: c.has_sticker, pictures: c.images })
        if (!replyable(k.kind)) continue
        const isReply = !!c.is_reply
        // 一级评论：这串她已经答过 → 跳过（否则就是"同一个问题被答第二遍"）
        if (!isReply && answeredParents.has(String(c.cid))) continue
        // 她自己记的「回过这条」台账（10-27）：表情包评论回完以后，接口可能把她的回复报成一级评论，
        // 光看 answeredParents 会漏 → 再答一遍。这条台账不依赖接口形状。
        if (!isReply && wm.repliedTo && wm.repliedTo[String(c.cid)]) continue
        // 水位双键（10-26）：旧的 seen 里是 `vid:用户:文本前24字`，新的是 `vid:cid`。
        // 只认新键的话，迁移那一刻所有老评论都会被当成新评论重答一遍（11:46 那次重答就是这么来的）。
        // 两个键都查、都记：代码怎么升级都不会把处理过的东西再翻出来。
        // 10-27：没有文字的评论不参与 textKey（空串会互相撞），只用 cid + 用户+时间兜底。
        const hasText = Boolean(String(c.text || '').trim())
        const textKey = hasText ? v.vid + ':' + String(c.user || '') + ':' + String(c.text || '').slice(0, 24) : ''
        const cidKey = v.vid + ':' + (c.cid || textKey || `${c.user || ''}@${c.create_time || ''}`)
        if (wm.seen.includes(cidKey) || (textKey && wm.seen.includes(textKey)) || (hasText && selfSeenText.has(String(c.text || '').trim()))) continue
        // 10-27 的第二个真凶：以前扫到就 `wm.seen.push(cidKey)` —— 哪怕她**没回**也记成"处理过了"。
        // 于是一轮只处理 10 条时，第 11 条以后的评论被永久静音（主人看到的就是"只回了我，
        // 别人的全没回"）。现在只有真回过才落 seen；没回的先记 tried，最多试 3 次、每次隔 20 分钟。
        const tried = (wm.tried || {})[cidKey]
        if (tried && (Number(tried.n || 0) >= 3 || Date.now() - Number(tried.ts || 0) < 20 * 60_000)) continue
        const thread = isReply
          ? rows.filter((r) => String(r.cid) === String(c.parent_cid) || String(r.parent_cid) === String(c.parent_cid))
          : []
        news.push({
          vid: v.vid, vdesc: v.desc, user: c.user, text: c.text || '', label: k.label, kind: k.kind,
          cid: c.cid || '', isReply, parentCid: c.parent_cid || '', key: cidKey, textKey,
          index: rows.indexOf(c) + 1,
          thread: thread.map((r) => ({
            user: r.user, text: r.text || '', label: classifyComment({ text: r.text, sticker: r.sticker, hasSticker: r.has_sticker, pictures: r.images }).label,
            isMine: !!selfUid && String(r.user_sec_uid || '') === selfUid,
            isReply: !!r.is_reply,
          })),
        })
      }
    }
    wm.seen = wm.seen.slice(-500)
    fs.mkdirSync(path.dirname(WM), { recursive: true })
    // ⚠️ 干跑不写水位（10-25 测试发现的坑）：以前一跑 --dry 就把这些评论标成"已见"，
    // 等真跑时它们全被跳过 —— 测试等于把待办清零。
    if (!dry) fs.writeFileSync(WM, JSON.stringify(wm))
    if (!news.length) { console.log('评论区没有新评论。'); return }
    // dailyMax=0 = 不限（以前会被 slice(0,0) 直接清空 —— 配置成 0 就永远回不了）
    const capRaw = Number(eg.dailyMax ?? 3)
    const cap = capRaw > 0 ? capRaw : Infinity
    console.log(`新评论 ${news.length} 条（最多回 ${cap === Infinity ? '不限' : cap} 条）：`)
    for (const n of news) {
      const tag = n.kind === 'text' ? '' : ` 〔${n.kind === 'sticker' ? '表情包' : n.kind === 'image' ? '图片' : n.kind === 'emote' ? '只有表情' : '空'}〕`
      console.log('  ·', n.user, n.isReply ? '（接上一轮）' : '', '：', (n.label || n.text).slice(0, 40), tag)
      if (n.thread && n.thread.length) {
        console.log('      串：', n.thread.map((t) => (t.isMine ? '你' : t.user) + '「' + String(t.label || t.text).slice(0, 16) + '」').join(' → '))
      }
    }
    // ③④ LLM 判断 + 执行（异步段）
    ;(async () => {
      const { chat } = await import('../lib/llm.mjs')
      const { buildMessages } = await import('../lib/persona.mjs')
      const built = buildMessages({ platform: 'douyin', userText: '', chatId: 'douyin:engage-self', userId: 'self' })
      const renderThread = (n) => {
        if (!n.thread || !n.thread.length) return ''
        const parts = n.thread.map((t) => {
          const who = t.isMine ? '你' : (t.user || '对方')
          return `${who}「${String(t.label || t.text || '').replace(/\s+/g, ' ').slice(0, 40)}」`
        })
        return '\n   └ 这串已经聊到：' + parts.join(' → ')
      }
      const list = news.slice(0, 15).map((n, i) => `${i + 1}. [${n.vdesc.slice(0, 12)}] ${n.user}${n.isReply ? '（接你上一轮说的）' : ''}：${String(n.label || n.text).slice(0, 50)}${renderThread(n)}`).join('\n')
      const msgs = [
        built[0],
        { role: 'user', content: '【运营】这是你自己抖音作品评论区的新评论。你自己判断：哪几条值得回（提问/夸奖/有意思的接梗；杠精和广告不理）；回复要像作者本人：短、自然、有点自己的态度，别客服腔。'
          + '\n注意这是**连续的对话**，不是一堆孤立的新问题：带「这串已经聊到」的行，说明你和他已经来回聊过几轮 —— '
          + '接着他这句往下聊，**别把整串重新回答一遍**（那是重复），也别重复你已经说过的句子；聊干了就 {"replies":[]} 不接，别硬凑。'
          + '\n**评论不只有文字**：写着「（发了张表情包…）」「（发了 N 张图）」「只有 [微笑] 这种表情」的，就是对方用图和表情跟你说话 —— '
          + '这种更要回（人家专门挑图给你看）：顺着表情/图片接一句就行（"这个表情包我收下了""图糊了但我懂了"），别问"你想说什么"。'
          + `\n最多回 ${cap === Infinity ? '不限（但别硬凑，能接的才回）' : cap} 条。只输出 JSON：{"replies":[{"index":序号,"text":"回复内容"}]}，都不想回就 {"replies":[]}\n${list}` },
      ]
      let plan = { replies: [] }
      try {
        const resp = await chat(msgs, { temperature: 0.9, max_tokens: 400 })
        const m2 = String(resp).match(/\{[\s\S]*\}/)
        if (m2) plan = JSON.parse(m2[0])
      } catch (e) { console.log('LLM 决策失败：' + e.message) }
      let done = 0
      // 10-27：LLM 有时候对"只有表情包"的评论憋不出话 → 用兜底话术，保证**任何类型都回得上**。
      // 主人要求的是"别人的评论也要有反应"，不是"只有文字评论才算评论"。
      const fallbackFor = (n, seed) => (n.kind !== 'text' ? stickerFallback(n.label, seed) : '')
      const planned = new Map()
      for (const r of (plan.replies || [])) {
        const n = news[Number(r.index) - 1]
        if (!n) continue
        const t = String(r.text || '').replace(/\[[^\]]{1,8}\]/g, '').trim().slice(0, 60)
        if (t) planned.set(Number(r.index) - 1, t)
      }
      // 没被 LLM 选中的非文字评论，也要补上（表情包/图片评论必须有人理）
      for (const [i, n] of news.entries()) {
        if (planned.has(i) || n.kind === 'text') continue
        planned.set(i, fallbackFor(n, i))
      }
      const order = [...planned.keys()].sort((a, b) => a - b).slice(0, cap === Infinity ? undefined : cap)
      for (const idx of order) {
        const n = news[idx]
        let replyText = planned.get(idx) || fallbackFor(n, idx)
        if (!replyText) continue
        // 每人每天上限：能接着聊，但不至于追着同一个人刷屏
        const uKey = String(n.user || '匿名').slice(0, 40)
        const used = Number(wm.perUser.counts[uKey] || 0)
        if (used >= capPerUser) {
          console.log(`  ⏭ 今天已经回过「${uKey}」${used} 次（douyin.engage.maxPerUserPerDay=${capPerUserRaw}），这条先放着`)
          continue
        }
        console.log(`  ↩ 回 ${n.user}${n.isReply ? '（接着上一轮）' : ''}：${replyText}`)
        // 10-27：回复也不一定只用文字 —— 按配置概率挑「表情包图 / 官方表情 / 文字」。
        // 注意：图片和官方表情只能走 UI 那条路（comment-reply），`reply --cid` 是接口直发、吃不了图。
        const style = cfg.comment?.styles?.auto === false
          ? 'text'
          : chooseKind({ platform: 'douyin', styles: cfg.comment?.styles || {} })
        const styleImage = (style === 'sticker' || style === 'image') ? pickCommentImage({ platform: 'douyin', tag: autoTag(replyText) }) : ''
        const styleEmojiPack = style === 'emoji-pack' ? -1 : 0
        const useUi = n.isReply || !n.cid || Boolean(styleImage) || Boolean(styleEmojiPack)
        if (style !== 'text') console.log(`      〔用「${describeKind(style)}」发〕`)
        replyText = decorateText(replyText, {
          emojiChance: Number(cfg.comment?.styles?.emoji ?? 0.15),
          kaomojiChance: Number(cfg.comment?.styles?.kaomoji ?? 0.15),
        })
        if (dry) { console.log('  【干跑 ✓】'); continue }
        try {
          // 有 cid 就走 cid 精确回复；子回复（isReply）走文本定位 —— 页面上那条回复是嵌在父评论里的，
          // 只有文本定位能点到它自己的「回复」按钮，publish 才会带 reply_to_reply_id（对方才收得到通知）。
          // ⚠️ 注意 match 文本要剥掉 `[微笑]` 这类占位：接口返回的是文字占位，网页上是真 emoji，
          // 不剥就必然「没找到匹配的评论」（10-26 实测踩到）。
          // 10-27：纯表情包评论没有文本可 match —— 改成按**昵称**定位（`--user`），再不行用序号兜底。
          const matchKey = String(n.text || '').replace(/\[[^\]]{1,8}\]/g, '').trim().slice(0, 18) || String(n.text || '').slice(0, 18)
          const byNick = !matchKey
          const args = byNick
            ? ['comment-reply', '--vid', n.vid, '--user', String(n.user || ''), '--index', String(n.index || 0), '--text', replyText, '--go']
            : ['comment-reply', '--vid', n.vid, '--match', matchKey, '--user', String(n.user || ''), '--index', String(n.index || 0), '--text', replyText, '--go']
          // 10-27：带图/带官方表情只能走 UI 这条路（接口直发的 reply 吃不了图）
          if (styleImage) args.push('--image', styleImage)
          if (styleEmojiPack) args.push('--emoji-pack', String(styleEmojiPack))
          const out = useUi
            ? runPy(args, cfg, { soft: true })
            : runPy(['reply', '--vid', n.vid, '--cid', n.cid, '--message', replyText, '--go'], cfg, { soft: true })
          console.log(out)
          // 自己记一笔「这条我回过了」（10-27 实测补的）：抖音的 comments[] 有时把子回复也当一级返回
          // （parent_cid 是空的，reply_total 只加不降），光靠 answeredParents 判断不出来 ——
          // 于是表情包评论会被当成"还没回"再答一遍。落盘记 cid 最靠谱。
          wm.repliedTo = wm.repliedTo && typeof wm.repliedTo === 'object' ? wm.repliedTo : {}
          if (n.cid) wm.repliedTo[String(n.cid)] = Date.now()
          // 真回过的才落 seen（10-27）：没回的下次还能被看见，不会因为"这轮没轮到你"就永久静音
          if (n.key && !wm.seen.includes(n.key)) wm.seen.push(n.key)
          if (n.textKey && !wm.seen.includes(n.textKey)) wm.seen.push(n.textKey)
          if (wm.tried) delete wm.tried[n.key]
          wm.seen = wm.seen.slice(-500)
          memory.remember('douyin', `douyin:${n.vid}`, n.user, 'assistant', `（回复了 ${n.user} 的评论「${String(n.label || n.text).slice(0, 30)}」：${replyText}）`)
          wm.perUser.counts[uKey] = used + 1
          try { fs.writeFileSync(WM, JSON.stringify(wm)) } catch {}   // 每人每天的次数要落盘，不然重启就清零
          done++
          await new Promise((r2) => setTimeout(r2, 60000 + Math.random() * 60000))   // 回复间隔 1~2 分钟防风控
        } catch (e) {
          console.log('  ✗ 回复失败：' + String(e.message).slice(0, 80))
          // 失败记一次 tried（10-27）：以前是把 seen 退回去，现在 seen 只在成功时才写，
          // 所以只要递增次数即可 —— 试满 3 次或 20 分钟内不重复撞同一条。
          wm.tried = wm.tried && typeof wm.tried === 'object' ? wm.tried : {}
          const t0 = wm.tried[n.key] || { n: 0 }
          wm.tried[n.key] = { n: Number(t0.n || 0) + 1, ts: Date.now() }
          try { fs.writeFileSync(WM, JSON.stringify(wm)) } catch {}
        }
      }
      // 没轮到/没被选中的：记一次 tried，避免下一轮又来问一遍（试满 3 次自然退场）
      if (!dry) {
        wm.tried = wm.tried && typeof wm.tried === 'object' ? wm.tried : {}
        for (const [i, n] of news.entries()) {
          if (order.includes(i) || !n.key) continue
          const t0 = wm.tried[n.key] || { n: 0 }
          wm.tried[n.key] = { n: Number(t0.n || 0) + 1, ts: Date.now() }
        }
        try { fs.writeFileSync(WM, JSON.stringify(wm)) } catch {}
      }
      console.log(`回复了 ${done} 条。`)
    })()
    return
  }

  if (cmd === 'login') {
    console.log('打开抖音网页版扫码登录（会弹 Chrome 窗口，扫码后点「确认登录」）...')
    console.log(runPy(['login'], cfg))
    return
  }
  if (cmd === 'feed') {
    const headed = argv.includes('--headed') ? '--headed' : ''
    const out = runPy(['feed', '--scrolls', '8', ...(headed ? ['--headed'] : [])], cfg)
    const data = parseFeedJson(out)
    // 10-27：把她真正刷到的视频落盘 —— "自己刷到的视频评论区也能发评论"要有 vid 来源，
    // 不能只靠当场 remember。feed 里已经带 author/desc/评论数，够 interact 挑题了。
    try {
      const f = dataPath('douyin-feed.json')
      fs.mkdirSync(path.dirname(f), { recursive: true })
      const prev = (() => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return { items: [] } } })()
      const items = (prev.items || []).slice(-400)
      for (const v of data.videos || []) {
        if (!v?.vid) continue
        items.push({ vid: String(v.vid), author: v.author || '', desc: (v.desc || '').slice(0, 200), ts: Date.now() })
      }
      // 同一个 vid 只留最新一次
      const seen = new Set()
      const dedup = []
      for (const it of items.reverse()) { if (seen.has(it.vid)) continue; seen.add(it.vid); dedup.push(it) }
      fs.writeFileSync(f, JSON.stringify({ items: dedup.slice(0, 400) }))
      console.log(`（已记录到 douyin-feed.json，共 ${dedup.length} 个刷到过的视频）`)
    } catch (e) { console.log('（feed 落盘失败：' + e.message + '）') }
    console.log(`采集到 ${data.videos?.length ?? 0} 个视频：`)
    for (const v of (data.videos || []).slice(0, 15)) {
      console.log(`  ${v.vid}  ${v.author}：${(v.desc || '').slice(0, 50)}  [评论${v.comment_count}/赞${v.digg_count}]`)
    }
    return
  }
  if (cmd === 'my-videos') {
    // 默认扫**自己**（顾思苡）的投稿；要扫主人的号就加 --owner
    const secUid = arg(argv, '--sec-uid')
      || (argv.includes('--owner') ? String(cfg.douyin?.owner?.sec_uid || '') : selfSecUid(cfg))
    if (!secUid) { console.error('✗ 读不到 sec_uid：node feiyu.mjs douyin self 刷一下'); process.exit(2) }
    const headed = argv.includes('--headed') ? ['--headed'] : []
    console.log(runPy(['my-videos', '--sec-uid', secUid, ...headed], cfg))
    return
  }
  if (cmd === 'comments') {
    const vid = arg(argv, '--vid')
    if (!vid) { console.error('用法：node feiyu.mjs douyin comments --vid <视频id> [--headed]'); process.exit(2) }
    // 默认无头（快）；要肉眼看就加 --headed
    const headed = argv.includes('--headed') ? ['--headed'] : []
    console.log(runPy(['comments', '--vid', vid, ...headed], cfg))
    return
  }
  if (cmd === 'cdp-start') {
    console.log(runPy(['cdp-start'], cfg))
    return
  }
  if (cmd === 'comment') {
    const vid = arg(argv, '--vid')
    let message = arg(argv, '--message')
    const wantImage = arg(argv, '--image')          // 显式指定图片/表情包文件
    let image = ''
    let emojiPack = Number(arg(argv, '--emoji-pack') || 0)
    // 10-27：评论类型不再只有文字 —— 不指定就按配置概率自己挑（文字/表情包/官方表情/图片）
    if (!wantImage && !emojiPack && cfg.comment?.styles?.auto !== false) {
      const kind = chooseKind({ platform: 'douyin', styles: cfg.comment?.styles || {} })
      if (kind === 'sticker' || kind === 'image') image = pickCommentImage({ platform: 'douyin', tag: autoTag(message) })
      else if (kind === 'emoji-pack') emojiPack = -1
      // kind==='voice' → 评论里发不了语音（网页端没有录音控件），退回文字
      if (kind !== 'text') console.log(`  〔这次用「${describeKind(kind)}」发〕`)
    }
    if (wantImage) image = wantImage
    if (!vid || (!message && !image && !emojiPack)) {
      console.error('用法：node feiyu.mjs douyin comment --vid <id> --message "…" [--image 图] [--emoji-pack -1] [--go] [--cdp]'); process.exit(2)
    }
    message = decorateText(message, {
      emojiChance: Number(cfg.comment?.styles?.emoji ?? 0.15),
      kaomojiChance: Number(cfg.comment?.styles?.kaomoji ?? 0.15),
    })
    const go = argv.includes('--go')
    const cdp = argv.includes('--cdp')
    const atUser = cfg.douyin?.atMention === true ? (cfg.douyin?.owner?.name || '') : ''   // 真 @ 目标（弹通知）
    const dry = douyinDry(cfg) || !go   // 抖音独立 DRY，或未显式 --go 都拦
    const tag = [image ? ` [图:${path.basename(image)}]` : '', emojiPack ? ' [官方表情]' : ''].join('')
    if (dry) {
      console.log(`【干跑 ✓】不真发评论 → ${vid}\n  内容：${atUser ? '@' + atUser + ' ' : ''}${message}${tag}`)
      return
    }
    const args = ['comment', '--vid', vid, '--message', message]
    if (image) args.push('--image', image)
    if (emojiPack) args.push('--emoji-pack', String(emojiPack))
    if (atUser) args.push('--at', atUser)
    args.push('--go', ...(cdp ? ['--cdp'] : []))
    console.log(runPy(args, cfg))
    return
  }
  if (cmd === 'reply') {
    const vid = arg(argv, '--vid')
    const cid = arg(argv, '--cid')
    const message = arg(argv, '--message')
    if (!vid || !cid || !message) { console.error('用法：node feiyu.mjs douyin reply --vid <id> --cid <评论cid> --message "…" [--go] [--cdp]'); process.exit(2) }
    const go = argv.includes('--go')
    const cdp = argv.includes('--cdp')
    // 回复某条评论时 @ 的应该是**评论者**，不是主人自己（以前照搬 comment 的逻辑会 @ 主人，很怪）
    const atUser = cfg.douyin?.atMention === true ? arg(argv, '--at') : ''
    const dry = douyinDry(cfg) || !go
    if (dry) {
      console.log(`【干跑 ✓】不真回复 cid=${cid} → ${atUser ? '@' + atUser + ' ' : ''}${message}`)
      return
    }
    const args = ['reply', '--vid', vid, '--cid', cid, '--message', message]
    if (atUser) args.push('--at', atUser)
    args.push('--go', ...(cdp ? ['--cdp'] : []))
    console.log(runPy(args, cfg))
    return
  }
  if (cmd === 'dm' || cmd === 'dm-send') {
    const message = arg(argv, '--message')
    const file = arg(argv, '--file')                // 图片/gif/mp4（语音条走 mp4）
    const secUid = arg(argv, '--sec-uid') || (cfg.douyin?.owner?.sec_uid || '')
    const name = arg(argv, '--to') || arg(argv, '--name') || (cfg.douyin?.owner?.name || '')
    if ((!message && !file) || !secUid) { console.error('用法：node feiyu.mjs douyin dm --sec-uid <sec_uid> --message "…" [--file 图/视频] [--go] [--cdp]'); process.exit(2) }
    const go = argv.includes('--go')
    const cdp = argv.includes('--cdp')
    const dry = douyinDry(cfg) || !go
    if (dry) { console.log(`【干跑 ✓】不真发私信 → ${name || secUid}\n  内容：${message}${file ? ` [文件:${path.basename(file)}]` : ''}`); return }
    const args = ['dm-send', '--sec-uid', secUid, '--name', name, '--message', message || '']
    if (file) args.push('--file', file)
    args.push('--go', ...(cdp ? ['--cdp'] : []))
    console.log(runPy(args, cfg))
    return
  }
  // 语音条（10-27）：抖音网页版评论区/私信都**没有录音控件**（实测两次：评论框只有 1 个图 input +
  // 表情面板；私信 input 只吃 jpg/png/gif/mp4）。所以"发语音"落地成：用她的声音合成 → 封面+音轨做成
  // 竖屏 mp4 → 私信发过去。对方点开就是她的原声，等于语音条。
  //   node feiyu.mjs douyin voice-note --sec-uid <sec_uid> --text "…" [--cover 图] [--go]
  if (cmd === 'voice-note' || cmd === 'voice') {
    const text = arg(argv, '--text') || arg(argv, '--message')
    const secUid = arg(argv, '--sec-uid') || (cfg.douyin?.owner?.sec_uid || '')
    const name = arg(argv, '--to') || (cfg.douyin?.owner?.name || '')
    if (!text || !secUid) { console.error('用法：node feiyu.mjs douyin voice-note --sec-uid <sec_uid> --text "…" [--cover 图] [--go]'); process.exit(2) }
    const go = argv.includes('--go')
    const dry = douyinDry(cfg) || !go
    if (dry) { console.log(`【干跑 ✓】不合成不发：会把「${text.slice(0, 30)}」合成语音条发给 ${name || secUid}`); return }
    return (async () => {
      const work = dataPath('voice-notes')
      fs.mkdirSync(work, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const wav = path.join(work, `${stamp}.wav`)
      const mp4 = path.join(work, `${stamp}.mp4`)
      const cover = arg(argv, '--cover') || path.join(work, 'cover.jpg')
      const { synth } = await import('../lib/tts.mjs')
      console.log('  合成语音…')
      await synth(text, wav)
      const ff = cfg.rvc?.ffmpeg || 'D:/GPT-SoVITS/runtime/ffmpeg.exe'
      const { execFileSync } = await import('node:child_process')
      // 封面：没有就现造一张竖屏纯色底（抖音私信预览用）
      if (!fs.existsSync(cover)) {
        execFileSync(ff, ['-y', '-f', 'lavfi', '-i', 'color=c=0x1b2430:s=720x1280:d=1', '-frames:v', '1', cover], { stdio: 'ignore' })
      }
      const { voiceNoteArgs } = await import('../lib/reply-style.mjs')
      execFileSync(ff, voiceNoteArgs({ audioPath: wav, coverPath: cover, outPath: mp4 }), { stdio: 'ignore' })
      console.log(`  语音条：${mp4}（${Math.round(fs.statSync(mp4).size / 1024)} KB）`)
      console.log(runPy(['dm-send', '--sec-uid', secUid, '--name', name, '--message', '', '--file', mp4, '--go'], cfg))
    })()
  }
  if (cmd === 'dm-read') {
    const secUid = arg(argv, '--sec-uid') || (cfg.douyin?.owner?.sec_uid || '')
    const name = arg(argv, '--name') || (cfg.douyin?.owner?.name || '')
    if (!secUid) { console.error('需要 --sec-uid 或配置 douyin.owner.sec_uid'); process.exit(2) }
    console.log(runPy(['dm-read', '--sec-uid', secUid, '--name', name], cfg))
    return
  }
  if (cmd === 'card-open') {
    // 点开私信里最新一张分享卡片：拿 aweme_id + 标题/作者 + 逐帧截图（她"看懂分享的视频"靠这个）
    const secUid = arg(argv, '--sec-uid') || (cfg.douyin?.owner?.sec_uid || '')
    const name = arg(argv, '--name') || (cfg.douyin?.owner?.name || '')
    const out = arg(argv, '--out') || path.join(os.tmpdir(), 'feiyu-card-' + Date.now())
    const n = arg(argv, '--n') || '4'
    if (!secUid) { console.error('需要 --sec-uid 或配置 douyin.owner.sec_uid'); process.exit(2) }
    const expect = arg(argv, '--expect') || ''
    console.log(runPy(['card-open', '--sec-uid', secUid, '--name', name, '--out', out, '--n', String(n), ...(expect ? ['--expect', expect] : [])], cfg))
    return
  }
  if (cmd === 'interact') {
    return runInteract(cfg, { dry: argv.includes('--dry') })
  }
  console.log('用法：login | cdp-start | feed [--headed] | comments --vid | comment --vid --message "…" [--image 图] [--emoji-pack N] [--go --cdp] | comment-delete --vid --match "…" [--go] | reply --vid --cid --message [--go --cdp] | dm --sec-uid --message "…" [--file 图/视频] [--go --cdp] | voice-note --sec-uid --text "…" [--go] | dm-read --sec-uid | card-open --sec-uid [--out 目录 --n 4] | interact [--dry]')
}

// 全流程：feed → 口味过滤 → 读热评 → LLM 生成评论 → 干跑发评论
async function runInteract(cfg, { dry: forceDry = false } = {}) {
  const { chat } = await import('../lib/llm.mjs')
  const persona = await import('../lib/persona.mjs')

  console.log('[interact] ① 刷 feed 采集视频...')
  const feedOut = runPy(['feed', '--scrolls', '8', ...(forceDry ? [] : ['--headed'])], cfg)
  const feed = parseFeedJson(feedOut)
  let videos = (feed.videos || []).filter(v => v.desc && v.author).filter(v => matchPrefs(v, cfg))
  if (!videos.length) videos = (feed.videos || []).filter(v => v.desc && v.author)
  const rawPerRun = Number(cfg.douyin?.maxPerRun ?? 2)
  // 0 = 不限，但**硬上限 10**（10-25 实测：配 0 时一口气跑了 39 个视频 → 39 次浏览器 + 39 次 LLM，
  // 7 分钟跑完还全是 422 报错）。刷太多也是风控信号。
  const HARD_CAP = 10
  let perRun = rawPerRun === 0 ? HARD_CAP : Math.max(1, Math.min(HARD_CAP, rawPerRun || 2))
  console.log(`[interact] 口味过滤后剩 ${videos.length} 个候选，取前 ${perRun} 个（硬上限 ${HARD_CAP}，抖音风控严）`)

  const top = videos.slice(0, perRun)
  for (const v of top) {
    console.log(`\n[interact] ② 看视频《${v.desc.slice(0, 40)}》（${v.author}）`)
    memory.remember('douyin', `douyin:${v.vid}`, v.author, 'event', v.desc.slice(0, 120))
    const commentsOut = runPy(['comments', '--vid', v.vid, ...(forceDry ? [] : ['--headed'])], cfg)
    let hot = []
    try {
      const m = commentsOut.match(/\{[\s\S]*\}/)
      if (m) hot = (JSON.parse(m[0]).comments || []).filter(c => c.text).slice(0, 5).map(c => c.text)
    } catch { hot = [] }

    console.log('[interact] ③ LLM 生成评论...')
    const msgs = []
    const base = persona.buildMessages({ platform: 'douyin', userText: '', chatId: `douyin:${v.vid}`, turnsToday: 0 })
    msgs.push(...base.slice(0, -1)) // system + 记忆（去掉末尾空的 user 消息）
    msgs.push({
      role: 'user',
      content: `你要给下面这条抖音视频写一条评论（要像真人，简短自然，可以带点你这个角色的语气，不要长篇大论，15~40字）。\n\n视频作者：${v.author}\n视频文案：${v.desc}\n热评参考：${hot.join(' / ') || '（无）'}\n\n直接输出评论正文，不要引号、不要解释。`,
    })
    let comment = ''
    try {
      const resp = await chat(msgs, { temperature: 0.9 })
      comment = (resp?.content ?? resp ?? '').trim().replace(/^["“]|["”]$/g, '').slice(0, 60)
    } catch (e) {
      console.error('[interact] LLM 失败：' + e.message)
      continue
    }
    if (!comment) { console.log('  ✗ 评论为空，跳过'); continue }
    comment = sanitizeFor('douyin', comment)   // 抖音只认 emoji，剥掉 [xx] 与 [表情:x]
    if (!comment) { console.log('  ✗ 评论只剩表情标记，跳过'); continue }
    // 10-27：「刷到的别人的视频」下面也发任意类型 —— 文字/颜文字/emoji/表情包/图片/官方表情，
    // 跟自己作品那边一模一样的概率表（comment.styles）。语音评论平台没入口 → 退化成文字。
    const styles = cfg.comment?.styles || {}
    const kind = styles.auto === false ? 'text' : chooseKind({ platform: 'douyin', styles })
    let sendImage = ''
    let sendEmojiPack = 0
    if (kind === 'sticker' || kind === 'image') {
      sendImage = pickCommentImage({ platform: 'douyin', tag: autoTag(comment) })
      if (!sendImage) { console.log('  （表情包仓库里没有抖音能发的图 → 改发文字）') }
    } else if (kind === 'emoji-pack') {
      sendEmojiPack = -1
    } else if (kind === 'voice') {
      console.log('  （抖音网页评论区没有录音入口 → 这条语音退化成文字）')
    }
    comment = decorateText(comment, {
      emojiChance: Number(styles.emoji ?? 0.15),
      kaomojiChance: Number(styles.kaomoji ?? 0.15),
    })
    const kindNow = sendImage ? kind : sendEmojiPack ? 'emoji-pack' : 'text'
    if (kindNow !== 'text') console.log(`  〔这次用「${describeKind(kindNow)}」发〕`)
    // @ 目标：自己作品下 @ 主人是主人要的；**在别人的视频下 @ 主人就别扭了**（人家看不懂），
    // 要开就显式配 douyin.atMentionOnOthers: true。
    const atUser = (cfg.douyin?.atMentionOnOthers === true && cfg.douyin?.atMention === true) ? (cfg.douyin?.owner?.name || '') : ''
    const dry = forceDry || douyinDry(cfg)
    const extra = []
    if (sendImage) extra.push('--image', sendImage)
    if (sendEmojiPack) extra.push('--emoji-pack', String(sendEmojiPack))
    if (dry) {
      console.log(`  【干跑 ✓】${v.vid} → ${atUser ? '@' + atUser + ' ' : ''}${comment}${sendImage ? ` [图:${path.basename(sendImage)}]` : ''}`)
    } else {
      console.log(`  【真发 CDP】${v.vid} → ${atUser ? '@' + atUser + ' ' : ''}${comment}${sendImage ? ` [图:${path.basename(sendImage)}]` : ''}`)
      const args = ['comment', '--vid', v.vid, '--message', comment]
      if (atUser) args.push('--at', atUser)
      args.push(...extra)
      args.push('--go', '--cdp')
      console.log(runPy(args, cfg))
      // 风控：每条真发之间随机间隔 60~150 秒，避免连发被 shadowban
      const wait = 60 + Math.floor(Math.random() * 90)
      console.log(`  ⏳ 停 ${wait} 秒再发下一条（拟人节奏，躲风控）...`)
      await new Promise(r => setTimeout(r, wait * 1000))
    }
  }
  console.log('\n[interact] 完成。抖音独立 dryRun（douyin.dryRun）控制是否真发；真发前请确认 CDP Chrome(9222) 已开。')
}
