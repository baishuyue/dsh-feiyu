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
import { execFileSync } from 'node:child_process'
import { config } from '../lib/config.mjs'
import * as persona from '../lib/persona.mjs'
import * as llm from '../lib/llm.mjs'
import * as guard from '../lib/guard.mjs'
import * as memory from '../lib/memory.mjs'
import * as qqMemory from '../lib/qq-memory.mjs'
import { dataPath } from '../lib/paths.mjs'

const WM_FILE = dataPath('douyin-dm-watermark.json')
const CHAT_ID = 'douyin-dm:owner'

function arg(argv, name, d) { const i = argv.indexOf(name); return i >= 0 ? (argv[i + 1] ?? d) : d }

function runPy(args, cfg) {
  const cmd = [cfg.douyin?.script || 'D:/social-auto-upload/douyin_interact.py', ...args,
    '--cookie', cfg.douyin?.cookie || path.join(os.homedir(), '.feiyu-ai', 'douyin-cookies.json')]
  return execFileSync(cfg.douyin?.python || 'D:/social-auto-upload/.venv/Scripts/python.exe', cmd,
    { encoding: 'utf8', timeout: 180000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
}
function jsonOf(out) { const m = String(out).match(/\{[\s\S]*\}/); if (!m) return null; try { return JSON.parse(m[0]) } catch { return null } }

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return d } }

// 宿主 stdio:ignore 起进程，不打文件日志等于瞎 —— 出问题只能靠猜
const LOG = dataPath('douyin-dm.log')
const log = (...a) => { const m = a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '); try { console.log(m) } catch {}; try { fs.appendFileSync(LOG, `${new Date().toISOString()} ${m}\n`) } catch {} }
const writeJson = (f, v) => { try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v)) } catch {} }

const norm = (s) => String(s || '').replace(/\s+/g, '').slice(0, 60)

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
      res.end(JSON.stringify({ ok: true, owner: ownerName, dry, pollSec, handled: handled.length, failStreak }))
      return
    }
    res.end(JSON.stringify({ ok: true }))
  })
  // 默认 8095：8090 常被 Wondershare 推送组件（WsToastNotification.exe）占着，绑不上
  const port = Number(arg(argv, '--port', cfg.douyin?.dm?.port || 8095))
  server.listen(port, '127.0.0.1', () => log(`[douyin-dm] 监听 http://127.0.0.1:${port}/health · 每 ${pollSec}s 轮询主人私信 · dry=${dry} · silent=${silent}`))

  async function tick() {
    let text = ''
    try {
      const readArgs = ['dm-read', '--sec-uid', secUid, '--name', ownerName, '--n', '20']
      if (silent) readArgs.push('--headless')
      const out = runPy(readArgs, cfg)
      const data = jsonOf(out)
      const msgs = (data && data.messages) || []
      // 只看主人发来的、最新的
      const inbound = msgs.filter(m => m.dir === 'in').map(m => String(m.text || '').trim()).filter(Boolean)
      if (!inbound.length) { failStreak = 0; return }
      // 首次运行：把现有消息全部记为基线（不回），从下一条新消息开始陪聊
      if (!seeded) {
        seeded = true
        for (const t of inbound) { const k = norm(t); if (k && !handled.includes(k)) handled.push(k) }
        writeJson(WM_FILE, { handled })
        log(`[douyin-dm] 首次运行：以现有 ${inbound.length} 条消息为基线，从下一条开始陪聊`)
        failStreak = 0
        return
      }
      text = inbound[inbound.length - 1]
      const key = norm(text)
      if (!key || handled.includes(key)) { failStreak = 0; return }

      log(`[douyin-dm] 主人：${text.slice(0, 50)}`)

      // 先记进对话记忆（platform=douyin · 独立 chatId）：buildMessages 才能带回上下文，
      // 主人连发几句也接得住；这句话以后还会进 recall 的"主动回忆"池。
      memory.remember('douyin', CHAT_ID, ownerKey, 'user', text)

      // 复用 QQ 那套：人格 + 记忆 + 清洗（douyin-dm 平台提示 = 私聊语气，不是评论区语气）
      const msgsOut = persona.buildMessages({ platform: 'douyin-dm', userText: text, chatId: CHAT_ID, userId: ownerKey, turnsToday: handled.length })
      // 主人在回复她之前分享的视频卡片时（dm-read 对卡片只有 [分享视频] 占位）——
      // 提示她去上文找自己发的附言，那才是内容本身；别再说"看不到内容"（10-25 实锤割裂 bug）
      if (/\[分享(视频|作品)/.test(text) || /分享/.test(text)) {
        const last = msgsOut[msgsOut.length - 1]
        last.content += '\n\n（提示：主人这条很可能是在回复你之前分享的视频卡片。翻上面的对话——你发过的附言（「我的评论：…」或《…》链接）就是这个视频的内容，据此自然地接话。别再说"看不到内容"。）'
      }
      const resp = await llm.chat(msgsOut, { temperature: 0.85 })
      const reply = guard.clean(String(resp?.content ?? resp ?? ''))
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
        runPy(sendArgs, cfg)   // 失败会抛 → 进 catch → 不进水位 → 下一轮重试
        log(`[douyin-dm] ✅ 已回复：${reply.slice(0, 50)}`)
      }
      memory.remember('douyin', CHAT_ID, ownerKey, 'assistant', reply)
      commitHandled(key)
      failStreak = 0
      maintainLongMemory()
    } catch (e) {
      failStreak += 1
      log(`[douyin-dm] tick 失败（连续 ${failStreak} 次，未标记已处理、下轮重试）：${text ? `回复「${text.slice(0, 20)}」时 ` : ''}${errTail(e)}`)
    }
  }

  setInterval(tick, pollSec * 1000)
  tick()
}

if (process.argv[1] && process.argv[1].endsWith('douyin-dm-server.mjs')) {
  await run(process.argv.slice(2))
}
