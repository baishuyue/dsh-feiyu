// brain/consolidate —— 巩固回路（睡眠，v3 §4 L2）。
//
// 为什么必须"可续跑 + 幂等"：
//   机器会睡眠（实测 01:07 → 08:02），04:30 的巩固必然经常不在点上；
//   而抽事实要调 LLM，中途崩了如果从头再来，同一条事实会被反复写。
//
// 做法：
//   · 已处理的 ep 记在 consolidation/done.jsonl（append-only），不靠改写正文；
//   · 事实按 (s,p,o) 合并去重 → 即使重复跑也只会加 hits，不会多一条；
//   · 预算（调用数/token）用完就停，游标不推进，明天接着做。
import fs from 'node:fs'
import path from 'node:path'
import { appendJsonl, readJsonl, readJson, mutateJson, ensureDir } from './json.mjs'
import { consDir, consolidateCursorPath, diaryPath } from './paths.mjs'
import { allEpisodes } from './episode.mjs'
import * as facts from './facts.mjs'
import * as affect from './affect.mjs'
import * as selfM from './self.mjs'
import { tryExclusive, touchLock } from './store.mjs'
import { endOfDay, isoOf, stamp } from './clock.mjs'
import { bump, setValue } from './metrics.mjs'

const doneFile = () => path.join(consDir(), 'done.jsonl')

function doneIds() {
  try { return new Set(readJsonl(doneFile()).map((r) => r.id)) } catch { return new Set() }
}

/** 规则抽取（不花钱，先跑；LLM 只补它抽不出来的）。 */
const RULES = [
  { p: 'food.eat', re: /(?:我|俺)?(?:刚刚?|今天|中午|上午|晚上|早饭|午饭|晚饭)?(?:吃|喝)(?:了|过|的是|的)([^\n，。！？,.!?]{1,18})/ },
  { p: 'activity.do', re: /我(?:在|正在|这边在)([^\n，。！？,.!?]{1,24})/ },
  { p: 'plan.go', re: /我(?:明天|后天|等会|待会|下午|晚上|周末)?(?:要|准备|打算|得|需要)(?:去|做|看|见)([^\n，。！？,.!?]{1,24})/ },
  { p: 'mood.state', re: /我(?:有点|很|好|特别|今天)?(累了|累|困|烦|难受|开心|不高兴|无聊|生病|感冒)/ },
  { p: 'media.like', re: /《([^》]{1,24})》/ },
]

function ruleFacts(eps) {
  const out = []
  for (const ep of eps) {
    if (!ep.who?.others?.some((w) => w.kind === 'owner')) continue     // 只从主人嘴里抽
    for (const r of RULES) {
      const m = r.re.exec(ep.quote || ep.gist || '')
      if (!m) continue
      const o = String(m[1] || '').trim()
      if (!o) continue
      out.push({ s: 'owner', p: r.p, o, from: ep.at, to: endOfDay(ep.at), prov: ep.id, conf: 0.75 })
    }
  }
  return out
}

function clusterEps(eps) {
  const groups = []
  const sorted = [...eps].sort((a, b) => a.at - b.at)
  for (const ep of sorted) {
    const last = groups[groups.length - 1]
    const same = last && last.eps[0].where?.chat === ep.where?.chat
      && Math.abs(ep.at - last.eps[last.eps.length - 1].at) <= 30 * 60_000
    const shareEnt = last && (ep.entities || []).some((e) => last.ents.has(e))
    if (same && (shareEnt || Math.abs(ep.at - last.eps[last.eps.length - 1].at) <= 10 * 60_000)) {
      last.eps.push(ep)
      for (const e of ep.entities || []) last.ents.add(e)
    } else {
      groups.push({ eps: [ep], ents: new Set(ep.entities || []) })
    }
  }
  return groups
}

/**
 * 跑一次巩固。chatFn(messages) → 文本（要 JSON）；不传就只跑规则。
 * @returns {{ok:boolean, reason?:string, processed:number, facts:{added:number,merged:number,rejected:number}, llmCalls:number}}
 */
