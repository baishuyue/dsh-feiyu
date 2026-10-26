// douyin-dm-server —— 抖音私信陪聊（参照 qq-server 的常驻模式，但收发走抖音网页私信）。
// 轮询：dm-read 读主人会话 → 只挑主人的新消息 → LLM 回 → dm-send 发出。
// 复用 guard（去重/清洗）、persona、记忆、llm，省掉一套独立逻辑。
//
//   node feiyu.mjs douyin-dm-server [--port 8095]
//
// 两条铁律（都是踩过坑的）：
//   · 只有发送成功才进水位 —— 发送失败下一轮自动重试同一条，绝不静默丢回复。
//   · 对话要 remember 进记忆 —— 否则 buildMessages 没有上下文，主人接着聊就接不上。
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { config } from '../lib/config.mjs'
import * as persona from '../lib/persona.mjs'
import * as llm from '../lib/llm.mjs'
import * as guard from '../lib/guard.mjs'
import * as memory from '../lib/memory.mjs'
import * as qqMemory from '../lib/qq-memory.mjs'
import { dataPath } from '../lib/paths.mjs'
import { gapText, mentionsDays, sanitizeDayClaims } from '../lib/timefix.mjs'
import { looksBlind, looksAsking, askInstead, noBlindHint } from '../lib/speechfix.mjs'

const WM_FILE = dataPath('douyin-dm-watermark.json')
const CHAT_ID = 'douyin-dm:owner'

function arg(argv, name, d) { const i = argv.indexOf(name); return i >= 0 ? (argv[i + 1] ?? d) : d }

// 必须异步：execFileSync 会把事件循环钉住 40~180 秒 —— 期间 /health 不通、
// 主人点"停止"也没反应，而且慢轮次会和下一轮 setInterval 叠在一起（重复回复的隐患）。
const execFileAsync = promisify(execFile)
async function runPy(args, cfg) {
  const cmd = [cfg.douyin?.script || 'D:/social-auto-upload/douyin_interact.py', ...args,
    '--cookie', cfg.douyin?.cookie || dataPath('douyin-cookies.json')]
  const { stdout } = await execFileAsync(cfg.douyin?.python || 'D:/social-auto-upload/.venv/Scripts/python.exe', cmd,
    { encoding: 'utf8', timeout: 180000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 })
  return stdout
}
function jsonOf(out) { const m = String(out).match(/\{[\s\S]*\}/); if (!m) return null; try { return JSON.parse(m[0]) } catch { return null } }

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return d } }

// 宿主 stdio:ignore 起进程，不打文件日志等于瞎 —— 出问题只能靠猜
const LOG = dataPath('douyin-dm.log')
const log = (...a) => { const m = a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '); try { console.log(m) } catch {}; try { fs.appendFileSync(LOG, `${new Date().toISOString()} ${m}\n`) } catch {} }
const writeJson = (f, v) => { try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v)) } catch {} }

const norm = (s) => String(s || '').replace(/\s+/g, '').slice(0, 60)

// 主人最后一条抖音私信的时间（从记忆尾部读）——"多久没说话"的唯一可信来源
function lastOwnerMsgTsDouyin() {
  try {
    const rows = fs.readFileSync(dataPath('episodes.jsonl'), 'utf8').trim().split('\n')
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = JSON.parse(rows[i])
      if (r && r.platform === 'douyin' && r.role === 'user') return Number(r.ts) || 0
    }
  } catch {}
  return 0
}

/** 报错取真因：python 的 log() 打到 stdout；stderr 开头是 patchright 驱动的 Node 弃用警告（几百字），
 *  真正的 Traceback 在尾部 —— 只看 stderr 会把真错全切掉（"Command failed"下面一片空白就是这么来的）。 */
function errTail(e) {
  const clean = (s) => String(s || '').split(/\r?\n/).filter((l) => !/DeprecationWarning|CVEs are not issued|In addition, the behavior|trace-deprecation/.test(l)).join('\n').trim()
  const real = [clean(e && e.stdout), clean(e && e.stderr)].filter(Boolean).join(' | ')
  return (real || String((e && e.message) || e || '')).slice(-600)
}

