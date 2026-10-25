// qq-server —— QQ 常驻聊天服务：接收 NapCat OneBot v11 上报 → 直连 LLM 秒回。
// 群聊默认也像私聊一样回（at_only=false，10-25 用户拍板；true 则群里被 @ 才回），私聊都回；
// 支持语音条（GPT-SoVITS + record 段，NapCat 自动转 silk）。
// 无第三方依赖，node 内置 http 即可。
//
//   node feiyu.mjs qq-server [port]     # 默认 8080
//   NapCat WebUI → 网络配置 → 新建 HTTP 服务器(3000) + HTTP 上报 → http://127.0.0.1:8080/onebot
//   上报格式 messagePostFormat 选 array
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { dataPath } from '../lib/paths.mjs'
import { config } from '../lib/config.mjs'
import * as guard from '../lib/guard.mjs'
import * as memory from '../lib/memory.mjs'
import * as qqMemory from '../lib/qq-memory.mjs'
import * as llm from '../lib/llm.mjs'
import { buildMessages, thinkingInstruction } from '../lib/persona.mjs'
import { splitSticker, pickSticker, FACE_FALLBACK, ensureSelfSticker } from '../lib/stickers.mjs'
import { synth } from '../lib/tts.mjs'
import { sing } from '../lib/sing.mjs'
import { tickMood } from '../lib/mood.mjs'
import { generateStickerImage } from '../lib/imggen.mjs'

const LOG_FILE = dataPath('qq-server.log')

/** 宿主是 stdio:'ignore' 起的进程，不打文件日志等于瞎 —— 出问题只能靠猜。 */
function logLine(level, args) {
  const msg = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
  const line = `${new Date().toISOString()} [${level}] ${msg}`
  try { console.log(line) } catch {}
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 2 * 1024 * 1024) fs.renameSync(LOG_FILE, LOG_FILE + '.1')
  } catch {}
  fs.appendFile(LOG_FILE, line + '\n', () => {})
}
const log = (...a) => logLine('INFO', a)
const logErr = (...a) => logLine('ERR', a)

/** 把一段话拆成 1~3 条短消息 —— 真人不会一次甩一大段。 */
export function splitBubbles(text, max = 3, perMax = 42) {
  const src = String(text || '').trim()
  if (!src) return []
  if (src.length <= 20) return [src]
  const parts = src.split(/(?<=[。！？!?…~～])/).map(s => s.trim()).filter(Boolean)
  const out = []
  for (const p of parts) {
    const last = out[out.length - 1]
    // 太碎的片段并到上一条；没有上一条就自己开一条
    if (last !== undefined && (p.length <= 6 || last.length < 8)) out[out.length - 1] = last + p
    else out.push(p)
  }
  // 超长的再按逗号补切一刀
  const fit = []
  for (const p of out) {
    if (p.length <= perMax) { fit.push(p); continue }
    const chunks = p.split(/(?<=[，,；;])/).map(x => x.trim()).filter(Boolean)
    let buf = ''
    for (const c of chunks) {
      if (buf && buf.length + c.length > perMax) { fit.push(buf); buf = c }
      else buf += c
    }
    if (buf) fit.push(buf)
  }
  if (fit.length <= max) return fit
  // 超过上限：尾部全并进最后一条（宁可长一点，也别刷屏）
  const head = fit.slice(0, max - 1)
  return [...head, fit.slice(max - 1).join('')]
}

/** 解析 OneBot v11 消息（array 或 CQ 码字符串）→ 纯文本 + 是否 @ 了机器人。 */
export function parseMessage(message, selfId) {
  let text = ''
  let atMe = false
  if (Array.isArray(message)) {
    for (const seg of message) {
      if (seg?.type === 'text') text += seg.data?.text ?? ''
      else if (seg?.type === 'at' && String(seg.data?.qq) === String(selfId)) atMe = true
    }
  } else if (typeof message === 'string') {
    text = message.replace(/\[CQ:[^\]]*\]/g, '')
    atMe = message.includes(`[CQ:at,qq=${selfId}]`)
  }
  return { text: text.trim(), atMe }
}

