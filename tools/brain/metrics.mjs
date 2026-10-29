// brain/metrics —— 每日滚动指标（v3 §15）。
//
// 为什么要它：上一版方案最大的毛病是"验收全靠嘴"。prompt 字数、召回耗时、
// 意图积压、被截断的槽位、拒收的微信事件，全都要有数，doctor 才有东西可打印。
import { readJson, writeJsonAtomic } from './json.mjs'
import { metricsPath } from './paths.mjs'
import { dayKey } from './clock.mjs'

const empty = () => ({ days: {} })

function load() {
  const j = readJson(metricsPath(), null)
  if (!j || typeof j !== 'object' || !j.days) return empty()
  return j
}

export function bump(key, n = 1) {
  const j = load()
  const day = dayKey()
  if (!j.days[day]) j.days[day] = {}
  j.days[day][key] = Number(j.days[day][key] || 0) + Number(n)
  prune(j)
  try { writeJsonAtomic(metricsPath(), j) } catch {}
  return j.days[day][key]
}

export function setValue(key, value) {
  const j = load()
  const day = dayKey()
  if (!j.days[day]) j.days[day] = {}
  j.days[day][key] = value
  prune(j)
  try { writeJsonAtomic(metricsPath(), j) } catch {}
  return value
}

export function today() {
  return load().days[dayKey()] || {}
}

export function read(day = dayKey()) {
  return load().days[day] || {}
}

export function snapshot() {
  const j = load()
  const days = Object.keys(j.days).sort()
  const out = { days: {}, last30: {} }
  for (const d of days.slice(-30)) out.days[d] = j.days[d]
  const sums = {}
  for (const d of days.slice(-30)) {
    for (const [k, v] of Object.entries(j.days[d])) {
      if (typeof v !== 'number') continue
      sums[k] = (sums[k] || 0) + v
    }
  }
  out.last30 = sums
  return out
}

function prune(j) {
  const keys = Object.keys(j.days).sort()
  if (keys.length <= 90) return
  for (const k of keys.slice(0, keys.length - 90)) delete j.days[k]
}