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
import { startBriefRefresher } from '../lib/ledger.mjs'
import * as guard from '../lib/guard.mjs'
import * as memory from '../lib/memory.mjs'
import * as qqMemory from '../lib/qq-memory.mjs'
import * as ownerFacts from '../lib/owner-facts.mjs'
import * as promises from '../lib/promises.mjs'
import * as quoteIndex from '../lib/quote.mjs'
import { fed } from '../lib/mood.mjs'
import * as llm from '../lib/llm.mjs'
import { buildMessages, thinkingInstruction, addressesOwner } from '../lib/persona.mjs'
import { gapText, mentionsDays, sanitizeDayClaims } from '../lib/timefix.mjs'
import { splitSticker, pickSticker, FACE_FALLBACK, ensureSelfSticker, autoTag } from '../lib/stickers.mjs'
import { synth } from '../lib/tts.mjs'
import { parseEmotionTag, splitVoiceParts, emotionProfile, emotionMenu } from '../lib/emotion.mjs'
import { sing } from '../lib/sing.mjs'
import { tickMood } from '../lib/mood.mjs'
import { generateStickerImage } from '../lib/imggen.mjs'
import { availableTags } from '../lib/stickers.mjs'
import { execFile, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'

// 图片下载必须异步：execFileSync 会把事件循环钉住最多 35 秒，期间 /health 不通、群里所有
// 消息都排队。10-26 修：这条路径原来调的是**没导入**的 execFileSync，ReferenceError 被空
// catch 吞掉 → QQ 里发的图片永远进不了视觉理解，只剩一句占位。
const execFileAsync = promisify(execFile)

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
  const images = []   // 图片 URL（等 Qwen3-VL 来"看"）
  const marks = []    // 非文字内容的描述标记
  let replyId = ''    // 引用了哪一条（10-27：以前只留一句"【引用…】"，被引用的正文丢了）
  if (Array.isArray(message)) {
    for (const seg of message) {
      const t = seg?.type
      if (t === 'text') text += seg.data?.text ?? ''
      else if (t === 'at' && String(seg.data?.qq) === String(selfId)) atMe = true
      else if (t === 'image') {
        const u = String(seg.data?.url || seg.data?.file || '')
        if (/^https?:\/\//.test(u)) images.push(u)
        marks.push('【发了一张图片】')
      } else if (t === 'face') marks.push('【QQ表情】')
      else if (t === 'video') marks.push('【发了一段视频】')
      else if (t === 'record') marks.push('【发了一条语音】')
      else if (t === 'reply') {
        replyId = String(seg.data?.id ?? seg.data?.message_id ?? '').trim()
        marks.push('【引用回复了一条消息】')
      }
      else if (t === 'forward' || t === 'node') marks.push('【合并转发消息】')
      else if (t === 'json' || t === 'miniapp') {
        // 卡片（B站/小程序/结构化消息）：挖 title/desc/url
        let card = { title: '', desc: '', url: '' }
        try {
          const j = JSON.parse(seg.data?.data || seg.data?.json || '{}')
          const dig = (o, depth = 0) => {
            if (!o || typeof o !== 'object' || depth > 3) return null
            if ((o.title || o.desc) && (o.url || o.jumpUrl || o.qqdocurl)) return o
            for (const v of Object.values(o)) { const hit = dig(v, depth + 1); if (hit) return hit }
            return null
          }
          const hit = dig(j)
          card = { title: String(hit?.title || j.prompt || '').slice(0, 60), desc: String(hit?.desc || '').slice(0, 60), url: String(hit?.url || hit?.jumpUrl || hit?.qqdocurl || '').slice(0, 120) }
        } catch { card.title = String(seg.data?.data || '').slice(0, 40) }
        marks.push(`【分享卡片：${card.title || '未知内容'}${card.desc ? ' · ' + card.desc : ''}】`)
      } else if (t) marks.push(`【${t}】`)
    }
  } else if (typeof message === 'string') {
    text = message.replace(/\[CQ:[^\]]*\]/g, '')
    atMe = message.includes(`[CQ:at,qq=${selfId}]`)
    const m = /\[CQ:reply,id=(-?\d+)/.exec(message)
    if (m) replyId = m[1]
  }
  return { text: text.trim(), atMe, images, marks, replyId }
}

export async function run(argv = []) {
  const cfg = config()
  // 账本：每 10 分钟刷一版（persona 的【账本】块读这份缓存，同步、不打网络）
  if (cfg.ledger?.enabled !== false) startBriefRefresher(10, (m) => console.log('[feiyu] ' + m))
  const QQ = cfg.qq ?? {}
  if (!QQ.enabled) { logErr('✗ qq.enabled=false —— 先在 feiyu.config.json 开 qq.enabled'); process.exit(1) }
  if (!llm.apiKey()) { logErr('✗ 没有 LLM API key（设环境变量 DEEPSEEK_API_KEY，或填 llm.api_key）'); process.exit(1) }
  try { const n = memory.sweepEpisodes(); if (n) log(`[qq] 记忆归档：${n} 条 90 天前的旧事件移入 *.archive.jsonl`) } catch {}
  const NAPCAT = (QQ.napcat_http || 'http://127.0.0.1:3000').replace(/\/+$/, '')
  const port = Number(argv[0]) || 8080

  const callApi = async (action, payload = {}, timeout = 20000) => {
    try {
      const r = await fetch(`${NAPCAT}/${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeout),
      })
      if (!r.ok) { logErr(`[qq] ${action} 失败: HTTP ${r.status}`); return null }
      return await r.json().catch(() => null)
    } catch (e) { logErr(`[qq] ${action} 异常: ${e.message}`); return null }
  }

  const send = async (action, payload) => {
    const j = await callApi(action, payload)
    if (!j) return false
    if (j.status && j.status !== 'ok') {
      logErr(`[qq] ${action} 返回 ${j.status}/${j.retcode}: ${j.message || j.wording || ''}`)
      return false
    }
    // 10-27：自己发的每条都记下 message_id → 正文，主人引用她的话时能零延迟取到原文
    try {
      const id = j?.data?.message_id ?? j?.message_id
      const txt = Array.isArray(payload?.message)
        ? payload.message.map((s) => (s?.type === 'text' ? s.data?.text ?? '' : s?.type === 'image' ? '【图片】' : '')).join('')
        : String(payload?.message ?? '')
      if (id) quoteIndex.remember(id, { text: txt || '（一条非文字消息）', who: 'me', name: '你' })
    } catch {}
    return true
  }

  // ── 引用索引预热（10-27）──────────────────────────────────────────────
  // get_msg 只认得还有缓存的消息（实测老消息直接回"消息不存在"），所以启动时和之后每 10 分钟
  // 把主人私聊 / 已开群 的最近几十条拉一遍，id → 正文 全部登记。这样引用历史消息也能取到原文。
  async function warmQuoteIndex(count = 40) {
    const ownerQQ = String(config().owner?.qq || '')
    const targets = []
    if (ownerQQ) targets.push({ api: 'get_friend_msg_history', key: 'user_id', id: Number(ownerQQ) })
    for (const gid of (QQ.allow_groups || [])) targets.push({ api: 'get_group_msg_history', key: 'group_id', id: Number(gid) })
    let n = 0
    for (const t of targets) {
      const j = await callApi(t.api, { [t.key]: t.id, count }, 15000)
      const msgs = j?.data?.messages
      if (!Array.isArray(msgs)) continue
      for (const m of msgs) {
        const senderQQ = String(m?.sender?.user_id ?? '')
        const who = senderQQ === String(selfIdCached) ? 'me' : (senderQQ === ownerQQ ? 'owner' : 'other')
        const p = parseMessage(m?.message, selfIdCached)
        const own = [p.text, ...p.marks.filter((x) => x !== '【引用回复了一条消息】')].filter(Boolean).join(' ')
        if (!own) continue
        quoteIndex.remember(m.message_id, {
          text: own, who, at: Number(m.time) * 1000,
          name: String(m?.sender?.card || m?.sender?.nickname || senderQQ),
        })
        n++
      }
    }
    quoteIndex.save()
    if (n) log(`[qq] 引用索引预热：${n} 条（${quoteIndex.size()} 条在手）`)
  }

  // ── 引用消息解析（10-27）──────────────────────────────────────────────
  // 本地表（她自己发过的、以及最近收到的）→ 没命中就问 NapCat get_msg。
  // 引用里的图片再走一次 VL，免得"他引用了一张图"她只看到一句话。
  async function resolveQuote(replyId, { selfId = '', userId = '', isGroup = false, groupId = '' } = {}) {
    const ownerQQ = String(config().owner?.qq || '')
    let rec = quoteIndex.get(replyId)
    if (!rec) {
      const j = await callApi('get_msg', { message_id: Number(replyId) || replyId }, 12000)
      const data = j?.data || (j?.status === 'ok' ? j : null)
      if (data) {
        rec = quoteIndex.fromGetMsg(data, { selfQQ: selfId, ownerQQ, parseMessage })
        if (rec) quoteIndex.remember(replyId, rec)
      }
    }
    // 还是没有 → 可能是很久以前的消息：现场把最近历史再拉一遍（比"取不到"强）
    if (!rec) {
      await warmQuoteIndex(60)
      rec = quoteIndex.get(replyId)
    }
    if (rec && config().qq?.quote?.seeImage !== false) {
      // 被引用的是图片：取一次 VL 描述（失败就算了，别拖慢回复）
      const url = /https?:\/\/[^\s"）)]+/.exec(rec.text)?.[0]
      if (url && rec.who === 'me' && /【发了一张图片】|【图片】/.test(rec.text)) {
        try {
          const { visionOn, describeFrames } = await import('../lib/vision.mjs')
          if (visionOn()) {
            const dl = path.join(dataPath('qq-img'), `q-${Date.now()}.jpg`)
            fs.mkdirSync(path.dirname(dl), { recursive: true })
            const exe = fs.existsSync('C:/Windows/System32/curl.exe') ? 'C:/Windows/System32/curl.exe' : 'curl'
            await execFileAsync(exe, ['-sS', '-L', '-m', '25', '-A', 'Mozilla/5.0', '-o', dl, url], { timeout: 30000, windowsHide: true })
            if (fs.existsSync(dl) && fs.statSync(dl).size > 2000) {
              const desc = await describeFrames([dl], { query: '这是他引用的一张图。一两句话说明图里是什么/什么梗/情绪。' })
              if (desc) rec.text = `${rec.text}（图里是：${desc.slice(0, 100)}）`
            }
            try { fs.rmSync(dl, { force: true }) } catch {}
          }
        } catch {}
      }
    }
    return quoteIndex.describe(rec, { selfQQ: selfId, ownerQQ })
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

      // 全类型消息理解（10-25）：卡片/视频/表情等非文字段 → 描述标记；图片 → Qwen3-VL 亲眼看
      const parsed = parseMessage(evt.message, selfId)
      let extra = parsed.marks.filter((m) => m !== '【发了一张图片】').join(' ')   // 图片单独走 VL
      const { text, atMe, images } = { text: parsed.text, atMe: parsed.atMe, images: parsed.images }

      // ── 引用消息（10-27）：把他引用的那条原文取回来 ────────────────────────
      // 主人常常引用她上面那句再问"这个呢/你去了吗"，以前她只看到"【引用回复了一条消息】"，
      // 等于被蒙着眼睛提问。这里：本地表 → NapCat get_msg → 连图片都用 VL 看一眼。
      let quoteLine = ''
      if (parsed.replyId && config().qq?.quote?.enabled !== false) {
        try {
          quoteLine = await resolveQuote(parsed.replyId, { selfId, userId, isGroup, groupId })
          if (quoteLine) log(`[qq] 📎 引用解析：${quoteLine.slice(0, 70)}`)
        } catch (e) { logErr('[qq] 引用解析失败：' + (e?.message ?? e)) }
      }
      // 别人（含主人）发来的这条也登记，下次被引用就不用请求
      if (evt.message_id) {
        const who = String(userId) === String(config().owner?.qq || '') ? 'owner' : 'other'
        const label = isGroup ? String(evt.sender?.card || evt.sender?.nickname || userId) : '主人'
        const own = [parsed.text, ...parsed.marks.filter((m) => m !== '【引用回复了一条消息】')].filter(Boolean).join(' ')
        quoteIndex.remember(evt.message_id, { text: own || '（非文字消息）', who, name: label })
      }
      if (!text && !images.length && !extra) return
      if (isGroup && QQ.at_only !== false && !atMe) return   // 群里只被 @ 才回
      const chatId = isGroup ? `qq:${groupId}` : `qq:${userId}`
      // 群聊插话引擎的在场信号：有群消息就刷新该群的时间戳（她"看到"群里在聊天）
      if (isGroup) groupLastMsgAt[groupId] = Date.now()
      // 主动搭话的安静计时：主人（私聊）每说一句话就刷新
      try {
        const ownerQQNow = String(config().owner?.qq || '')
        if (!isGroup && ownerQQNow && String(userId) === ownerQQNow) ownerLastMsgAt = Date.now()
      } catch {}
      let imageDesc = ''
      if (images.length) {
        try {
          const { visionOn, describeFrames } = await import('../lib/vision.mjs')
          if (visionOn()) {
            const dl = path.join(dataPath('qq-img'), `img-${Date.now()}-${Math.floor(Math.random() * 1e4)}.jpg`)
            fs.mkdirSync(path.dirname(dl), { recursive: true })
            const exe = fs.existsSync('C:/Windows/System32/curl.exe') ? 'C:/Windows/System32/curl.exe' : 'curl'
            await execFileAsync(exe, ['-sS', '-L', '-m', '30', '-A', 'Mozilla/5.0', '-o', dl, images[0]], { timeout: 35000, windowsHide: true })
            if (fs.existsSync(dl) && fs.statSync(dl).size > 2000) {
              const desc = await describeFrames([dl], { query: '这是 QQ 聊天里对方发来的图片。一两句话说明：图里是什么/谁、在干什么、如果是表情包或梗图说出它的梗和情绪。' })
              imageDesc = desc ? `【她发来的图片：${desc.slice(0, 120)}】` : '【她发来一张图片，但我没看清】'
            } else imageDesc = '【她发来一张图片，但下载失败】'
            try { fs.rmSync(dl, { force: true }) } catch {}
          } else imageDesc = '【她发来一张图片】'
        } catch { imageDesc = '【她发来一张图片】' }
        try { fs.rmSync(path.join(dataPath('qq-img')), { recursive: true, force: true }) } catch {}   // 用完即清
      }
      // 10-27：引用行（他引用了哪一条）拼在正文前面 —— 记忆里也留着，回头能还原上下文
      const parts = [quoteLine, text.replace(new RegExp(`@?${selfId}\\s*`), '').trim(), extra, imageDesc]
      const raw = parts.filter(Boolean).join(' ')
      if (!raw) return
      // 群聊像私聊一样回（at_only=false 时）：把说话人昵称带上，她才知道在跟谁说话，
      // 记忆里也留着"谁说了什么"（号码绝不当称呼 —— ownerLine 踩过的坑）。
      // labeled 是本轮的规范文本：remember 和 buildMessages 用同一份，装配端去重才对得上。
      const display = isGroup ? String(evt.sender?.card || evt.sender?.nickname || '').trim() : ''
      // 引用行不进"他说的正文"（否则会把被引用的原话当成新说的话去抽事实），
      // 但**要进记忆**：回头 recall 时才还原得出上下文。
      const said = (isGroup && display) ? `${display}：${raw}` : raw
      const userText = said
      const memText = quoteLine ? `${quoteLine} ${said}` : said

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
                memory.remember('qq', chatId, userId, 'assistant', `（翻唱了《${song.title}》，用她自己的音色）`, { isGroup })
                log(`[qq] 🎤 翻唱已发：《${song.title}》`)
              }
            }
          } catch (e) { logErr('[qq] 专业翻唱没成，回落原创说唱：' + String(e.message).slice(0, 120)) }
          if (covered) return
          const song = await sing(theme)
          const sent2 = await send('send_private_msg', { user_id: Number(userId), message: [{ type: 'record', data: { file: song.file } }] })
          if (sent2) {
            await send('send_private_msg', { user_id: Number(userId), message: [{ type: 'text', data: { text: `🎵《${song.title}》 ${song.bpm}bpm —— ${song.lyrics.join(' / ')}` } }] })
            memory.remember('qq', chatId, userId, 'assistant', `（唱了《${song.title}》：${song.lyrics.join('/')}）`, { isGroup })
            log(`[qq] 🎵 已唱《${song.title}》(${song.bpm}bpm, ${song.lyrics.length}句)`)
            return
          }
        } catch (e) {
          logErr('[qq] 唱歌失败，降级回复文字：' + e.message)
          // 落回普通回复
        }
      }

      memory.remember('qq', chatId, userId, 'user', memText, { isGroup })

      // 主人说的硬事实（10-27）：他吃了什么/在干什么/要去干什么 —— 落账以后就不许再问。
      // 只记私聊里主人本人的话（群友的话不是他的事）。
      try {
        const ownerQQ0 = String(config().owner?.qq || '')
        if (!isGroup && ownerQQ0 && String(userId) === ownerQQ0) {
          const got = ownerFacts.learnFromOwner(userText)
          if (got.length) log(`[qq] 📝 记下主人的事：${got.map((g) => g.key + '=' + g.value).join('，')}`)
          // 他说他吃了 → 她的饥饿直接落地（不然接下来两小时会一直问"你吃了吗"）
          if (/吃(了|过|的是)|刚吃|在吃|饭吃了/.test(String(userText))) {
            fed(20)
            log('[qq] 🍚 主人说他吃了 → 她的饥饿归到 20')
          }
        }
      } catch (e) { logErr('[qq] 记事实失败：' + (e?.message ?? e)) }

      // 生成回复（三段式 prompt + 走神注入）
      const turns = memory.recent(chatId).length
      const messages = buildMessages({ platform: 'qq', userText, chatId, userId, turnsToday: turns, isGroup, quote: quoteLine })
      messages[0].content += thinkingInstruction()
      // 时间锚点已经搬进 persona 的「【现在】」常驻层（10-25 重构，照 dsh-world 的 timeContext）：
      // 贴在最后一条消息上的临时提示一重写就丢，现在每轮都在 system 里。
      // 这里只保留事后兜底要用的真实间隔（sanitizeDayClaims 的口径）。
      // 群聊要按**这个群**的最后一条算（10-26）：拿主人的私聊间隔去校群里的"好久没见"，
      // 会把她对群友说的话按私聊时间线纠正，等于又混了一次通道。
      let gapFrom = lastOwnerMsgTs()
      if (isGroup) {
        try {
          const g = memory.lastByRole(chatId).lastUser
          if (g) gapFrom = g
        } catch {}
      }
      const ownerGapMs = Math.max(0, Date.now() - gapFrom)
      const gapTxt = gapText(ownerGapMs)
      // 表情包概率旋钮（10-25）：摇中就强制她带一个图 —— 不再靠她"想起来"写标记。
      // 图生图管够，每个都是新的；用户可在面板调 qq.stickerChance。
      const stickerChance = Number(QQ.stickerChance ?? 0.5)
      const diceWon = Math.random() < stickerChance
      if (diceWon) {
        messages[0].content += '\n\n【这条回复必须带一个图片表情】在正文句尾追加一个标记，二选一：'
          + `[表情:标签]（可用标签：${availableTags().join('/')}）或 [自制表情:八个字以内的短句]（会现场画一张新的）。只带一个，别解释。`
      }
      const answer = await llm.chat(messages)
      let out = guard.clean(answer, config())
      // 群聊认人硬保险（10-26）：prompt 已经写到"这一轮不许出现主人"，但 11:54 她还是照群友的要求
      // 说了"主人早上好"。prompt 是软的，嘴是她的 —— 所以这里在出稿后再拦一道。
      // 只拦"称呼用法"（addressesOwner），她在群里说"我只叫一个人主人"这种正确拒绝不许误伤。
      // 只拦群聊，私聊不受影响（私聊本来就该叫主人）。
      if (out && isGroup && String(userId) !== String(config().owner?.qq || '') && addressesOwner(out)) {
        log(`[qq] ⚠ 群里把「主人」叫给群友（QQ ${userId}）了：「${out.slice(0, 30)}」→ 让她重写`)
        try {
          const retry = messages.slice()
          retry[retry.length - 1] = {
            role: 'user',
            content: messages[messages.length - 1].content
              + `\n\n【重写】你刚才那句「${out.slice(0, 40)}」是在叫对方「主人」，但他只是群友（QQ ${userId}）。`
              + `重写这一条：一个字都不许出现"主人"。`,
          }
          const answer2 = await llm.chat(retry, { temperature: 0.8 })
          const out2 = guard.clean(answer2, config())
          if (out2) out = out2
        } catch (e) { logErr('[qq] 群聊重写失败：' + e.message) }
        if (addressesOwner(out)) {
          // 还是叫了：把称呼就地拆掉（只动"主人"这个词，其余保留）
          const fixed = out.replace(/(^|[，,。！!？?、\s])主人(?=$|[，,。！!？?、\s]|早|好|你|晚|再|睡|我|在)/g, '$1你')
            .replace(/(晚安|早安|早上好|谢谢|再见|你好)\s*主人/g, '$1你')
          log(`[qq] 仍旧叫主人 → 就地改掉：「${out.slice(0, 30)}」→「${fixed.slice(0, 30)}」`)
          out = fixed
        }
      }
      // 兜底：真间隔不到一天，话里还冒出"消失四天/好几天没影" → 先让她重写一次，再不行就地掰正
      if (out && ownerGapMs < 24 * 3600_000 && mentionsDays(out)) {
        log(`[qq] 回复里编了天数（真实间隔 ${gapTxt}）：「${out.slice(0, 30)}」→ 让她重写`)
        try {
          const retry = messages.slice()
          retry[retry.length - 1] = {
            role: 'user',
            content: messages[messages.length - 1].content
              + `\n\n【重写】你刚才那句「${out.slice(0, 40)}」里的天数是编的。真实是「${gapTxt}」。重写这一条，一个字都别出现"天"。`,
          }
          const answer2 = await llm.chat(retry, { temperature: 0.8 })
          const out2 = guard.clean(answer2, config())
          if (out2 && !mentionsDays(out2)) out = out2
        } catch (e) { logErr('[qq] 重写失败：' + e.message) }
        if (mentionsDays(out)) {
          const fixed = sanitizeDayClaims(out, ownerGapMs)
          if (fixed !== out) log(`[qq] 天数已掰正：「${out.slice(0, 34)}」→「${fixed.slice(0, 34)}」`)
          out = fixed
        }
      }
      if (!out) return

      // 承诺账本（10-27）：从她真正发出去的话里抽"这就去看/我答应/明天做"，落账带截止时间。
      // 只记私聊（群里答应的事不算对主人的承诺），且只在非干跑时记。
      try {
        const ownerQQ1 = String(config().owner?.qq || '')
        if (!isGroup && !config().guard?.dryRun && ownerQQ1 && String(userId) === ownerQQ1) {
          const got = promises.catchFromReply(out, { userText })
          if (got.length) log(`[qq] 📌 记下承诺：${got.map((g) => g.what).join('，')}（到点会真去做）`)
        }
      } catch (e) { logErr('[qq] 记承诺失败：' + (e?.message ?? e)) }
      // 标签本身绝不能发给主人 —— 这里就剥掉，同时把情绪记下来给语音用。
      const emoTagged = parseEmotionTag(out)
      const emotion = emoTagged.emotion
      if (emotion) {
        out = emoTagged.text
        log(`[qq] 🎭 情绪标签「${emotionProfile(emotion).label}」→ 语音按这个语气合成`)
        if (!out) return
      }

      // 表情：文字和 [表情:标签] 拆开发（NapCat 图片段）
      let { text: body, tag, caption } = splitSticker(out)
      // 摇中了要发图、但她没写标记 → 按她自己那句话的情绪自动挑一个（10-25：光靠模型自觉，
      // 17:01 之后七八条回复一张图都没发出去，这个功能等于废了）。
      if (diceWon && !tag && !caption) {
        const auto = autoTag(out)
        if (auto) {
          tag = auto
          log(`[qq] 🎲 摇中表情但她没写标记 → 按内容自动补「${auto}」`)
        }
      }
      const aiOn = config().imageGen?.enabled !== false
      let stickerFile = tag ? pickSticker(tag) : null
      if (!stickerFile && caption && !aiOn) stickerFile = ensureSelfSticker(caption, config())  // AI 关着才当场画文字贴纸
      if (diceWon) log(`[qq] 表情结果：${stickerFile ? '图库「' + tag + '」→' + path.basename(stickerFile) : caption ? 'AI「' + caption + '」待生成' : '没发出去'}`)
      const plain = body || (stickerFile ? '' : (FACE_FALLBACK[tag] || ''))
      // AI 表情包：图库没有这个标签 / 有自制表情文案 → 待异步生成（不卡回复主线）
      const aiWanted = aiOn && ((tag && !pickSticker(tag)) || (caption && !stickerFile))
      if (!plain && !stickerFile && !aiWanted) return

      // 干跑：只打印不真发（dafeiyu 铁律：第一周先观察）
      if (config().guard?.dryRun) {
        log(`[qq][干跑] ${isGroup ? '群' + groupId : '私聊' + userId} → ${plain}${stickerFile ? ' [表情图]' : ''}${aiWanted ? ` +AI表情「${tag || caption}」` : ''}`)
        memory.remember('qq', chatId, userId, 'assistant', plain || out, { isGroup })

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

      const target = isGroup
        ? { api: 'send_group_msg', key: 'group_id', id: Number(groupId) }
        : { api: 'send_private_msg', key: 'user_id', id: Number(userId) }
      // 语音 or 文字（语音失败一律降级文字，内容不丢）
      // 情绪化语音（10-26）：真人发语音从来不是一口气念完一整段 ——
      //   ①一条回复最多切 2 条语音、每条 ≤60 字（长段一次合成也天然更平）
      //   ②每条按她的情绪挑参考音色、多合几条挑最像人的那条（见 lib/tts.mjs 的 L0/L2）
      //   ③没念完的部分照常当文字补发，内容一点不丢
      let spokeParts = 0
      let restText = plain
      if (QQ.voice_enabled && plain && Math.random() < (Number(QQ.voice_chance) || 0.15)) {
        const plan = splitVoiceParts(plain, {
          maxChars: Number(QQ.voice_maxChars) || 60,
          maxParts: Number(QQ.voice_parts) || 2,
        })
        for (let i = 0; i < plan.parts.length; i++) {
          const line = plan.parts[i]
          if (!line) continue
          try {
            const audio = await synth(line, undefined, { emotion })
            const seg = { type: 'record', data: { file: audio } }   // NapCat 自动转 silk
            const okOne = await send(target.api, { [target.key]: target.id, message: [seg] })
            if (!okOne) break
            spokeParts += 1
            if (i + 1 < plan.parts.length) await new Promise(r => setTimeout(r, 500 + Math.random() * 700))
          } catch (e) {
            logErr(`[qq] 语音失败（剩下转文字）：${e.message}`)
            break
          }
        }
        if (spokeParts) {
          restText = plan.rest || ''
          log(`[qq] 已发 ${spokeParts} 条语音${emotion ? '（' + emotionProfile(emotion).label + '）' : ''}${restText ? '，剩余文字补发' : ''} → ${isGroup ? '群' + groupId : userId}`)
        }
      }
      if (!spokeParts) restText = plain
      if (restText) {
        // 像人一样分条发：一句一条，间隔几百毫秒到一秒多（不是机械固定）
        const bubbles = splitBubbles(restText)
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
      memory.remember('qq', chatId, userId, 'assistant', plain || out, { isGroup })

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
    // 群聊认人护栏自检（10-26）：启动就把三件套的状态打出来 —— 换了代码却忘了重启时，
    // 看这一行就知道跑的是哪一版，不用再猜"到底生效了没有"。
    log(`    群聊认人护栏：事实块 + 剔旧错话 + 出稿拦截 = 已启用（主人号 ${String(config().owner?.qq || '').slice(0, 3)}***）`)
    // 引用索引预热（10-27）：没有它，"他引用的是哪句"就只能回一句"我看不到"
    void (async () => {
      try {
        const li = await callApi('get_login_info', {}, 8000)
        if (li?.data?.user_id) selfIdCached = String(li.data.user_id)
        if (config().qq?.quote?.enabled !== false) {
          await warmQuoteIndex(50)
          setInterval(() => { void warmQuoteIndex(40) }, 10 * 60_000)
        }
      } catch (e) { logErr('[qq] 引用索引预热失败：' + (e?.message ?? e)) }
    })()
  })

  // ── 主动搭话引擎（B站同款自主性）：主人安静久了，带着由头主动开口 ──────────
  // 原则：随机拟人不定点；正聊着不打扰（minQuietMin）；深夜不打扰（activeHours）；
  //       每天有上限（dailyMax）；开口前情绪先漂移一次；发完即写记忆（推送即记忆）。
  const PROACT_FILE = dataPath('qq-proactive.json')
  let ownerLastMsgAt = 0
  let selfIdCached = String(QQ.self_id || '')     // 引用索引要用（启动时从 get_login_info 补上）
  const STARTED_AT = Date.now()
  const dayKeyNow = () => new Date().toLocaleDateString('sv-SE')

  /**
   * 跑一条自己的 CLI（= 她"自己动手"，10-27）。
   * 用宿主同一个 node（process.execPath），不用 shell，超时可控；
   * 失败只返回空串并记一行日志 —— 绝不让"没做成"变成谎话。
   */
  function runCli(args = [], timeoutMs = 180000) {
    try {
      const feiyu = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..', 'feiyu.mjs')
      const r = spawnSync(process.execPath, [feiyu, ...args], {
        encoding: 'utf8', timeout: timeoutMs, windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      })
      const out = String(r.stdout || '')
      if (r.status !== 0) {
        log(`[qq] 自跑 ${args[0]} 退出码 ${r.status}：${String(r.stderr || out).slice(0, 120)}`)
      }
      return out
    } catch (e) { logErr('[qq] 自跑失败：' + (e?.message ?? e)); return '' }
  }
  const readProact = () => { try { return JSON.parse(fs.readFileSync(PROACT_FILE, 'utf8')) } catch { return {} } }
  const writeProact = (st) => { try { fs.writeFileSync(PROACT_FILE, JSON.stringify(st)) } catch {} }

  /**
   * 「她今天在网上干了什么」—— 从 web-log.md 当天段落取**最新** n 条（10-27 修）。
   * 文件格式：`## 2026-10-27` 标题在上、新条目插在该段顶部（即最新在前）。
   * 老代码 `.split('\n').slice(-3)` 取的是文件最底部 = 最早那天的最早几条 ——
   * 于是整整两天，每条推送都在告诉她"你自己刚才在网上干的：搜南京小吃"，
   * 南京就从"她顺手搜过的一次"变成了"她的人设"。
   */
  function todayWebLines(n = 3) {
    try {
      const raw = fs.readFileSync(dataPath('web-log.md'), 'utf8')
      const today = dayKeyNow()
      const lines = raw.split('\n')
      const start = lines.findIndex((l) => l.trim() === `## ${today}`)
      if (start < 0) return []
      const body = []
      for (let i = start + 1; i < lines.length; i++) {
        const l = lines[i]
        if (/^##\s/.test(l)) break
        if (!l.trim()) continue
        body.push(l.replace(/^-\s*/, '').replace(/\*\*/g, '').slice(0, 46))
        if (body.length >= n) break
      }
      return body
    } catch { return [] }
  }

  // 10-25 修（用户抓到"两条差不多的抱怨"）：ownerLastMsgAt 只在内存里 → DSH 一重启就归零
  // → quietH 变成 99 → 她一律按"主人很久没理我"开口，编出"你消失四天了"（当时其实 13 分钟前刚聊过）。
  // 启动时从 QQ 记忆里把主人最后一条消息的真实时间捞回来。
  function seedOwnerLastMsgAt() {
    const ownerQQ = String(config().owner?.qq || '')
    // ⚠️ 10-26 修：原来只比对 userId，主人在**群里**说话也算"主人最后一条消息" ——
    // 结果他群里聊了一整天，她在私聊就永远判定"他刚跟我聊过"，主动搭话全被 quiet 门槛吃掉。
    // "多久没说话"只对私聊有意义，所以必须同时锁 chatId。
    const ownerChat = 'qq:' + ownerQQ
    try {
      const file = dataPath('qq', 'episodes.jsonl')
      const rows = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
      for (let i = rows.length - 1; i >= 0; i--) {
        const r = JSON.parse(rows[i])
        if (r && r.role === 'user' && String(r.chatId || '') === ownerChat
          && (!ownerQQ || String(r.userId || '') === ownerQQ) && r.isGroup !== true) {
          ownerLastMsgAt = Number(r.ts) || 0
          log(`[qq] 主人最后一条私聊消息：${new Date(ownerLastMsgAt).toLocaleString('zh-CN')}（从记忆恢复）`)
          return
        }
      }
    } catch {}
    // 记忆里翻不到 → 按"刚刚聊过"算：宁可不提时间，也不许编一个天数出来
    ownerLastMsgAt = Date.now()
    log('[qq] 记忆里没有主人的消息 → 按刚聊过处理（先不提"多久没见"）')
  }
  seedOwnerLastMsgAt()

  // 主人最后一条消息的时间（从 QQ 记忆尾部读）—— "多久没说话"的唯一可信来源。
  // 内存里的 ownerLastMsgAt 只在收到消息时更新过，重启就归零，不能当事实用。
  function lastOwnerMsgTs() {
    const ownerQQ = String(config().owner?.qq || '')
    // 同上：只认私聊。群里的"主人"发言不算"跟我说话"。
    const ownerChat = 'qq:' + ownerQQ
    try {
      const line = fs.readFileSync(dataPath('qq', 'episodes.jsonl'), 'utf8').trim().split('\n')
      for (let i = line.length - 1; i >= 0; i--) {
        const r = JSON.parse(line[i])
        if (r && r.role === 'user' && String(r.chatId || '') === ownerChat
          && (!ownerQQ || String(r.userId || '') === ownerQQ) && r.isGroup !== true) return Number(r.ts) || 0
      }
    } catch {}
    return 0
  }

  async function tryProactive() {
    try {
      const cfgNow = config()
      const pp = cfgNow.qq?.proactive ?? {}
      if (pp.enabled !== true) return
      // 启动宽限（10-25）：刚拉起来就"你很久没理我"纯属噪音 —— 重启当天连发三条同义句的教训
      if (Date.now() - STARTED_AT < Number(pp.startupGraceMin ?? 10) * 60_000) return
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
      const quietMs = Math.max(0, Date.now() - ownerLastMsgAt)
      const quietMin = Math.floor(quietMs / 60_000)
      const quietH = Math.floor(quietMs / 3600_000)
      const quietText = quietMin < 60 ? `${quietMin} 分钟` : `${quietH} 小时 ${quietMin % 60} 分`
      const nowText = new Date().toLocaleString('zh-CN', { hour12: false })
      // 素材钩子（10-25）：光给类型菜单 LLM 只会甩视频链接 —— 把她今天真实的经历、时段、情绪值
      // 和主人记忆喂进去，她才有"日常/思考/疑惑/心情"可说
      const hour = new Date().getHours()
      const slot = hour < 9 ? '早上' : hour < 12 ? '上午' : hour < 14 ? '午饭点' : hour < 18 ? '下午' : hour < 20 ? '傍晚' : hour < 23 ? '晚上' : '深夜'
      const moodNow = (() => { try { return JSON.parse(fs.readFileSync(dataPath('mood.json'), 'utf8')) } catch { return {} } })()
      const hooks = [`现在是${slot}${hour >= 11 && hour < 14 ? '（饭点，但**他已经说过吃了什么就别再问**）' : ''}`, `你的情绪值 ${Math.round(Number(moodNow.value) || 60)}（低于 40 就是低落）`]
      try {
        const rows = fs.readFileSync(dataPath('episodes.jsonl'), 'utf8').trim().split('\n').filter(Boolean)
          .map((l) => JSON.parse(l)).filter((r) => Date.now() - (r.ts || 0) < 86400_000 && ['bilibili', 'douyin'].includes(r.platform))
        if (rows.length) hooks.push('今天在外面：' + rows.slice(-3).map((r) => String(r.summary || r.text || '').slice(0, 28)).join('；'))
      } catch {}
      // 主人事实（10-27）：他今天已经说过的事 —— 有了这段，她才不会一天问十次"吃了没"
      {
        const known = ownerFacts.list()
        if (known.length) {
          const label = { food: '他吃了', doing: '他在做', plan: '他说要去', mood: '他的状态', media: '他提到的作品' }
          hooks.push('他已经说过的事（别再问第二遍）：' + known.slice(-4).map((x) => `${label[x.key] || x.key}${x.value}`).join('；'))
        }
      }
      {
        const fcts = memory.facts('owner')
        if (fcts.length) hooks.push('关于主人的记忆：' + fcts.slice(-2).join('；').slice(0, 90))
      }
      // 10-26：以前素材只有 B站/抖音，她翻来覆去就那几句（"肚子叫/桑拿鸡"连着说），
      // 大半草稿被去重拦掉，看着就像"主动性很弱"。把她自己在网上干的事也喂进去 —— 素材新鲜，话才不重。
      // ⚠️ 10-27 修：`web-log.md` 是**最新在上**（## 日期在文件头，新条目插在该段顶部），
      // 老代码 `.slice(-3)` 取到的是**文件最底部**=最早那天的条目 —— 于是连着两天每条推送都在说
      // "你自己刚才在网上干的：搜南京小吃"。现在按"今天的段落 + 取头部 3 条"来读。
      {
        const wl = todayWebLines(3)
        if (wl.length) hooks.push('你自己今天在网上干的：' + wl.join('；'))
      }
      try {
        const dg = fs.readFileSync(dataPath('diary-owner.md'), 'utf8').split('\n').filter(Boolean).slice(-1)[0]
        if (dg) hooks.push('你最近写给主人的日记里那句：' + dg.replace(/^[-#\s]+/, '').slice(0, 50))
      } catch {}
      try { const li = memory.loreInterests(1); if (li.length) hooks.push('最近挂在心上：' + String(li[0]).slice(0, 40)) } catch {}
      const lastProact = readProact()
      const lastType = String(lastProact.lastType || '')

      // ── 到点的承诺，先真去做（10-27）─────────────────────────────────────
      // 主人抓的病根："她说去看可塑性记忆，说了七次一次没看"。现在欠账到期就**当场执行**：
      // binge 搜不到 / 没字幕 → 记 fail 并照实说；看成了 → 用真实的剧情当这条推送的内容。
      // 这样她的"我看了"就不再是空话，而是有产出（剧情+感受）可讲。
      let didPromise = null
      try {
        const due = promises.dueNow()
        if (due.length) {
          const job = due[0]
          log(`[qq] 📌 到期承诺：${job.what}（${job.id}）→ 真去执行`)
          const what = String(job.what || '')
          let r = null
          if (/看|追|番|剧/.test(what) || /看|追/.test(String(job.text || ''))) {
            const shown = (what.match(/([一-龥A-Za-z0-9・·]{2,16}(?:记忆|物语|故事|之|传|记|番|剧))/)
              || String(job.text || '').match(/《([^》]{1,24})》/) || [])[1] || what.replace(/^看/, '')
            r = runCli(['binge', '--show', String(shown || what), '--ep', '1', '--go', '--json', '--promise', job.id], 240000)
            didPromise = { job, out: r }
          }
          if (!r) {
            promises.fail(job.id, '这条我没有能执行的动作')
            log(`[qq] ✗ 承诺做不了：${job.what}（没有对应的执行动作）`)
          }
        }
      } catch (e) { logErr('[qq] 执行承诺失败：' + (e?.message ?? e)) }
      const saidBefore = (Array.isArray(lastProact.recent) ? lastProact.recent : []).slice(-3)
        .map((x) => `「${String(x.text || '').slice(0, 24)}」`).join('、')
      const built = buildMessages({ platform: 'qq', userText: '', chatId: `qq:${ownerQQ}`, userId: ownerQQ, turnsToday: 0 })
      const quietHint = quietH >= 5 ? '（可以带一点点小委屈或调侃他，但别过头）' : ''
      // 刚真做完的承诺 → 这条推送就以它为由头（不是"想聊什么"，是"我真干了什么"）
      let didLine = ''
      if (didPromise?.out) {
        try {
          const raw = String(didPromise.out)
          const j = JSON.parse(raw.slice(raw.indexOf('{')).trim() || '{}')
          if (j?.ok) didLine = `你刚真的看完了《${j.title}》第 ${j.ep} 集：${String(j.plot || '').slice(0, 120)}（感受：${String(j.feel || '').slice(0, 60)}）`
          else didLine = `你刚试图看《${didPromise.job.what}》，但没成：${String(j?.via || j?.plot || '没有可用材料').slice(0, 80)} —— 这条推送要照实说做不到`
        } catch {}
      }
      const msgs = [
        built[0],
        { role: 'user', content: `【主动搭话】现在是 ${nowText}。主人最后一条消息是 ${quietText} 前。${quietHint}\n`
          + (didLine ? `**这条就用它当由头**：${didLine}\n` : '')
          + `**时间只准用这一句里的数字**：不许换算成"几天"，不许说"四天/好几天/整整几天"这种我没告诉你的数字${quietMin < 120 ? '；才两个钟头不到，别摆出"好久没见"的架势' : ''}。\n`
          + '**自己挑一个类型**（上次用过「' + (lastType || '无') + '」，这次换一个）：'
          + '①日常——你现在正在干嘛/看到什么随口说；②思考——最近琢磨的小念头；③疑惑——想问他的问题；'
          + '④心情——结合情绪值说现在的状态；⑤安利——甩视频链接。\n'
          + (saidBefore ? `你最近已经说过：${saidBefore} —— 别再重复同样的意思，换个由头。\n` : '')
          + (hooks.length ? '你手上的真实素材（自然地用，别照念）：\n- ' + hooks.join('\n- ') + '\n' : '')
          + '像真人发微信：一条，一两句话，自然具体。禁止"在吗/你好"式开场。只输出 JSON：{"type":"日常|思考|疑惑|心情|安利","text":"消息正文"}' },
      ]
      const resp = await llm.chat(msgs, { temperature: 0.95, max_tokens: 300 })
      let out = ''
      let usedType = '日常'
      try {
        const m = String(resp ?? '').match(/\{[\s\S]*\}/)
        if (m) {
          const j = JSON.parse(m[0])
          usedType = String(j.type || '日常').slice(0, 4)
          out = guard.clean(String(j.text || ''), cfgNow)
        } else out = guard.clean(String(resp ?? ''), cfgNow)
      } catch { out = guard.clean(String(resp ?? ''), cfgNow) }
      if (!out) return
      // ── 事实闸（10-27）────────────────────────────────────────────────
      // "你中午吃了没啊" 在主人 12:47 说过"吃了烧鸭"之后还问了 4 次。根子不是记性，
      // 是推送草稿没人核对事实。这里先把草稿对着「他今天已经说过的事」过一遍：
      //   ①先让她自己改一次（把答案写进去，别问）；②还问就这轮不发。
      {
        const known = ownerFacts.asksKnown(out)
        if (known) {
          log(`[qq] 🚧 草稿在问已经有答案的事（${known.key}=${known.value}）：「${out.slice(0, 30)}」→ 让她改`)
          try {
            const retry = msgs.slice()
            retry[retry.length - 1] = {
              role: 'user',
              content: msgs[msgs.length - 1].content
                + `\n\n【重写】他已经说过「${known.value}」了，你刚才那句还在问，等于没听人说话。`
                + `换成别的由头重写一条（不许再问吃没吃/在干嘛）。`,
            }
            const r2 = await llm.chat(retry, { temperature: 0.9, max_tokens: 300 })
            let out2 = ''
            try {
              const m2 = String(r2 ?? '').match(/\{[\s\S]*\}/)
              out2 = guard.clean(m2 ? String(JSON.parse(m2[0]).text || '') : String(r2 ?? ''), cfgNow)
            } catch { out2 = guard.clean(String(r2 ?? ''), cfgNow) }
            if (out2 && !ownerFacts.asksKnown(out2)) out = out2
            else { log('[qq] 改写后仍在问已知的事，这轮不发'); return }
          } catch (e) { logErr('[qq] 事实闸改写失败：' + e.message); return }
        }
      }
      // 主动搭话本来就是"主人多久没理我"最容易编出天数的场景，再加一道兜底
      if (mentionsDays(out)) {
        const fixed = sanitizeDayClaims(out, Date.now() - ownerLastMsgAt)
        if (fixed !== out) log(`[qq] 主动搭话的天数已掰正：「${out.slice(0, 30)}」→「${fixed.slice(0, 30)}」`)
        out = fixed
      }
      // 跨重启/跨措辞去重（10-25 用户抓的 bug）：状态里只记类型不记原文，于是
      // "你消失四天 / 整整四天 / 快四天" 三条同义句能连发。这里按 3-gram 相似度 + 同类冷却卡住。
      const hist = (Array.isArray(st.recent) ? st.recent : []).filter((x) => x && Date.now() - Number(x.at || 0) < 6 * 3600_000)
      const g1 = guard.grams(out)
      const typeCd = Number(pp.typeCooldownMin ?? 180)
      const clash = hist.find((x) => {
        if (typeCd > 0 && x.type === usedType && Date.now() - Number(x.at) < typeCd * 60_000) return true
        const g2 = guard.grams(String(x.text || ''))
        if (!g1.size || !g2.size) return false
        let inter = 0
        for (const g of g1) if (g2.has(g)) inter++
        return inter / (g1.size + g2.size - inter) > Number(pp.similarityMax ?? 0.25)
      })
      if (clash) {
        log(`[qq] 主动搭话草稿跟 ${Math.round((Date.now() - Number(clash.at)) / 60000)} 分钟前的「${String(clash.text || '').slice(0, 16)}…」撞了（同类/同义），这轮不发`)
        return
      }
      if (cfgNow.guard?.dryRun) { log(`[qq][干跑] 本要主动搭话：${out.slice(0, 50)}`); return }
      const ok = await send('send_private_msg', { user_id: Number(ownerQQ), message: [{ type: 'text', data: { text: out } }] })
      if (!ok) return
      // 主动搭话也带图（10-25）：这条路径以前**完全不发图**，主人那边"好久没见表情包"一半是这原因。
      if (Math.random() < Number(cfgNow.qq?.stickerChance ?? 0.5)) {
        const ptag = autoTag(out)
        const pfile = ptag ? pickSticker(ptag) : null
        if (pfile) {
          await new Promise(r => setTimeout(r, 400 + Math.random() * 700))
          try {
            const okImg = await send('send_private_msg', { user_id: Number(ownerQQ), message: [{ type: 'image', data: { file: 'file:///' + pfile.replace(/\\/g, '/') } }] })
            if (okImg) log(`[qq] 🐟 主动搭话带图：${ptag} → ${path.basename(pfile)}`)
          } catch (e) { logErr('[qq] 主动搭话补图失败：' + (e?.message ?? e)) }
        }
      }
      memory.remember('qq', `qq:${ownerQQ}`, ownerQQ, 'assistant', out, { kind: 'push' })   // 推送即记忆：她自己"说过"这句（kind=push 不占对话窗口）
      const st2 = readProact()
      const rec = (Array.isArray(st2.recent) ? st2.recent : []).slice(-7)
      rec.push({ at: Date.now(), type: usedType, text: String(out).slice(0, 60) })
      // 10-27：计数按**今天**算。老代码只把"跨天清零"写在内存变量里（`st = {...}`），
      // 落盘时又 `readProact()` 拿回昨天的 count 再加一 —— 于是 qq-proactive.json 是 73，
      // 而记忆里今天只有 32 条推送。现在同一天才算累加。
      const countToday = (st2.day === dayKeyNow() ? Number(st2.count ?? 0) : 0) + 1
      writeProact({ day: dayKeyNow(), count: countToday, lastAt: Date.now(), lastType: usedType, recent: rec })
      log(`[qq] 🐟 主动搭话（${usedType}）：${out.slice(0, 50)}`)
    } catch (e) { logErr('[qq] 主动搭话失败：' + e.message) }
  }
  setInterval(tryProactive, 60_000)

  // ── 群聊自主插话引擎（10-25）：不等 @，她看着群聊气氛自己决定要不要接话 ──────────
  // 原则：话题在场才开口（recentSec 内有人说话）+ 不抢话（minQuietSec）+ 概率 + 每群日额。
  // 开口前 LLM 看最近群聊自己判断适不适合说话 —— 没话找话宁可不说。
  const GC_FILE = dataPath('qq-groupchat.json')
  const groupLastMsgAt = {}   // gid -> 最近一条群消息时间（内存，重启归零无妨）
  function readJsonSafe(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return d } }
  function writeJsonSafe(f, v) { try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v)) } catch {} }
  let groupSpeak = readJsonSafe(GC_FILE, {})  // gid -> {day, count, lastAt}
  const writeGC = () => writeJsonSafe(GC_FILE, groupSpeak)

  async function tryGroupChat() {
    try {
      const QQ = config().qq ?? {}
      const gc = QQ.groupChat ?? {}
      if (gc.enabled !== true) return
      if (config().guard?.dryRun) return   // 干跑：群插话也不真发（10-25 统一闸门）
      const now = Date.now()
      const day = new Date().toLocaleDateString('sv-SE')
      const dailyMax = Number(gc.dailyMax ?? 6)
      for (const [gid, lastMsgAt] of Object.entries(groupLastMsgAt)) {
        const g = groupSpeak[gid] || { day, count: 0, lastAt: 0 }
        if (g.day !== day) { g.day = day; g.count = 0 }
        if (dailyMax > 0 && Number(g.count) >= dailyMax) continue
        if (now - Number(g.lastAt) < Number(gc.minGapMin ?? 20) * 60_000) continue
        const sinceMsg = now - Number(lastMsgAt)
        if (sinceMsg > Number(gc.recentSec ?? 600) * 1000) continue     // 话题已经凉了
        if (sinceMsg < Number(gc.minQuietSec ?? 20) * 1000) continue    // 别人话音未落，不抢
        if (Math.random() > Number(gc.chance ?? 0.1)) continue
        const chatId = `qq:${gid}`
        const recent = memory.recent(chatId, Number(gc.recentN ?? 14))
        if (recent.length < 2) continue
        tickMood()
        // ⚠️ 10-26 修：这里原来**没传 isGroup** —— 等于她用"私聊人设"决定要不要在群里插话：
        // 身份行给群友发主人通行证、时间锚点报"主人最后一次说话"、也没有末尾事实块。
        // 群里自主开口必须和被动回话用同一套群聊装配。
        const built = buildMessages({ platform: 'qq', userText: '', chatId, userId: '', turnsToday: Number(g.count), isGroup: true })
        const msgs = [
          built[0],
          { role: 'user', content: '【群聊插话决策】下面是这个群最近的聊天记录。你自己决定：现在适不适合插一句话？'
            + '正聊到你懂的/能接梗/有问题没人答/你能补充，才开口；插不上就安静。像熟群里的群友随口接一句，一两句以内。'
            + '只输出 JSON：{"speak":true或false,"text":"要发的话"}\n\n最近群聊：\n'
            + recent.map((m) => (m.role === 'assistant' ? '我' : '群友') + '：' + String(m.content).slice(0, 60)).join('\n') },
        ]
        const resp = await llm.chat(msgs, { temperature: 0.95, max_tokens: 200 })
        const m = String(resp ?? '').match(/\{[\s\S]*\}/)
        if (!m) continue
        let j; try { j = JSON.parse(m[0]) } catch { continue }
        if (!j.speak || !String(j.text || '').trim()) continue
        let out = guard.clean(String(j.text), config())
        if (!out) continue
        // 群里插话也要过"别把主人叫给群友"这一关（10-26）：这条路径不经过主流程的拦截。
        if (addressesOwner(out)) {
          const fixed = out.replace(/(^|[，,。！!？?、\s])主人(?=$|[，,。！!？?、\s]|早|好|你|晚|再|睡|我|在)/g, '$1你')
            .replace(/(晚安|早安|早上好|谢谢|再见|你好)\s*主人/g, '$1你')
          log(`[qq] 群插话里叫了主人 → 就地改掉：「${out.slice(0, 24)}」→「${fixed.slice(0, 24)}」`)
          if (addressesOwner(fixed)) continue
          out = fixed
        }
        const verdict = guard.allow(chatId, out, config(), { checkDryRun: false })   // 间隔 + 复读去重（干跑已在上游拦）
        if (!verdict.ok) continue
        const ok = await send('send_group_msg', { group_id: Number(gid), message: [{ type: 'text', data: { text: out } }] })
        if (!ok) continue
        guard.commit(chatId, out)
        memory.remember('qq', chatId, config().identity?.name ?? 'feiyu', 'assistant', out, { isGroup: true })   // 推送即记忆
        groupSpeak[gid] = { day, count: Number(g.count) + 1, lastAt: now }
        writeGC()
        log(`[qq] 🗣️ 群${gid} 自主插话：${out.slice(0, 40)}`)
      }
    } catch (e) { logErr('[qq] 群聊插话失败：' + (e?.message ?? e)) }
  }
  setInterval(tryGroupChat, 60_000)

  // ── 自主写说说引擎（10-25）：她自己的见闻+心情 → 攒着劲发一条 QQ 空间说说（可文配图）──
  // 内容从她的世界来（人设+世界块+情绪），图是她的鲸鱼娘图生图 —— 说说像她，不像模板。
  const QZ_FILE = dataPath('qq-qzone.json')
  async function tryQzone() {
    try {
      const QQ = config().qq ?? {}
      const auto = QQ.qzoneAuto ?? {}
      if (QQ.qzone_enabled === false || auto.enabled !== true) return
      if (config().guard?.dryRun) return   // 干跑：空间说说也不真发（10-25 统一闸门）
      const now = Date.now()
      const day = new Date().toLocaleDateString('sv-SE')
      const st = readJsonSafe(QZ_FILE, { day: '', count: 0, lastAt: 0 })
      if (st.day !== day) { st.day = day; st.count = 0 }
      const dailyMax = Number(auto.dailyMax ?? 2)
      if (dailyMax > 0 && Number(st.count) >= dailyMax) return
      if (now - Number(st.lastAt ?? 0) < Number(auto.minGapMin ?? 240) * 60_000) return
      if (Math.random() > Number(auto.chance ?? 0.15)) return
      tickMood()
      const built = buildMessages({ platform: 'qq', userText: '', chatId: 'qq:qzone-self', userId: String(config().owner?.qq || ''), turnsToday: Number(st.count) })
      const msgs = [
        built[0],
        { role: 'user', content: '【发说说】现在以你的名义发一条 QQ 空间说说。基于你最近在外面看到的/今天的心情/最近琢磨的小念头，随手一条：'
          + '60~120 字，口语、真实、像发朋友圈，不要话题标签不要 @ 不要称呼主人。可以就是一句碎碎念，也可以带一点小情绪。只输出说说正文。' },
      ]
      const resp = await llm.chat(msgs, { temperature: 0.95, max_tokens: 300 })
      const text = guard.clean(String(resp ?? ''), config())
      if (!text || text.length < 8) return
      // 配图：按概率画一张贴题的鲸鱼娘表情包（图生图）
      let images = null
      try {
        if (Math.random() < Number(auto.imageChance ?? 0.5)) {
          const caption = String(text).replace(/[，。！？…~～\s]+/g, ' ').trim().split(' ').filter(Boolean).slice(0, 2).join(' ').slice(0, 12) || '今天的心情'
          const { generateStickerImage } = await import('../lib/imggen.mjs')
          const img = await generateStickerImage(caption, {})
          if (img) images = ['file:///' + String(img).replace(/\\/g, '/')]
        }
      } catch {}
      const NAPCAT = (QQ.napcat_http || 'http://127.0.0.1:3000').replace(/\/+$/, '')
      const post = async (body) => fetch(`${NAPCAT}/send_qzone_msg`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(60000),
      })
      let r = await post(images ? { content: text, images, ugc_right: 1 } : { content: text, ugc_right: 1 })
      let j = null; try { j = await r.json() } catch {}
      if ((!r.ok || j?.status === 'failed') && images) {
        log(`[qzone] 配图说说没成（${JSON.stringify(j ?? r.status).slice(0, 80)}），退回纯文字`)
        r = await post({ content: text, ugc_right: 1 })
        j = null; try { j = await r.json() } catch {}
        images = null
      }
      if (!r.ok || j?.status === 'failed') { log(`[qzone] 说说失败：${JSON.stringify(j ?? r.status).slice(0, 120)}`); return }
      st.count = Number(st.count) + 1; st.lastAt = now
      writeJsonSafe(QZ_FILE, st)
      memory.remember('qq', 'qq:qzone-self', config().identity?.name ?? 'feiyu', 'assistant', `（发了说说：${String(text).slice(0, 60)}${images ? ' [配图]' : ''}）`)
      log(`[qzone] ✍️ 说说已发布${images ? '（配图）' : ''}：${String(text).slice(0, 40)}`)
    } catch (e) { logErr('[qzone] 自主说说失败：' + (e?.message ?? e)) }
  }
  setInterval(tryQzone, 30 * 60_000)
}
