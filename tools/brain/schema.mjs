// brain/schema —— O6 图式：把"反复出现的事"归纳成一条规律。
//
// 铁律（防过拟合）：**满 30 天、同 (主语,谓词) 至少 5 条**才允许归纳；
// 不到门槛就返回空，一个字都不写。文本是规则生成的（不烧 LLM），举例只取最近 3 条。
//
// 存 sem/schemata.json，**派生数据**：删了能重建，不参与任何"事实真值"判断。
import { readJson, mutateJson } from './json.mjs'
import { semDir } from './paths.mjs'
import path from 'node:path'
import { all as allFacts, P_LABEL } from './facts.mjs'

export const GATE = { minSpanDays: 30, minHits: 5 }
const file = () => path.join(semDir(), 'schemata.json')

const DAY = 86400_000

function spanDaysOf(rows) {
  const at = rows.map((r) => Number(r.valid?.from || r.createdAt || 0)).filter(Boolean).sort((a, b) => a - b)
  if (at.length < 2) return 0
  return Math.round((at.at(-1) - at[0]) / DAY)
}

/**
 * 归纳一遍并写盘。返回 {items, built, skipped}。
 * @param {{minSpanDays?:number, minHits?:number, now?:number, write?:boolean}} o
 */
export function build({ minSpanDays = GATE.minSpanDays, minHits = GATE.minHits, now = Date.now(), write = true } = {}) {
  // 规律要看**历史**，不能只看还在有效期内的事实（"他吃过烧鸭"昨天就过期了，但那次是真实发生过的）
  const rows = allFacts().filter((f) => f.status !== 'superseded' && f.status !== 'disputed')
  const groups = new Map()
  for (const f of rows) {
    const key = `${f.s}|${f.p}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(f)
  }
  const items = []
  let skipped = 0
  for (const [key, list] of groups) {
    const [s, p] = key.split('|')
    const span = spanDaysOf(list)
    if (list.length < minHits || span < minSpanDays) { skipped++; continue }
    const samples = list
      .slice()
      .sort((a, b) => Number(b.valid?.from || 0) - Number(a.valid?.from || 0))
      .slice(0, 3)
      .map((f) => String(f.o || '').slice(0, 40))
    const label = P_LABEL[p] || p
    items.push({
      id: `sc-${s}-${p}`.replace(/[^\w-]/g, '_').slice(0, 60),
      s, p, hits: list.length, spanDays: span,
      first: Number(list[0]?.valid?.from || 0),
      last: Math.max(...list.map((f) => Number(f.valid?.from || 0))),
      samples,
      text: `${label}：${span} 天里出现 ${list.length} 次（${samples.join('、')}）`,
      builtAt: now,
    })
  }
  items.sort((a, b) => b.hits - a.hits)
  if (write) mutateJson(file(), { items: [] }, () => ({ items, builtAt: now, gate: { minSpanDays, minHits } }))
  return { items, built: items.length, skipped }
}

export function all() {
  return (readJson(file(), { items: [] }).items) || []
}

/** 提示词块（≤2 条，最多 160 字）：只有真到门槛的规律才配出现在她脑子里。 */
export function promptBlock({ limit = 2 } = {}) {
  const items = all().slice(0, limit)
  if (!items.length) return ''
  return '【你摸出来的规律】（不是道听途说，是你自己数出来的）\n' + items.map((x) => `· ${x.text}`).join('\n')
}

export function stats() {
  const d = readJson(file(), { items: [] })
  return { total: (d.items || []).length, builtAt: d.builtAt || 0, gate: d.gate || GATE }
}