export function run({ now = Date.now(), chatFn = null, dryRun = false, limit = 200, maxCalls = 6 } = {}) {
  const release = tryExclusive('consolidate', { staleMs: 30 * 60_000 })
  if (!release) return { ok: false, reason: 'busy', processed: 0, facts: { added: 0, merged: 0, rejected: 0 }, llmCalls: 0 }
  try {
    const all = allEpisodes()
    const done = doneIds()
    const pending = all.filter((e) => !done.has(e.id) && Number(e.at) <= now + 60_000).slice(0, limit)
    const out = { ok: true, processed: 0, facts: { added: 0, merged: 0, rejected: 0 }, llmCalls: 0, clusters: 0 }
    if (!pending.length) {
      setValue('consolidateAt', now)
      return out
    }
    const clusters = clusterEps(pending)
    out.clusters = clusters.length
    const diary = []
    for (const c of clusters) {
      touchLock('consolidate')
      const extracted = ruleFacts(c.eps)
      if (!extracted.length && chatFn && out.llmCalls < maxCalls) {
        const got = extractLLM(c, chatFn)
        out.llmCalls++
        extracted.push(...got)
      }
      for (const f of extracted) {
        if (dryRun) continue
        const r = facts.add({
          s: f.s || 'owner', p: f.p, o: f.o,
          validFrom: f.from, validUntil: f.to,
          prov: [f.prov].flat().filter(Boolean),
          source: f.source || 'owner', conf: Number(f.conf) || 0.7,
          raw: f.raw || '', now,
        })
        if (!r.ok) { out.facts.rejected++; continue }
        if (r.action === 'merged') out.facts.merged++
        else out.facts.added++
      }
      const head = c.eps[c.eps.length - 1]
      diary.push(`- ${stamp(head.at)} ${head.gist}`)
      if (!dryRun) {
        for (const ep of c.eps) appendJsonl(doneFile(), { id: ep.id, runId: isoOf(now), at: now })
      }
      out.processed += c.eps.length
    }
    if (!dryRun) {
      writeDiary(diary, now)
      affect.decay(1)
      decayStrengths(now)
      selfM.settleManifest()
      mutateJson(consolidateCursorPath(), {}, () => ({ lastRunAt: now, lastRunIso: isoOf(now), processed: out.processed, clusters: out.clusters }))
      setValue('consolidateAt', now)
      bump('consolidated', out.processed)
      maybeNarrative(now)
    }
    return out
  } finally {
    release()
  }
}

function extractLLM(cluster, chatFn) {
  const text = cluster.eps.slice(-8).map((e) => `${isoOf(e.at)} ${e.gist}`).join('\n')
  const ask = [
    '从下面这些对话里抽"关于主人"的稳定事实。只输出 JSON 数组，每项',
    '{"p":"food.eat|activity.do|plan.go|mood.state|media.like|preference.like|place.visit|work.do","o":"具体内容≤20字"}。',
    '抽不出来就输出 []。不要编，不要把问句当事实。',
    '---',
    text,
  ].join('\n')
  try {
    const raw = String(chatFn([{ role: 'user', content: ask }]) || '')
    const m = raw.match(/\[[\s\S]*\]/)
    if (!m) return []
    const arr = JSON.parse(m[0])
    if (!Array.isArray(arr)) return []
    return arr.slice(0, 8).map((x) => ({
      s: 'owner', p: String(x.p || ''), o: String(x.o || '').slice(0, 40),
      from: cluster.eps[0].at, to: endOfDay(cluster.eps[cluster.eps.length - 1].at),
      prov: cluster.eps.map((e) => e.id), conf: 0.6, source: 'self', raw: 'llm',
    })).filter((x) => x.o && facts.PREDICATES.includes(x.p))
  } catch { return [] }
}

function writeDiary(lines, now) {
  if (!lines.length) return
  try {
    ensureDir(consDir())
    const file = diaryPath(new Date(now))
    const head = fs.existsSync(file) ? '' : `# ${new Date(now).toDateString()} 的复盘\n\n`
    fs.appendFileSync(file, head + lines.join('\n') + '\n')
  } catch {}
}

function decayStrengths(now) {
  try {
    mutateJson(path.join(path.dirname(consDir()), 'sem', 'strength.json'), {}, (cur) => {
      for (const [id, row] of Object.entries(cur || {})) {
        const last = Number(row.lastHit || 0)
        if (!last) { row.strength = Number((Number(row.strength || 1) * 0.97).toFixed(3)); continue }
        const days = Math.max(0, (now - last) / 86400_000)
        if (days > 1) row.strength = Number((Number(row.strength || 1) * Math.pow(0.97, Math.min(30, days))).toFixed(3))
      }
      return cur
    })
  } catch {}
}

/** 周日（或叙事还是空的）重写叙事段，≤300 字。 */
function maybeNarrative(now = Date.now()) {
  const s = selfM.read()
  const isSunday = new Date(now).getDay() === 0
  if (s.narrative && s.narrative.length > 50 && !isSunday) return null
  const rows = allEpisodes().slice(-40)
  if (!rows.length) return null
  const byDay = new Map()
  for (const ep of rows) {
    const d = isoOf(ep.at).slice(0, 10)
    if (!byDay.has(d)) byDay.set(d, [])
    byDay.get(d).push(ep.gist)
  }
  const parts = [...byDay.entries()].slice(-5).map(([d, gs]) => `${d}：${gs.slice(0, 3).join('；')}`)
  const body = `最近这些天：\n${parts.join('\n')}`.slice(0, 300)
  const r = selfM.write('narrative', body, { by: 'consolidate', reason: '每周叙事重写', prov: rows.slice(-3).map((e) => e.id) })
  return r.ok ? body : null
}

export function status() {
  const cur = readJson(consolidateCursorPath(), null)
  const done = doneIds()
  const total = allEpisodes().length
  return { lastRunAt: cur?.lastRunAt || 0, processed: done.size, total, pending: Math.max(0, total - done.size) }
}