export async function run(argv = []) {
  const cfg = config()
  const ownerName = String(cfg.douyin?.owner?.name || '').trim()
  const secUid = String(cfg.douyin?.owner?.sec_uid || '').trim()
  if (!secUid) { log('[douyin-dm] 未配置 douyin.owner.sec_uid，无法陪聊'); process.exit(1) }
  const ownerKey = ownerName || 'owner'
  const pollSec = Number(cfg.douyin?.dm?.pollSec || 300)
  const dry = cfg.douyin?.dryRun !== false
  const silent = cfg.douyin?.watch?.silent === true || cfg.douyin?.dm?.headless === true

  // 水位：已处理过的主人消息（文本指纹）。dm-read 的消息没有时间戳/ID，只能按文本去重；
  // 同一句话发两遍会被当成一条 —— 跟主人聊天够用，别过度设计。
  // 首次运行（没有水位文件）先把现有消息全部当基线，从"下一条"开始陪聊 ——
  // 否则第一次启动会拿着几个月前的旧卡片煞有介事地回一句。
  const wmExisted = fs.existsSync(WM_FILE)
  let seeded = wmExisted
  let handled = readJson(WM_FILE, { handled: [] }).handled || []
  const commitHandled = (key) => {
    handled.push(key)
    if (handled.length > 200) handled = handled.slice(-200)
    writeJson(WM_FILE, { handled })
  }
  let failStreak = 0

  // 长期记忆（10-25 对齐 QQ）：每 6 轮回复把这段对话压成摘要 + 更新主人画像（不阻塞回复）。
  // 画像跨通道共用一份（~/.feiyu-ai/qq/owner-profile.md）—— 主人是同一个人，QQ 和抖音私信对他的认知不分家。
  function maintainLongMemory() {
    try {
      qqMemory.bump(CHAT_ID)
      if (qqMemory.due(CHAT_ID)) {
        qqMemory.refresh({ chatId: CHAT_ID, owner: config().owner, chat: (m) => llm.chat(m) })
          .then((ok) => { if (ok) log('[douyin-dm] 记忆已压缩（摘要 + 主人画像）') })
          .catch((e) => log('[douyin-dm] 记忆压缩失败：' + (e?.message ?? e)))
      }
    } catch (e) { log('[douyin-dm] 记忆维护异常：' + (e?.message ?? e)) }
  }

  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/health') {
      res.end(JSON.stringify({ ok: true, owner: ownerName, dry, pollSec, handled: handled.length, failStreak, ticking, lastTickAt }))
      return
    }
    res.end(JSON.stringify({ ok: true }))
  })
  // 默认 8095：8090 常被 Wondershare 推送组件（WsToastNotification.exe）占着，绑不上
  const port = Number(arg(argv, '--port', cfg.douyin?.dm?.port || 8095))
  // 端口被占（已有一个实例在跑）→ 安静退出，别在日志里留一堆无解的 EADDRINUSE
  server.on('error', (e) => {
    if (e && e.code === 'EADDRINUSE') { log(`[douyin-dm] 端口 ${port} 已被占用（大概率已有一个实例在跑），本实例退出`); process.exit(0) }
    log('[douyin-dm] 服务错误：' + (e?.message ?? e))
  })
  server.listen(port, '127.0.0.1', () => log(`[douyin-dm] 监听 http://127.0.0.1:${port}/health · 每 ${pollSec}s 轮询主人私信 · dry=${dry} · silent=${silent}`))

  // 单轮互斥：一轮（读 40~60s + 生成 + 发 20~40s）可能超过 pollSec，
  // 不设闸的话 setInterval 会在旧轮没跑完时再起一轮 → 两轮读同一条消息 → 回两遍
  let ticking = false
  let lastTickAt = 0
  async function tick() {
    if (ticking) { log('[douyin-dm] 上一轮还没跑完，这轮跳过（不叠轮，避免重复回复）'); return }
    ticking = true
    lastTickAt = Date.now()
    // ⚠️ 变量别叫 text：下面 try 块里有 let text = pick.text，会把它遮蔽 → catch 拼错误串永远是空
    let inboundText = ''
    try {
      const readArgs = ['dm-read', '--sec-uid', secUid, '--name', ownerName, '--n', '20']
      if (silent) readArgs.push('--headless')
      const out = await runPy(readArgs, cfg)
      const data = jsonOf(out)
      const msgs = (data && data.messages) || []
      // 只看主人发来的、最新的
      // 全类型（10-25 对齐 QQ）：文字消息 + 图片消息（img 字段，dm-read 带出 URL）
      const inbound = msgs.filter(m => m.dir === 'in').map(m => ({ text: String(m.text || '').trim(), img: String(m.img || ''), shot: String(m.shot || ''), fresh: m.fresh === true })).filter(m => m.text || m.img || m.shot)
      if (!inbound.length) { failStreak = 0; return }
      // 首次运行：把现有消息全部记为基线（不回），从下一条新消息开始陪聊
      if (!seeded) {
        seeded = true
        for (const m of inbound) { const k = norm(m.text || m.img); if (k && !handled.includes(k)) handled.push(k) }
        writeJson(WM_FILE, { handled })
        log(`[douyin-dm] 首次运行：以现有 ${inbound.length} 条消息为基线，从下一条开始陪聊`)
        failStreak = 0
        return
      }
      // 选哪一条回：dm-read 返回的是**最新在前**（用记忆里的时间戳核对过：20:19 那屏在最前，
      // 17:0x 那屏在最后）。以前取 inbound[inbound.length-1] = 最旧的一条 —— 而最旧那条早就回过、
      // 在水位里了，于是每轮都停在"已处理 → return"上死循环：20:53~21:05 主人连发三条
      //（你在看滑肉视频吗 / 你还在吗 / 太好笑了）一条都没回。
      // 现在：取最新一屏里最新的一条未处理消息（数组头），没有再退到全量数组头。
      const pendOf = (arr) => arr.filter(m => { const k = norm(m.text || m.img || m.shot); return k && !handled.includes(k) })
      const freshPend = pendOf(inbound.filter(m => m.fresh))
      const pick = freshPend.length ? freshPend[0] : (pendOf(inbound)[0] || null)
      if (!pick) { failStreak = 0; return }
      let text = pick.text
      // ⚠️ 去重键必须用**原始**文本：下面识图会把卡片描述拼进 text，而每次描述措辞都不同，
      // 拿它当 key 会让同一条卡片每轮都被当成新消息 → 反复回复同一张卡片。
      const keyBase = String(pick.text || '').trim()
      // 图片消息 → Qwen3-VL 亲眼看（10-25 对齐 QQ 的全类型理解）
      if (pick.img && !text) {
        try {
          const { visionOn, describeFrames } = await import('../lib/vision.mjs')
          if (visionOn()) {
            const dl = path.join(dataPath('douyin-img'), `dm-${Date.now()}.jpg`)
            fs.mkdirSync(path.dirname(dl), { recursive: true })
            const exe = fs.existsSync('C:/Windows/System32/curl.exe') ? 'C:/Windows/System32/curl.exe' : 'curl'
            // 10-26 修：这里以前调的是 execFileSync —— 而本文件根本没导入它（只导了 execFile），
            // ReferenceError 被外层空 catch 吞掉 → 抖音私信里的图片永远只是「【发来一张图片】」。
            await execFileAsync(exe, ['-sS', '-L', '-m', '30', '-A', 'Mozilla/5.0', '-o', dl, pick.img], { timeout: 35000, windowsHide: true })
            if (fs.existsSync(dl) && fs.statSync(dl).size > 2000) {
              const desc = await describeFrames([dl], { query: '这是抖音私信里对方发来的图片。一两句话说明：图里是什么/谁、什么状态、如果是梗图说出梗。' })
              text = desc ? `【图片：${desc.slice(0, 120)}】` : '【发来一张图片，我没看清】'
            } else text = '【发来一张图片，下载失败】'
            try { fs.rmSync(dl, { force: true }) } catch {}
          } else text = '【发来一张图片】'
        } catch { text = '【发来一张图片】' }
      }
      inboundText = text
      // ⚠️ 去重必须放在"点开视频"之前：card-open 要开一次浏览器（约 35 秒），
      // 已经回过的卡片要是每轮还跑一遍，会白白占住 tick 还把 dm-server 拖到超时。
      const key = norm(keyBase || pick.img || pick.shot)
      if (!key || handled.includes(key)) { failStreak = 0; return }
      // 分享卡片 → 真的把这条视频看一遍（10-26 升级）。
      // 之前只能截卡片的封面/标题（"只知道标题和作者"），现在点开卡片拿 modal_id，
      // 再按时间抽 4 帧交给视觉模型 —— 跟她自己刷 feed 时"看懂视频"是同一条链路。
      // 用户原话：「她根本无法跟刷视频一样真的知道我分享的视频的具体内容」。
      const isCard = !!pick.shot || /\[分享/.test(pick.text)
      if (isCard) {
        const { visionOn, describeFrames } = await import('../lib/vision.mjs')
        // ① 先试"点开+抽帧"（有 id → 真内容）；② 失败再退回卡片截图（只有封面/标题）
        let gotVideo = false
        try {
          const dir = dataPath('douyin-card', String(Date.now()))
          fs.mkdirSync(dir, { recursive: true })
          const outCard = await runPy(['card-open', '--sec-uid', secUid, '--name', ownerName, '--out', dir, '--n', '4',
            // --expect：把这条消息的卡片文案带上，让脚本在列表里认出**这一张**再点。
            // 不带的话它只能猜"最靠下的那张"，10-26 实锤点开的是 30 分钟前的旧卡片，
            // 结果把旧视频的画面当成新分享讲给她（主人当场发现"你说的是之前那条"）。
            '--expect', String(pick.text || '')], cfg)
          const c = jsonOf(outCard)
          if (c && Array.isArray(c.frames) && c.frames.length && visionOn()) {
            const desc = await describeFrames(c.frames, {
              query: '这是主人分享给你的抖音视频，按时间抽的几帧。用 2~3 句话说清：画面里是谁/什么、在做什么、什么场景或风格、屏幕上有哪些字。'
                + '就像你真的把这个视频看完了那样说，别逐帧报流水账。',
            })
            if (desc && desc.trim()) {
              const kind = c.isNote ? '图文' : '视频'
              text = `${text}\n【主人分享的${kind}：${c.desc || '（无文案）'}`
                + `${c.author ? `，作者 ${c.author}` : ''}${c.duration ? `，${Math.round(c.duration)} 秒` : ''}】`
                + `\n【你看过之后的印象：${desc.trim().slice(0, 320)}】`
              gotVideo = true
              log(`[douyin-dm] 已看完${kind} ${c.vid}（${c.frames.length} 帧，作者 ${c.author || '?'}，核对 ${c.matched === false ? '✗不符' : '✓'}）：${desc.trim().slice(0, 60)}`)
            }
          } else if (c?.error) log(`[douyin-dm] card-open 没拿到画面：${c.error}`)
        } catch (e) { log(`[douyin-dm] card-open 失败：${String(e).slice(0, 120)}`) }

        // ② 退路：卡片截图（封面 + 标题）
        if (!gotVideo && pick.shot) {
          try {
            if (visionOn() && fs.existsSync(pick.shot)) {
              const desc = await describeFrames([pick.shot], {
                query: '这是抖音私信里对方分享给我的视频卡片截图。请：①把卡片上的标题文字原样读出来；'
                  + '②用一两句话说明这视频的画面在讲什么（吃的/风景/剧情/教程…）。读不出标题就直说卡片上没字，别编。',
              })
              if (desc && desc.trim()) {
                text = `${text}\n【主人分享的视频卡片：${desc.trim().slice(0, 260)}】`
                log(`[douyin-dm] 卡片已看懂：${desc.trim().slice(0, 60)}`)
              }
            }
          } catch (e) { log(`[douyin-dm] 卡片识图失败：${String(e).slice(0, 120)}`) }
        }
      }
      log(`[douyin-dm] 主人：${text.slice(0, 80)}`)

      // 先记进对话记忆（platform=douyin · 独立 chatId）：buildMessages 才能带回上下文，
      // 主人连发几句也接得住；这句话以后还会进 recall 的"主动回忆"池。
      memory.remember('douyin', CHAT_ID, ownerKey, 'user', text)

      // 复用 QQ 那套：人格 + 记忆 + 清洗（douyin-dm 平台提示 = 私聊语气，不是评论区语气）
      const msgsOut = persona.buildMessages({ platform: 'douyin-dm', userText: text, chatId: CHAT_ID, userId: ownerKey, turnsToday: handled.length })
      // 卡片占位：以前她会回"你发的这个我看不到内容呀"（10-25），后来改成教她"问标题"——
      // 结果就成了「一直叫我念标题给她」（10-26 用户投诉）。现在有截图就看截图，没截图就顺着话接，
      // **禁止**向主人索要标题/链接。
      if (/\[分享/.test(text)) {
        const last = msgsOut[msgsOut.length - 1]
        const watched = text.includes('你看过之后的印象：')
        const seenCard = text.includes('分享的视频卡片：')
        last.content += '\n\n（提示：主人这条是**分享给你的内容**。'
          + (watched
            ? '你**已经把这条视频看完了**——上面【主人分享的视频：标题/作者/时长】和'
              + '【你看过之后的印象：…】就是你亲眼看到的画面。就按那个聊：可以点出画面里的细节、'
              + '吐槽、联想到你馋的东西，像真刷到过一样。'
            : seenCard
              ? '上面【主人分享的视频卡片：…】是你亲眼看过的卡片（标题/画面都读了），就按那个说，别再说不知道是什么。'
              : '这条你没读到内容。')
          + '**绝对不要**说"看不到内容""链接打不开""标题念给我听""发我标题""你分享的哪个"这类向他要东西的话；'
          + '看过就说你看到的，没看过就顺着他那句感想接一句。）'
      } else if (/分享/.test(text)) {
        const last = msgsOut[msgsOut.length - 1]
        last.content += '\n\n（提示：主人提到"分享"，去上文找他刚发来的那条内容，据此接话。）'
      }
      const resp = await llm.chat(msgsOut, { temperature: 0.85 })
      let reply = guard.clean(String(resp?.content ?? resp ?? ''))
      // 嘴瓢兜底（10-25 21:09 实锤第二回）：她回了「啥滑肉？我这边只看到"顾思苡：分享视频"，内容是空的呀」
      // —— 记忆里还留着她 17:18 说过的那句"看不到内容"，于是又照着念了一遍。
      // 10-26 扩到两类：①喊看不见 ②向主人索要标题/链接（她自己已经能看视频了，不该再问）。
      if (reply && (looksBlind(reply) || looksAsking(reply))) {
        log(`[douyin-dm] 回复里又在要内容：「${reply.slice(0, 30)}」→ 让她重说`)
        try {
          const retryMsgs = msgsOut.slice()
          const li = retryMsgs.length - 1
          retryMsgs[li] = { role: 'user', content: String(retryMsgs[li].content) + '\n\n【重说】' + noBlindHint() }
          const r2 = await llm.chat(retryMsgs, { temperature: 0.85 })
          const t2 = guard.clean(String(r2?.content ?? r2 ?? ''))
          if (t2 && !looksBlind(t2) && !looksAsking(t2)) reply = t2
        } catch (e) { log('[douyin-dm] 重说失败：' + errTail(e).slice(0, 120)) }
        if (looksBlind(reply) || looksAsking(reply)) {
          const fixed = askInstead(reply)
          if (fixed !== reply) log(`[douyin-dm] 已剥掉"看不到/要标题"那半句：「${reply.slice(0, 30)}」→「${fixed.slice(0, 30)}」`)
          reply = fixed
        }
      }
      // 天数护栏（同 QQ）：真实间隔不到一天，就别提"你消失N天"
      if (reply && mentionsDays(reply)) {
        const gapMs = Math.max(0, Date.now() - lastOwnerMsgTsDouyin())
        const fixed = sanitizeDayClaims(reply, gapMs)
        if (fixed !== reply) log(`[douyin-dm] 天数已掰正：「${reply.slice(0, 30)}」→「${fixed.slice(0, 30)}」`)
        reply = fixed
      }
      if (!reply || reply.toUpperCase() === 'SKIP') {
        log('[douyin-dm] 不接话，跳过')
        memory.remember('douyin', CHAT_ID, ownerKey, 'assistant', '（这次没接话）')
        commitHandled(key)
        return
      }

      if (dry) {
        log(`[douyin-dm] 【干跑 ✓】本要回复：${reply.slice(0, 50)}`)
      } else {
        // silent 自起无头浏览器（CDP Chrome 9222 不一定开着，别再硬走 --cdp 秒失败）；
        // 非 silent 走 CDP 共享那个带界面的 Chrome。
        const sendArgs = ['dm-send', '--sec-uid', secUid, '--name', ownerName, '--message', reply, '--go']
        sendArgs.push(...(silent ? ['--headless'] : ['--cdp']))
        await runPy(sendArgs, cfg)   // 失败会抛 → 进 catch → 不进水位 → 下一轮重试
        log(`[douyin-dm] ✅ 已回复：${reply.slice(0, 50)}`)
      }
      memory.remember('douyin', CHAT_ID, ownerKey, 'assistant', reply)
      commitHandled(key)
      failStreak = 0
      maintainLongMemory()
    } catch (e) {
      failStreak += 1
      log(`[douyin-dm] tick 失败（连续 ${failStreak} 次，未标记已处理、下轮重试）：${inboundText ? `回复「${inboundText.slice(0, 20)}」时 ` : ''}${errTail(e)}`)
    } finally {
      ticking = false
    }
  }

  setInterval(tick, pollSec * 1000)
  tick()
}

if (process.argv[1] && process.argv[1].endsWith('douyin-dm-server.mjs')) {
  await run(process.argv.slice(2))
}
