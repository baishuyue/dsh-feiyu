// jsontext —— 从模型嘴里捞 JSON（10-28 从 produce.mjs 提出来，看番/策划共用）
//
// 为什么要单独成库：她的模型（deepseek-v4.1-flash）经常在 JSON 字符串里直接塞未转义的
// 英文双引号 —— 比如 `"plot":"他说"别走"，然后…"`，一个字符坏掉，整条材料就废了。
// 实测：可塑性记忆第 2 集那次就是 position 81 报 "Expected ',' or '}'"，
// 结果这一集被判成"看不到剧情"。所以这里两手：
//   ① extractJson：先按"花括号配平 + 认字符串"切出候选，能 parse 就返回；
//   ② salvageFields：实在坏了，就按 key 锚定把 plot/feel 抠出来（对内部引号免疫）。

/** 从任意文本里切出第一个能 parse 的 JSON 对象。切不出就抛。 */
export function extractJson(text) {
  const s = String(text ?? '')
  const cands = []
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) cands.push(fence[1].trim())
  cands.push(s.trim())
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '{') continue
    let depth = 0
    let inStr = false
    let esc = false
    for (let k = i; k < s.length; k++) {
      const c = s[k]
      if (inStr) {
        if (esc) esc = false
        else if (c === '\\') esc = true
        else if (c === '"') inStr = false
        continue
      }
      if (c === '"') { inStr = true; continue }
      if (c === '{') depth++
      else if (c === '}') {
        depth--
        if (depth === 0) { cands.push(s.slice(i, k + 1)); i = k; break }
      }
    }
  }
  for (const c of cands) {
    try {
      const o = JSON.parse(c)
      if (o && typeof o === 'object' && !Array.isArray(o)) return o
    } catch { /* 换下一个候选 */ }
  }
  throw new Error('JSON 解析失败')
}

/**
 * 坏 JSON 的兜底：按 `"key":"…"` 锚定取值（值里再出现双引号也不影响，
 * 因为尾巴是靠"下一个 key 或右花括号"认定的）。
 * @param {string} text 模型原话
 * @param {string[]} keys 要抠的字段名
 * @returns {Record<string,string>} 抠到的字段
 */
export function salvageFields(text, keys = []) {
  const s = String(text ?? '')
  const out = {}
  for (const k of keys) {
    const re = new RegExp(`"${k}"\\s*:\\s*"([\\s\\S]*?)"\\s*(?:,\\s*"[A-Za-z_]+"\\s*:|\\s*\\})`)
    const m = re.exec(s)
    if (m) out[k] = m[1].replace(/\\"/g, '"').replace(/\\n/g, '\n').trim()
  }
  const b = /"understood"\s*:\s*(true|false)/.exec(s)
  if (b) out.understood = b[1] === 'true'
  return out
}