export async function run(argv = []) {
  const cfg = config()
  const QQ = cfg.qq ?? {}
  if (!QQ.enabled) { logErr('✗ qq.enabled=false —— 先在 feiyu.config.json 开 qq.enabled'); process.exit(1) }
  if (!llm.apiKey()) { logErr('✗ 没有 LLM API key（设环境变量 DEEPSEEK_API_KEY，或填 llm.api_key）'); process.exit(1) }
  try { const n = memory.sweepEpisodes(); if (n) log(`[qq] 记忆归档：${n} 条 90 天前的旧事件移入 *.archive.jsonl`) } catch {}
  const NAPCAT = (QQ.napcat_http || 'http://127.0.0.1:3000').replace(/\/+$/, '')
  const port = Number(argv[0]) || 8080

  const send = async (action, payload) => {
    try {
      const r = await fetch(`${NAPCAT}/${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        signal: AbortSignal.timeout(20000),
      })
      if (!r.ok) logErr(`[qq] 回发失败 ${action}: HTTP ${r.status}`)
      return r.ok
    } catch (e) { logErr(`[qq] 回发异常 ${action}: ${e.message}`); return false }
  }

  // ── AI 表情包补发（10-25）：图库没有的标签 / 自制表情 → Pollinations 生成入库再补发 ──
  // 异步跑（生成约 10~40s），不阻塞回复主线；同文案有缓存不重画；AI 失败退 PIL 文字贴纸。
  const aiInflight = new Set()
  async function aiStickerFollowup({ tag, caption, isGroup, groupId, userId }) {
    const key = `${tag || ''}|${caption || ''}`
    if (aiInflight.has(key)) return
    aiInflight.add(key)
    try {
      let file = null
      let desc = ''
      if (tag && !pickSticker(tag)) { desc = `标签「${tag}」`; file = await generateStickerImage(tag, { tag }) }
      if (!file && caption) { if (!desc) desc = `「${caption}」`; file = await generateStickerImage(caption) }
      if (!file && caption) file = ensureSelfSticker(caption, config())   // AI 失败 → PIL 文字贴纸兜底
      if (!file) { log(`[qq] AI 表情包没生成出来：${desc}（额度/代理/图床），这次不补发`); return }
      const target = isGroup
        ? { api: 'send_group_msg', key: 'group_id', id: Number(groupId) }
        : { api: 'send_private_msg', key: 'user_id', id: Number(userId) }
      await new Promise(r => setTimeout(r, 1000 + Math.random() * 2000))   // 像人翻表情包的工夫
      const ok = await send(target.api, { [target.key]: target.id, message: [{ type: 'image', data: { file: 'file:///' + file.replace(/\\/g, '/') } }] })
      if (ok) log(`[qq] 🎨 AI 表情包已入库补发：${desc} → ${path.basename(file)}`)
    } catch (e) { log('[qq] AI 表情包补发异常：' + (e?.message ?? e)) }
    finally { aiInflight.delete(key) }
  }

  const handle = async (evt) => {
    try {
      // 每次处理消息都重读最新配置：热改 voice_enabled / voice_chance / minGapSec 立即生效，
      // 不用重启 qq-server（原版只在进程启动时读一次，改了配置也不生效 —— 语音一直不发的根因）。
      const QQ = config().qq ?? {}
      const selfId = String(evt.self_id ?? '')
      const isGroup = evt.message_type === 'group'
      const groupId = isGroup ? String(evt.group_id ?? '') : ''
      const userId = String(evt.user_id ?? '')
      const allow = QQ.allow_groups ?? []
      if (isGroup && allow.length && !allow.includes(groupId)) return

      const { text, atMe } = parseMessage(evt.message, selfId)
      if (!text) return
      if (isGroup && QQ.at_only !== false && !atMe) return   // 群里只被 @ 才回

      const chatId = isGroup ? `qq:${groupId}` : `qq:${userId}`
      // 主动搭话的安静计时：主人（私聊）每说一句话就刷新
      try {
        const ownerQQNow = String(config().owner?.qq || '')
        if (!isGroup && ownerQQNow && String(userId) === ownerQQNow) ownerLastMsgAt = Date.now()
      } catch {}
      const raw = text.replace(new RegExp(`@?${selfId}\\s*`), '').trim()
      if (!raw) return
      // 群聊像私聊一样回（at_only=false 时）：把说话人昵称带上，她才知道在跟谁说话，
      // 记忆里也留着"谁说了什么"（号码绝不当称呼 —— ownerLine 踩过的坑）。
      // labeled 是本轮的规范文本：remember 和 buildMessages 用同一份，装配端去重才对得上。
      const display = isGroup ? String(evt.sender?.card || evt.sender?.nickname || '').trim() : ''
      const userText = (isGroup && display) ? `${display}：${raw}` : raw

      // 🎵 唱歌分支：主人让她唱，就真的唱（LLM 写词 + 她的音色逐句合成 + 鼓点混音）
      if (QQ.voice_enabled !== false && QQ.sing !== false && !isGroup && /唱(一首|首歌|个|段|吧|$)|唱歌|来一首|哼(一首|段)/.test(userText)) {
        try {
          log(`[qq] 🎵 唱歌请求：${userText.slice(0, 30)}`)
          const theme = userText.replace(/.*(唱|来)一?(首|个|段)?/, '').replace(/首歌?吧?|[吗呢？?。~～]/g, '').trim()
          // ── 专业翻唱优先（10-25）：歌单点唱 → 没学会先应一声再现场学（搜源歌→分离→换她的声音→混伴奏）
          // ── 学不会/没配好回落原创说唱（sing()），内容不丢
          let covered = false
          try {
            const { coverSong, findSong, searchQuotaOk } = await import('../lib/cover.mjs')
            const hit = findSong(theme)
            const canSearch = !hit && theme && config().sing?.search !== false && searchQuotaOk()
            if (hit || canSearch) {
              const title = hit ? hit.title : theme
              await send('send_private_msg', { user_id: Number(userId), message: [{ type: 'text', data: { text: hit ? `《${title}》我会唱！马上来～` : `《${title}》我还没学过，给我几分钟学一下哈～` } }] })
              const song = await coverSong({ source: hit ? hit.source : `ytsearch1:${theme}`, title, log: (l) => log(`[qq] 🎤 ${l}`) })
              const sent2 = await send('send_private_msg', { user_id: Number(userId), message: [{ type: 'record', data: { file: song.file } }] })
              if (sent2) {
                covered = true
                await send('send_private_msg', { user_id: Number(userId), message: [{ type: 'text', data: { text: `🎵 给你唱《${song.title}》——用我自己的声音哦${song.cache === 'hit' ? '' : '（刚学会的）'}～` } }] })
                memory.remember('qq', chatId, userId, 'assistant', `（翻唱了《${song.title}》，用她自己的音色）`)
                log(`[qq] 🎤 翻唱已发：《${song.title}》`)
              }
            }
          } catch (e) { logErr('[qq] 专业翻唱没成，回落原创说唱：' + String(e.message).slice(0, 120)) }
          if (covered) return
          const song = await sing(theme)
          const sent2 = await send('send_private_msg', { user_id: Number(userId), message: [{ type: 'record', data: { file: song.file } }] })
          if (sent2) {
            await send('send_private_msg', { user_id: Number(userId), message: [{ type: 'text', data: { text: `🎵《${song.title}》 ${song.bpm}bpm —— ${song.lyrics.join(' / ')}` } }] })
            memory.remember('qq', chatId, userId, 'assistant', `（唱了《${song.title}》：${song.lyrics.join('/')}）`)
            log(`[qq] 🎵 已唱《${song.title}》(${song.bpm}bpm, ${song.lyrics.length}句)`)
            return
          }
        } catch (e) {
          logErr('[qq] 唱歌失败，降级回复文字：' + e.message)
          // 落回普通回复
        }
      }

      memory.remember('qq', chatId, userId, 'user', userText)

      // 生成回复（三段式 prompt + 走神注入）
      const turns = memory.recent(chatId).length
      const messages = buildMessages({ platform: 'qq', userText, chatId, userId, turnsToday: turns, isGroup })
      messages[0].content += thinkingInstruction()
      const answer = await llm.chat(messages)
      const out = guard.clean(answer, config())
      if (!out) return

      // 表情：文字和 [表情:标签] 拆开发（NapCat 图片段）
      const { text: body, tag, caption } = splitSticker(out)
      const aiOn = config().imageGen?.enabled !== false
      let stickerFile = tag ? pickSticker(tag) : null
      if (!stickerFile && caption && !aiOn) stickerFile = ensureSelfSticker(caption, config())  // AI 关着才当场画文字贴纸
      const plain = body || (stickerFile ? '' : (FACE_FALLBACK[tag] || ''))
      // AI 表情包：图库没有这个标签 / 有自制表情文案 → 待异步生成（不卡回复主线）
      const aiWanted = aiOn && ((tag && !pickSticker(tag)) || (caption && !stickerFile))
      if (!plain && !stickerFile && !aiWanted) return

      // 干跑：只打印不真发（dafeiyu 铁律：第一周先观察）
      if (config().guard?.dryRun) {
        log(`[qq][干跑] ${isGroup ? '群' + groupId : '私聊' + userId} → ${plain}${stickerFile ? ' [表情图]' : ''}${aiWanted ? ` +AI表情「${tag || caption}」` : ''}`)
        memory.remember('qq', chatId, userId, 'assistant', plain || out)

      // 长期记忆：跟主人私聊时，每 6 条回复把这段对话压成摘要 + 更新主人画像（不阻塞回复）
      try {
        const ownerQQ = String(config().owner?.qq || '')
        if (!isGroup && ownerQQ && String(userId) === ownerQQ) {
          qqMemory.bump(chatId)
          if (qqMemory.due(chatId)) {
            qqMemory.refresh({ chatId, owner: config().owner, chat: (m) => llm.chat(m) })
              .then((ok) => { if (ok) log('[qq] 记忆已压缩（摘要 + 主人画像）') })
              .catch((e) => logErr('[qq] 记忆压缩失败：', e.message))
          }
        }
      } catch (e) { logErr('[qq] 记忆维护异常：', e.message) }
        return
      }

      // 真发前：间隔 + 去重（跳过 dryRun，上面已单独处理）
      // QQ 是即时聊天：间隔用 qq.minGapSec（默认 2 秒），不能用全局 guard.minGapSec（25 秒，那是 B 站防刷评论的）
      const qqGuardCfg = { ...config(), guard: { ...config().guard, minGapSec: Number(QQ.minGapSec ?? 2) } }
      const verdict = guard.allow(chatId, out, qqGuardCfg, { checkDryRun: false })
      if (!verdict.ok) { logErr(`[qq] 拦下：${verdict.why}`); return }
      guard.commit(chatId, out)

      // 语音 or 文字（语音失败一律降级文字，内容不丢）
      let sent = false
      if (QQ.voice_enabled && plain && Math.random() < (Number(QQ.voice_chance) || 0.15)) {
        try {
          const audio = await synth(plain)
          const seg = { type: 'record', data: { file: audio } }   // NapCat 自动转 silk
          sent = isGroup
            ? await send('send_group_msg', { group_id: Number(groupId), message: [seg] })
            : await send('send_private_msg', { user_id: Number(userId), message: [seg] })
          if (sent) log(`[qq] 已发语音 → ${isGroup ? '群' + groupId : userId}`)
        } catch (e) {
          logErr(`[qq] 语音失败，降级文字：${e.message}`)
          sent = false
        }
      }
      const target = isGroup
        ? { api: 'send_group_msg', key: 'group_id', id: Number(groupId) }
        : { api: 'send_private_msg', key: 'user_id', id: Number(userId) }
      if (!sent) {
        // 像人一样分条发：一句一条，间隔几百毫秒到一秒多（不是机械固定）
        const bubbles = splitBubbles(plain)
        for (let i = 0; i < bubbles.length; i++) {
          if (i) await new Promise(r => setTimeout(r, 420 + Math.random() * 900))
          await send(target.api, { [target.key]: target.id, message: [{ type: 'text', data: { text: bubbles[i] } }] })
        }
        if (bubbles.length > 1) log(`[qq] 分 ${bubbles.length} 条发`)
      }
      // 表情：文字或语音发完都补发（以前语音命中时表情整个被跳过——10-25 实测坑）
      if (stickerFile) {
        await new Promise(r => setTimeout(r, 300 + Math.random() * 500))
        const okImg = await send(target.api, { [target.key]: target.id, message: [{ type: 'image', data: { file: 'file:///' + stickerFile.replace(/\\/g, '/') } }] })
        if (okImg) log(`[qq] 已发表情：${tag || caption || '?'}`)
      }
      // AI 表情包：生成入库 + 补发（异步，不占回复主线；干跑分支已在上面 return，走不到这）
      if (aiWanted) void aiStickerFollowup({ tag, caption, isGroup, groupId, userId })
      memory.remember('qq', chatId, userId, 'assistant', plain || out)

      // 长期记忆：跟主人私聊时，每 6 条回复把这段对话压成摘要 + 更新主人画像（不阻塞回复）
      try {
        const ownerQQ = String(config().owner?.qq || '')
        if (!isGroup && ownerQQ && String(userId) === ownerQQ) {
          qqMemory.bump(chatId)
          if (qqMemory.due(chatId)) {
            qqMemory.refresh({ chatId, owner: config().owner, chat: (m) => llm.chat(m) })
              .then((ok) => { if (ok) log('[qq] 记忆已压缩（摘要 + 主人画像）') })
              .catch((e) => logErr('[qq] 记忆压缩失败：', e.message))
          }
        }
      } catch (e) { logErr('[qq] 记忆维护异常：', e.message) }
    } catch (e) {
      logErr('[qq] 处理失败：', e.message)
    }
  }

  // ── NapCat 看门狗：它才是 QQ 的消息网关。网关不通 = 服务在跑但永远不回复 ──
  const LAUNCHER = QQ.napcat_launcher || 'D:/NapCat/launcher-user.bat'
  let napcatOk = false
  let napcatCheckedAt = 0
  let napcatDownSince = 0
  let napcatFails = 0        // 连续探活失败次数（去抖用）
  let autostartAt = 0

  async function checkNapcat() {
    try {
      const r = await fetch(`${NAPCAT}/get_status`, { signal: AbortSignal.timeout(3000) })
      napcatOk = r.ok
    } catch {
      napcatOk = false
    }
    napcatCheckedAt = Date.now()
    if (!napcatOk) {
      napcatFails += 1
      // 单次探活失败不算断（QQ 忙的时候 /get_status 也会超时，实测 26s 就自愈的瞬时抖动）：
      // 连续 2 次失败才拉警报，不然日志全是狼来了。
      if (napcatFails < 2) return napcatOk
      if (!napcatDownSince) napcatDownSince = Date.now()
      const downSec = Math.round((Date.now() - napcatDownSince) / 1000)
      logErr(`[napcat] 网关不通（${NAPCAT}），已持续 ${downSec}s —— 这期间收不到也发不出任何 QQ 消息`)
      if (downSec === 30) logErr(`[napcat] 修复办法：右键「管理员运行」${LAUNCHER}（QQ 会自动登录/让你扫码）`)
      // 默认不自动拉：NapCat 要管理员把 DLL 注入 QQ，普通权限起了也是白起（实测 QQ 进程数 0）。
      const auto = QQ.autostartNapcat === true
      if (auto && downSec >= 20 && Date.now() - autostartAt > 10 * 60_000 && fs.existsSync(LAUNCHER)) {
        autostartAt = Date.now()
        log(`[napcat] 尝试拉起 QQ 网关：${LAUNCHER}（登录态需要你扫码时会弹窗）`)
        try {
          const { spawn } = await import('node:child_process')
          spawn('cmd.exe', ['/c', 'start', '', LAUNCHER], { detached: true, stdio: 'ignore', windowsHide: false }).unref()
        } catch (e) {
          logErr('[napcat] 拉起失败：' + e.message)
        }
      }
    } else {
      napcatFails = 0
      if (napcatDownSince) log('[napcat] 网关恢复')
      napcatDownSince = 0
    }
    return napcatOk
  }
  checkNapcat()
  setInterval(checkNapcat, 30_000)

  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/onebot') {
      let body = ''
      req.on('data', c => { body += c; if (body.length > 1024 * 1024) req.destroy() })
      req.on('end', async () => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('{"status":"ok"}')
        try {
          const evt = JSON.parse(body)
          if (evt.post_type === 'message') await handle(evt)
        } catch (e) { logErr('[qq] 事件解析失败：', e.message) }
      })
      return
    }
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        ok: true,
        dryRun: !!config().guard?.dryRun,
        napcat: { ok: napcatOk, url: NAPCAT, checkedAt: napcatCheckedAt, downSince: napcatDownSince || null },
        ...memory.stats(),
      }))
      return
    }
    res.writeHead(404); res.end()
  })

  server.listen(port, '127.0.0.1', () => {
    log(`[qq] 监听 http://127.0.0.1:${port}/onebot`)
    log(`    NapCat WebUI → 网络配置 → HTTP 上报 → http://127.0.0.1:${port}/onebot（messagePostFormat=array）`)
    log(`    dryRun=${!!config().guard?.dryRun} · at_only=${QQ.at_only !== false} · voice=${!!QQ.voice_enabled} · napcat=${NAPCAT}`)
  })

  // ── 主动搭话引擎（B站同款自主性）：主人安静久了，带着由头主动开口 ──────────
  // 原则：随机拟人不定点；正聊着不打扰（minQuietMin）；深夜不打扰（activeHours）；
  //       每天有上限（dailyMax）；开口前情绪先漂移一次；发完即写记忆（推送即记忆）。
  const PROACT_FILE = dataPath('qq-proactive.json')
  let ownerLastMsgAt = 0
  const dayKeyNow = () => new Date().toLocaleDateString('sv-SE')
  const readProact = () => { try { return JSON.parse(fs.readFileSync(PROACT_FILE, 'utf8')) } catch { return {} } }
  const writeProact = (st) => { try { fs.writeFileSync(PROACT_FILE, JSON.stringify(st)) } catch {} }

  async function tryProactive() {
    try {
      const cfgNow = config()
      const pp = cfgNow.qq?.proactive ?? {}
      if (pp.enabled !== true) return
      // 晚间限制（用户 10-25 拍板可关）：activeHours 配成 null / [] = 全天可主动搭话；[a,b] 才限时
      const ah = pp.activeHours
      if (Array.isArray(ah) && ah.length === 2) {
        const hour = new Date().getHours()
        if (hour < ah[0] || hour >= ah[1]) return
      }
      let st = readProact()
      if (st.day !== dayKeyNow()) st = { day: dayKeyNow(), count: 0, lastAt: 0 }
      const dailyMax = Number(pp.dailyMax ?? 3)
      if (dailyMax > 0 && Number(st.count ?? 0) >= dailyMax) return
      if (Date.now() - Number(st.lastAt ?? 0) < Number(pp.minGapMin ?? 150) * 60_000) return
      if (ownerLastMsgAt && Date.now() - ownerLastMsgAt < Number(pp.minQuietMin ?? 90) * 60_000) return
      if (Math.random() > Number(pp.chance ?? 0.12)) return

      const ownerQQ = String(cfgNow.owner?.qq || '')
      if (!ownerQQ) return
      tickMood()
      const quietH = ownerLastMsgAt ? Math.floor((Date.now() - ownerLastMsgAt) / 3600_000) : 99
      // 复用整套 QQ 人格装配（人设+主人画像+世界块+lore+情绪），只换最后的行为指令
      const built = buildMessages({ platform: 'qq', userText: '', chatId: `qq:${ownerQQ}`, userId: ownerQQ, turnsToday: 0 })
      const quietHint = quietH >= 5 ? `（主人已经 ${quietH} 个小时没理你了，可以带一点点小委屈或调侃他，但别过头）` : ''
      const msgs = [
        built[0],
        { role: 'user', content: `【主动搭话】主人有一阵子没说话了${quietH < 99 ? `（约 ${quietH} 小时）` : ''}。${quietHint}\n`
          + '现在你主动给他发一条 QQ 消息。像真人主动发微信那样：一条，一两句话，自然、有具体由头（刚看到的视频、饭点饿了、想起他之前说过的话、B站有人回了你评论）。\n'
          + '禁止"在吗/你好"式开场，不要长篇，不要一次发多条，只输出消息正文。' },
      ]
      const resp = await llm.chat(msgs, { temperature: 0.95, max_tokens: 120 })
      const out = guard.clean(String(resp ?? ''), cfgNow)
      if (!out) return
      if (cfgNow.guard?.dryRun) { log(`[qq][干跑] 本要主动搭话：${out.slice(0, 50)}`); return }
      const ok = await send('send_private_msg', { user_id: Number(ownerQQ), message: [{ type: 'text', data: { text: out } }] })
      if (!ok) return
      memory.remember('qq', `qq:${ownerQQ}`, ownerQQ, 'assistant', out)   // 推送即记忆：她自己"说过"这句
      writeProact({ day: dayKeyNow(), count: Number(st.count ?? 0) + 1, lastAt: Date.now() })
      log(`[qq] 🐟 主动搭话：${out.slice(0, 50)}`)
    } catch (e) { logErr('[qq] 主动搭话失败：' + e.message) }
  }
  setInterval(tryProactive, 60_000)
}
