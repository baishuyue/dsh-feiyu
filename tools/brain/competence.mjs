// brain/competence —— O13 能力自评：她"到底擅长什么"，靠自己的账本数出来。
//
// 门槛：同一类事**成功 ≥3 次**才写进能力表（做一次就自夸是吹牛）。
// 数据来源只有两处：intents 的 done/failed（带证据）与 delivery 的送达记录。
// 存 sem/competence.json，纯派生：删了能重建。
import { readJson, mutateJson } from './json.mjs'
import { semDir } from './paths.mjs'
import path from 'node:path'
import { all as allIntents } from './intents.mjs'

const file = () => path.join(semDir(), 'competence.json')
export const GATE = { minWins: 3, windowDays: 90 }

const SKILLS = [
  { key: 'watch', re: /看|追|番|剧|集/, label: '看番/追剧' },
  { key: 'make', re: /剪|做|生成|画|唱|配音|合成/, label: '做视频/出图' },
  { key: 'write', re: /写|代码|脚本|文档|总结|复盘/, label: '写东西/写代码' },
  { key: 'send', re: /发|推送|转告|通知/, label: '发消息/送达' },
  { key: 'reply', re: /回|答|解释/, label: '回话/解释' },
]

export function derive({ minWins = GATE.minWins, windowDays = GATE.windowDays, now = Date.now(), write = true } = {}) {
  const from = now - windowDays * 86400_000
  const rows = allIntents().filter((x) => Number(x.updatedAt || x.createdAt || 0) >= from)
  const by = new Map()
  for (const x of rows) {
    const text = `${x.object || ''} ${(x.verifyState?.evidence || []).join(' ')}`
    const hit = SKILLS.find((s) => s.re.test(text))
    const key = hit?.key || 'other'
    if (!by.has(key)) by.set(key, { key, label: hit?.label || '其它', ok: 0, fail: 0, sample: [], lastAt: 0 })
    const g = by.get(key)
    if (x.state === 'done' && (x.verifyState?.evidence || []).length) {
      g.ok++
      if (g.sample.length < 2) g.sample.push(String(x.object || '').slice(0, 24))
      g.lastAt = Math.max(g.lastAt, Number(x.doneAt || 0))
    } else if (x.state === 'failed' || x.state === 'missed') {
      g.fail++
    }
  }
  const items = [...by.values()]
    .filter((g) => g.ok >= minWins)
    .map((g) => ({
      ...g,
      rate: Number((g.ok / Math.max(1, g.ok + g.fail)).toFixed(2)),
      text: `${g.label}：成了 ${g.ok} 次${g.fail ? `，没成 ${g.fail} 次` : ''}`,
    }))
    .sort((a, b) => b.ok - a.ok)
  if (write) mutateJson(file(), { items: [] }, () => ({ items, builtAt: now, gate: { minWins, windowDays } }))
  return { items, built: items.length, considered: rows.length }
}

export function all() {
  return (readJson(file(), { items: [] }).items) || []
}

/** 提示词块（≤2 条）：会的事她才敢答应。 */
export function promptBlock({ limit = 2 } = {}) {
  const items = all().slice(0, limit)
  if (!items.length) return ''
  return '【你真做成过的事】（做过才算，别拿"我应该会"当本事）\n' + items.map((x) => `· ${x.text}`).join('\n')
}

export function canDo(skillOrText = '') {
  const s = String(skillOrText)
  const hit = SKILLS.find((x) => x.re.test(s))
  if (!hit) return { ok: false, reason: 'unknown-skill' }
  const row = all().find((x) => x.key === hit.key)
  return row ? { ok: true, skill: hit.key, label: row.label, wins: row.ok, rate: row.rate }
    : { ok: false, reason: 'not-enough-evidence', skill: hit.key }
}

export function stats() {
  const d = readJson(file(), { items: [] })
  return { total: (d.items || []).length, builtAt: d.builtAt || 0, gate: d.gate || GATE }
}