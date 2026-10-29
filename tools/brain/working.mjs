// brain/working —— 工作记忆：7 个槽 + 抑制列表（v3 O3）。
//
// 旧的 `memory.recent(chatId, 24)` 是"最近 24 条"，实测只有 2.9 小时 ——
// 既没有容量上限，也没有"这件事现在别提"的表达能力，于是她要么忘，要么复读。
//
// 7 槽（每槽有预算，超了先砍 S4/S5）：
//   S1 当前意图  S2 话题锚点  S3 情绪  S4/S5 召回  S6 待办  S7 未完话头
//   + suppressed: 本轮明确不许提的主题（抑制，不是删除）
import { readJson, mutateJson } from './json.mjs'
import { workingPath } from './paths.mjs'
import { relTime } from './clock.mjs'

export const SLOTS = ['intent', 'topic', 'mood', 'recallA', 'recallB', 'todo', 'unfinished']
const BUDGET = { intent: 120, topic: 80, mood: 60, recallA: 220, recallB: 220, todo: 120, unfinished: 120 }

const empty = () => ({ slots: {}, suppressed: [], updatedAt: 0 })

export function load(chatId) {
  const j = readJson(workingPath(chatId), null)
  if (!j || typeof j !== 'object') return empty()
  return { ...empty(), ...j, slots: { ...(j.slots || {}) }, suppressed: Array.isArray(j.suppressed) ? j.suppressed : [] }
}

export function save(chatId, state) {
  return mutateJson(workingPath(chatId), empty(), () => ({ ...state, updatedAt: Date.now() }))
}

/** 写一组槽（undefined 的槽保持原样）。 */
export function refresh(chatId, patch = {}) {
  const cur = load(chatId)
  for (const k of SLOTS) {
    if (patch[k] === undefined) continue
    const v = String(patch[k] ?? '').trim()
    if (!v) delete cur.slots[k]
    else cur.slots[k] = v.slice(0, BUDGET[k])
  }
  return save(chatId, cur)
}

/** 抑制一个主题（"南京菜单别再提了"），到期自动解除。 */
export function suppress(chatId, topic, minutes = 30) {
  const t = String(topic || '').trim()
  if (!t) return load(chatId)
  const cur = load(chatId)
  cur.suppressed = (cur.suppressed || []).filter((x) => x && x.until > Date.now())
  const hit = cur.suppressed.find((x) => x.topic === t)
  if (hit) hit.until = Date.now() + minutes * 60_000
  else cur.suppressed.push({ topic: t, until: Date.now() + minutes * 60_000 })
  return save(chatId, cur)
}

export function isSuppressed(chatId, text, now = Date.now()) {
  const cur = load(chatId)
  return (cur.suppressed || []).some((x) => x && x.until > now && String(text || '').includes(x.topic))
}

export function aliveSuppressed(chatId, now = Date.now()) {
  const cur = load(chatId)
  return (cur.suppressed || []).filter((x) => x && x.until > now)
}

/** 渲染成提示词里的一块（≤1000 字）。 */
export function render(chatId, now = Date.now()) {
  const cur = load(chatId)
  const lines = []
  const push = (key, label) => {
    const v = cur.slots[key]
    if (v) lines.push(`${label}：${v}`)
  }
  push('intent', '现在最要紧的')
  push('topic', '正在聊')
  push('mood', '心情')
  push('recallA', '你想起来的')
  push('recallB', '还有')
  push('todo', '待办')
  push('unfinished', '没说完的话头')
  const sup = (cur.suppressed || []).filter((x) => x && x.until > now)
  let out = lines.join('\n')
  if (sup.length) out += `\n（这轮先别主动提：${sup.map((x) => x.topic).join('、')}）`
  return out.slice(0, 1000)
}