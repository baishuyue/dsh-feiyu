// LLM 直连客户端 —— 移植 dafeiyu brain/llm.py（requests → fetch）。
// QQ/抖音的实时响应用：直连 OpenAI 兼容端点，按 token 计费。
// 与 B站那套「塞回 DSH 会话」是两条路：那边零费但慢，这边快但按量付费。
//
// 双通道（10-26）：主通道挂了/额度没了，自动落到 llm.fallback（换一家供应商的 key）。
// 这样换平台不用改代码，也不会因为某一家 429 就整晚不吭声。
import { config } from './config.mjs'

const _cfg = () => config().llm ?? {}
const _fb = () => _cfg().fallback ?? {}

/** API key：环境变量优先（DEEPSEEK_API_KEY / LLM_API_KEY），再读配置文件。 */
export const apiKey = () => process.env.DEEPSEEK_API_KEY || process.env.LLM_API_KEY || _cfg().api_key || ''

/** 当前主通道的简述（日志/面板用）。 */
export function describe() {
  const c = _cfg()
  const f = _fb()
  return `${c.model || 'deepseek-chat'} @ ${(c.base_url || 'https://api.deepseek.com/v1').replace(/^https?:\/\//, '')}`
    + (f.model ? `（备：${f.model} @ ${String(f.base_url || '').replace(/^https?:\/\//, '')}）` : '')
}

function endpointOf(c) {
  return (c.base_url || 'https://api.deepseek.com/v1').replace(/\/+$/, '') + '/chat/completions'
}
function endpoint() {
  return endpointOf(_cfg())
}

function headersOf(c) {
  return {
    'Authorization': `Bearer ${c.api_key || apiKey()}`,
    'Content-Type': 'application/json',
  }
}
function headers() {
  return headersOf({ ..._cfg(), api_key: apiKey() })
}

function payloadOf(c, messages, opts = {}) {
  return {
    model: opts.model || c.model || 'deepseek-chat',
    messages,
    temperature: opts.temperature ?? (c.temperature ?? 0.92),
    max_tokens: opts.max_tokens || c.max_tokens || 600,
    presence_penalty: 0.3,     // 防复读
    frequency_penalty: 0.2,
    stream: opts.stream === true,
    // 供应商私有参数（10-26）：如千问系的 { enable_thinking: false }。
    // 实测开了思考链，同一段人格 prompt 要 14s；关掉 1.4s —— 陪聊场景必须关。
    ...(c.params || {}),
    ...(opts.params || {}),
  }
}
function payload(messages, opts = {}) {
  return payloadOf(_cfg(), messages, opts)
}

/** 一次性拿全文。主通道失败自动换 fallback（除非 opts.noFallback）。 */
export async function chat(messages, opts = {}) {
  const main = _cfg()
  const fb = _fb()
  const tryOne = async (c) => {
    const r = await fetch(endpointOf(c), {
      method: 'POST',
      headers: headersOf({ ...c, api_key: c.api_key || apiKey() }),
      body: JSON.stringify(payloadOf(c, messages, opts)),
      signal: AbortSignal.timeout(opts.timeoutMs || 90000),
    })
    if (!r.ok) throw new Error(`LLM HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`)
    const j = await r.json()
    const out = (j.choices?.[0]?.message?.content ?? '').trim()
    if (!out) throw new Error('LLM 返回空内容')
    return out
  }
  try {
    return await tryOne(main)
  } catch (e) {
    if (opts.noFallback || !fb.model || !(fb.api_key || fb.base_url)) throw e
    try {
      // 备通道有自己的私有参数体系，别把主通道的 params 带过去（DeepSeek 官方不认 enable_thinking）
      const out = await tryOne({ ...main, ...fb, params: fb.params ?? {} })
      try { (await import('node:fs')).appendFileSync((await import('./paths.mjs')).dataPath('llm-fallback.log'), `${new Date().toISOString()} 主通道失败(${String(e.message).slice(0, 80)}) → 已用备通道\n`) } catch {}
      return out
    } catch (e2) {
      throw new Error(`主通道失败（${String(e.message).slice(0, 90)}）；备通道也失败（${String(e2.message).slice(0, 90)}）`)
    }
  }
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
