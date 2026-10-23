// qq-server —— QQ 常驻聊天服务：接收 NapCat OneBot v11 上报 → 直连 LLM 秒回。
// 群聊被 @ 才回（at_only 铁律），私聊都回；支持语音条（GPT-SoVITS + record 段，NapCat 自动转 silk）。
// 无第三方依赖，node 内置 http 即可。
//
//   node feiyu.mjs qq-server [port]     # 默认 8080
//   NapCat WebUI → 网络配置 → 新建 HTTP 服务器(3000) + HTTP 上报 → http://127.0.0.1:8080/onebot
//   上报格式 messagePostFormat 选 array
import http from 'node:http'
import { config } from '../lib/config.mjs'
import * as guard from '../lib/guard.mjs'
import * as memory from '../lib/memory.mjs'
import * as llm from '../lib/llm.mjs'
import { buildMessages, thinkingInstruction } from '../lib/persona.mjs'
import { synth } from '../lib/tts.mjs'

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
  if (!QQ.enabled) { console.error('✗ qq.enabled=false —— 先在 feiyu.config.json 开 qq.enabled'); process.exit(1) }
  if (!llm.apiKey()) { console.error('✗ 没有 LLM API key（设环境变量 DEEPSEEK_API_KEY，或填 llm.api_key）'); process.exit(1) }
  const NAPCAT = (QQ.napcat_http || 'http://127.0.0.1:3000').replace(/\/+$/, '')
  const port = Number(argv[0]) || 8080

  const send = async (action, payload) => {
    try {
      const r = await fetch(`${NAPCAT}/${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        signal: AbortSignal.timeout(20000),
      })
      if (!r.ok) console.error(`[qq] 回发失败 ${action}: HTTP ${r.status}`)
      return r.ok
    } catch (e) { console.error(`[qq] 回发异常 ${action}: ${e.message}`); return false }
  }

  const handle = async (evt) => {
    try {
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
      const userText = text.replace(new RegExp(`@?${selfId}\\s*`), '').trim()
      if (!userText) return

      memory.remember('qq', chatId, userId, 'user', userText)

      // 生成回复（三段式 prompt + 走神注入）
      const turns = memory.recent(chatId).length
      const messages = buildMessages({ platform: 'qq', userText, chatId, userId, turnsToday: turns })
      messages[0].content += thinkingInstruction()
      const answer = await llm.chat(messages)
      const out = guard.clean(answer, config())
      if (!out) return

      // 干跑：只打印不真发（dafeiyu 铁律：第一周先观察）
      if (config().guard?.dryRun) {
        console.log(`[qq][干跑] ${isGroup ? '群' + groupId : '私聊' + userId} → ${out}`)
        memory.remember('qq', chatId, userId, 'assistant', out)
        return
      }

      // 真发前：间隔 + 去重（跳过 dryRun，上面已单独处理）
      const verdict = guard.allow(chatId, out, config(), { checkDryRun: false })
      if (!verdict.ok) { console.error(`[qq] 拦下：${verdict.why}`); return }
      guard.commit(chatId, out)

      // 语音 or 文字（语音失败一律降级文字，内容不丢）
      let sent = false
      if (QQ.voice_enabled && Math.random() < (Number(QQ.voice_chance) || 0.15)) {
        try {
          const audio = await synth(out)
          const seg = { type: 'record', data: { file: audio } }   // NapCat 自动转 silk
          sent = isGroup
            ? await send('send_group_msg', { group_id: Number(groupId), message: [seg] })
            : await send('send_private_msg', { user_id: Number(userId), message: [seg] })
          if (sent) console.log(`[qq] 已发语音 → ${isGroup ? '群' + groupId : userId}`)
        } catch (e) {
          console.error(`[qq] 语音失败，降级文字：${e.message}`)
          sent = false
        }
      }
      if (!sent) {
        sent = isGroup
          ? await send('send_group_msg', { group_id: Number(groupId), message: [{ type: 'text', data: { text: out } }] })
          : await send('send_private_msg', { user_id: Number(userId), message: [{ type: 'text', data: { text: out } }] })
      }
      memory.remember('qq', chatId, userId, 'assistant', out)
    } catch (e) {
      console.error('[qq] 处理失败：', e.message)
    }
  }

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
        } catch (e) { console.error('[qq] 事件解析失败：', e.message) }
      })
      return
    }
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, dryRun: !!config().guard?.dryRun, ...memory.stats() }))
      return
    }
    res.writeHead(404); res.end()
  })

  server.listen(port, '127.0.0.1', () => {
    console.log(`[qq] 监听 http://127.0.0.1:${port}/onebot`)
    console.log(`    NapCat WebUI → 网络配置 → HTTP 上报 → http://127.0.0.1:${port}/onebot（messagePostFormat=array）`)
    console.log(`    dryRun=${!!config().guard?.dryRun} · at_only=${QQ.at_only !== false} · voice=${!!QQ.voice_enabled} · napcat=${NAPCAT}`)
  })
}
