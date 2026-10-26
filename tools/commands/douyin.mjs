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
import { sanitizeFor } from '../lib/stickers.mjs'
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
        if (selfUid && String(r.user_sec_uid || '') === selfUid) selfSeenText.add(String(r.text || '').trim())
      }
      for (const c of rows) {
        if (!c.text) continue
        if (selfUid && String(c.user_sec_uid || '') === selfUid) continue   // 自己的回复不是"待办"
        const isReply = !!c.is_reply
        // 一级评论：这串她已经答过 → 跳过（否则就是"同一个问题被答第二遍"）
        if (!isReply && answeredParents.has(String(c.cid))) continue
        // 水位双键（10-26）：旧的 seen 里是 `vid:用户:文本前24字`，新的是 `vid:cid`。
        // 只认新键的话，迁移那一刻所有老评论都会被当成新评论重答一遍（11:46 那次重答就是这么来的）。
        // 两个键都查、都记：代码怎么升级都不会把处理过的东西再翻出来。
        const textKey = v.vid + ':' + String(c.user || '') + ':' + String(c.text || '').slice(0, 24)
        const cidKey = v.vid + ':' + (c.cid || textKey)
        if (wm.seen.includes(cidKey) || wm.seen.includes(textKey) || selfSeenText.has(String(c.text || '').trim())) continue
        const thread = isReply
          ? rows.filter((r) => String(r.cid) === String(c.parent_cid) || String(r.parent_cid) === String(c.parent_cid))
          : []
        news.push({
          vid: v.vid, vdesc: v.desc, user: c.user, text: c.text, cid: c.cid || '',
          isReply, parentCid: c.parent_cid || '', key: cidKey, textKey,
          thread: thread.map((r) => ({
            user: r.user, text: r.text,
            isMine: !!selfUid && String(r.user_sec_uid || '') === selfUid,
            isReply: !!r.is_reply,
          })),
        })
        wm.seen.push(cidKey, textKey)
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
      console.log('  ·', n.user, n.isReply ? '（接上一轮）' : '', '：', n.text.slice(0, 40))
      if (n.thread && n.thread.length) {
        console.log('      串：', n.thread.map((t) => (t.isMine ? '你' : t.user) + '「' + String(t.text).slice(0, 16) + '」').join(' → '))
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
          return `${who}「${String(t.text || '').replace(/\s+/g, ' ').slice(0, 40)}」`
        })
        return '\n   └ 这串已经聊到：' + parts.join(' → ')
      }
      const list = news.slice(0, 10).map((n, i) => `${i + 1}. [${n.vdesc.slice(0, 12)}] ${n.user}${n.isReply ? '（接你上一轮说的）' : ''}：${n.text.slice(0, 50)}${renderThread(n)}`).join('\n')
      const msgs = [
        built[0],
        { role: 'user', content: '【运营】这是你自己抖音作品评论区的新评论。你自己判断：哪几条值得回（提问/夸奖/有意思的接梗；杠精和广告不理）；回复要像作者本人：短、自然、有点自己的态度，别客服腔。'
          + '\n注意这是**连续的对话**，不是一堆孤立的新问题：带「这串已经聊到」的行，说明你和他已经来回聊过几轮 —— '
          + '接着他这句往下聊，**别把整串重新回答一遍**（那是重复），也别重复你已经说过的句子；聊干了就 {"replies":[]} 不接，别硬凑。'
          + `\n最多回 ${cap === Infinity ? '不限（但别硬凑，能接的才回）' : cap} 条。只输出 JSON：{"replies":[{"index":序号,"text":"回复内容"}]}，都不想回就 {"replies":[]}\n${list}` },
      ]
      let plan = { replies: [] }
      try {
        const resp = await chat(msgs, { temperature: 0.9, max_tokens: 400 })
        const m2 = String(resp).match(/\{[\s\S]*\}/)
        if (m2) plan = JSON.parse(m2[0])
      } catch (e) { console.log('LLM 决策失败：' + e.message) }
      let done = 0
      for (const r of (plan.replies || []).slice(0, cap === Infinity ? undefined : cap)) {
        const n = news[Number(r.index) - 1]
        if (!n || !String(r.text || '').trim()) continue
        const replyText = String(r.text).replace(/\[[^\]]{1,8}\]/g, '').trim().slice(0, 60)   // 抖音评论只认 emoji
        if (!replyText) continue
        // 每人每天上限：能接着聊，但不至于追着同一个人刷屏
        const uKey = String(n.user || '匿名').slice(0, 40)
        const used = Number(wm.perUser.counts[uKey] || 0)
        if (used >= capPerUser) {
          console.log(`  ⏭ 今天已经回过「${uKey}」${used} 次（douyin.engage.maxPerUserPerDay=${capPerUserRaw}），这条先放着`)
          continue
        }
        console.log(`  ↩ 回 ${n.user}${n.isReply ? '（接着上一轮）' : ''}：${replyText}`)
        if (dry) { console.log('  【干跑 ✓】'); continue }
        try {
          // 有 cid 就走 cid 精确回复；子回复（isReply）走文本定位 —— 页面上那条回复是嵌在父评论里的，
          // 只有文本定位能点到它自己的「回复」按钮，publish 才会带 reply_to_reply_id（对方才收得到通知）。
          // ⚠️ 注意 match 文本要剥掉 `[微笑]` 这类占位：接口返回的是文字占位，网页上是真 emoji，
          // 不剥就必然「没找到匹配的评论」（10-26 实测踩到）。
          const matchKey = String(n.text).replace(/\[[^\]]{1,8}\]/g, '').trim().slice(0, 18) || String(n.text).slice(0, 18)
          const out = n.isReply || !n.cid
            ? runPy(['comment-reply', '--vid', n.vid, '--match', matchKey, '--text', replyText, '--go'], cfg, { soft: true })
            : runPy(['reply', '--vid', n.vid, '--cid', n.cid, '--message', replyText, '--go'], cfg, { soft: true })
          console.log(out)
          memory.remember('douyin', `douyin:${n.vid}`, n.user, 'assistant', `（回复了 ${n.user} 的评论「${String(n.text).slice(0, 30)}」：${replyText}）`)
          wm.perUser.counts[uKey] = used + 1
          try { fs.writeFileSync(WM, JSON.stringify(wm)) } catch {}   // 每人每天的次数要落盘，不然重启就清零
          done++
          await new Promise((r2) => setTimeout(r2, 60000 + Math.random() * 60000))   // 回复间隔 1~2 分钟防风控
        } catch (e) {
          console.log('  ✗ 回复失败：' + String(e.message).slice(0, 80))
          // 失败必须把水位退回去（10-26）：水位在进异步段之前就落盘了，
          // 不退回的话这次失败 = 这条评论永远不再尝试（她再也不会回这个人）。
          wm.seen = wm.seen.filter((k) => k !== n.key && k !== n.textKey)
          try { fs.writeFileSync(WM, JSON.stringify(wm)) } catch {}
        }
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
    const message = arg(argv, '--message')
    if (!vid || !message) { console.error('用法：node feiyu.mjs douyin comment --vid <id> --message "…" [--go] [--cdp]'); process.exit(2) }
    const go = argv.includes('--go')
    const cdp = argv.includes('--cdp')
    const atUser = cfg.douyin?.atMention === true ? (cfg.douyin?.owner?.name || '') : ''   // 真 @ 目标（弹通知）
    const dry = douyinDry(cfg) || !go   // 抖音独立 DRY，或未显式 --go 都拦
    if (dry) {
      console.log(`【干跑 ✓】不真发评论 → ${vid}\n  内容：${atUser ? '@' + atUser + ' ' : ''}${message}`)
      return
    }
    const args = ['comment', '--vid', vid, '--message', message]
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
    const secUid = arg(argv, '--sec-uid') || (cfg.douyin?.owner?.sec_uid || '')
    const name = arg(argv, '--to') || arg(argv, '--name') || (cfg.douyin?.owner?.name || '')
    if (!message || !secUid) { console.error('用法：node feiyu.mjs douyin dm --sec-uid <sec_uid> --message "…" [--go] [--cdp]'); process.exit(2) }
    const go = argv.includes('--go')
    const cdp = argv.includes('--cdp')
    const dry = douyinDry(cfg) || !go
    if (dry) { console.log(`【干跑 ✓】不真发私信 → ${name || secUid}\n  内容：${message}`); return }
    const args = ['dm-send', '--sec-uid', secUid, '--name', name, '--message', message]
    args.push('--go', ...(cdp ? ['--cdp'] : []))
    console.log(runPy(args, cfg))
    return
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
  console.log('用法：login | cdp-start | feed [--headed] | comments --vid | comment --vid --message [--go --cdp] | reply --vid --cid --message [--go --cdp] | dm --sec-uid --message [--go --cdp] | dm-read --sec-uid | card-open --sec-uid [--out 目录 --n 4] | interact')
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
    const atUser = cfg.douyin?.atMention === true ? (cfg.douyin?.owner?.name || '') : ''   // 真 @ 目标
    const dry = forceDry || douyinDry(cfg)
    if (dry) {
      console.log(`  【干跑 ✓】${v.vid} → ${atUser ? '@' + atUser + ' ' : ''}${comment}`)
    } else {
      console.log(`  【真发 CDP】${v.vid} → ${atUser ? '@' + atUser + ' ' : ''}${comment}`)
      const args = ['comment', '--vid', v.vid, '--message', comment]
      if (atUser) args.push('--at', atUser)
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
