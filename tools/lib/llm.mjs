// LLM 直连客户端 —— 移植 dafeiyu brain/llm.py（requests → fetch）。
// QQ/抖音的实时响应用：直连 DeepSeek API（OpenAI 兼容），按 token 计费。
// 与 B站那套「塞回 DSH 会话」是两条路：那边零费但慢，这边快但按量付费。
import { config } from './config.mjs'

const _cfg = () => config().llm ?? {}

/** API key：环境变量优先（DEEPSEEK_API_KEY / LLM_API_KEY），再读配置文件。 */
export const apiKey = () => process.env.DEEPSEEK_API_KEY || process.env.LLM_API_KEY || _cfg().api_key || ''

function endpoint() {
  return (_cfg().base_url || 'https://api.deepseek.com/v1').replace(/\/+$/, '') + '/chat/completions'
}

function headers() {
  return {
    'Authorization': `Bearer ${apiKey()}`,
    'Content-Type': 'application/json',
  }
}

function payload(messages, opts = {}) {
  const c = _cfg()
  return {
    model: opts.model || c.model || 'deepseek-chat',
    messages,
    temperature: opts.temperature ?? (c.temperature ?? 0.92),
    max_tokens: opts.max_tokens || c.max_tokens || 600,
    presence_penalty: 0.3,     // 防复读
    frequency_penalty: 0.2,
    stream: opts.stream === true,
  }
}

/** 一次性拿全文。 */
export async function chat(messages, opts = {}) {
  const r = await fetch(endpoint(), {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(payload(messages, opts)),
    signal: AbortSignal.timeout(90000),
  })
  if (!r.ok) throw new Error(`LLM HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`)
  const j = await r.json()
  return (j.choices?.[0]?.message?.content ?? '').trim()
}

/** 流式：边收边吐增量文本（思考链外显 / 分句发送）。 */
export async function* chatStream(messages, opts = {}) {
  const r = await fetch(endpoint(), {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(payload(messages, { ...opts, stream: true })),
    signal: AbortSignal.timeout(120000),
  })
  if (!r.ok) throw new Error(`LLM HTTP ${r.status}`)
  const reader = r.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (!line.startsWith('data: ')) continue
      const data = line.slice(6)
      if (data === '[DONE]') return
      try {
        const delta = JSON.parse(data).choices?.[0]?.delta?.content
        if (delta) yield delta
      } catch { /* 忽略坏帧 */ }
    }
  }
}

/** 要求模型只回 JSON（用于写脚本/文案）。 */
export async function jsonChat(messages, schemaHint, opts = {}) {
  const sys = { role: 'system', content: '你只输出合法 JSON，不要 markdown 代码块，不要任何解释。\n字段结构：' + schemaHint }
  let raw = await chat([sys, ...messages], opts)
  raw = raw.trim().replace(/^```json\s*/i, '').replace(/^```/, '').replace(/```$/, '').trim()
  return JSON.parse(raw)
}
