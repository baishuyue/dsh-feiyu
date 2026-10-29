// brain/intents —— 前瞻记忆（BA10／丘脑前核）：意图账本（v3 O7）。
//
// 旧账本 promises.json 的四个病（10-29 实测：6 条全 done，含"done:番"和两段剧情句）：
//   ① 只有"什么"，没有"怎么算做到" → 抽不出 verify 就不该建账？不，那会让"这就去看"彻底不留痕。
//      v3：**三态都落账** —— intent（可验收）/ wish（世上做不到）/ blocked（现在做不了）。
//   ② 去重按字符串全等 → "看番"和"看可塑性记忆"各建一条。v3：(kind, object, cue±10min)。
//   ③ 没有租约 → 两个进程同时执行同一条。v3：lease + fencing。
//   ④ 机器睡过去就永远错过 → 每次唤醒先 catchUp，分 <6h / 6~24h / >24h 三档。
import { readJson, mutateJson, appendJsonl } from './json.mjs'
import { intentsPath, journalPath } from './paths.mjs'
import { isoOf, parseCue } from './clock.mjs'
import { reward, tension } from './affect.mjs'
import { bump } from './metrics.mjs'

export const KINDS = ['intent', 'wish', 'blocked']
export const VERIFY_TYPES = ['delivery', 'file', 'ledger', 'api', 'human']

const DUE_DEFAULT_MS = 90 * 60_000
const MAX_ITEMS = 300

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
const load = () => {
  const j = readJson(intentsPath(), null)
  return j && Array.isArray(j.items) ? { items: j.items, updatedAt: j.updatedAt || 0 } : { items: [], updatedAt: 0 }
}
const save = (items) => {
  try { mutateJson(intentsPath(), { items: [] }, () => ({ items, updatedAt: Date.now() })) } catch {}
  return items
}

export function journal(entry) {
  appendJsonl(journalPath(), { at: Date.now(), atIso: isoOf(), ...entry })
}

export function all() { return load().items }

export function open(now = Date.now()) {
  return all().filter((x) => ['open', 'leased', 'blocked', 'wish'].includes(x.state))
}

export function isDue(x, now = Date.now()) {
  if (!['open', 'leased'].includes(x.state)) return false
  if (x.state === 'leased' && Number(x.lease?.until || 0) > now) return false
  return Number(x.dueAt || 0) <= now
}

export function due(now = Date.now()) {
  return all().filter((x) => isDue(x, now))
}

/**
 * 建一条意图。
 * @param {object} p
 * @param {'intent'|'wish'|'blocked'} p.kind
 * @param {string} p.object 具体对象（"可塑性记忆"）
 * @param {string} [p.text] 她当时说的原话
 * @param {string} [p.verify] delivery|file|ledger|api|human（kind=intent 必填）
 */
export function create({
  kind = 'intent', object = '', text = '', cue = null, action = '', verify = '', origin = '',
  priority = 0.5, now = Date.now(), retryAt = 0, dueAt = 0,
} = {}) {
  const obj = norm(object || text).slice(0, 60)
  if (!obj) return { ok: false, reason: 'empty-object' }
  const k = KINDS.includes(kind) ? kind : 'intent'
  if (k === 'intent' && !VERIFY_TYPES.includes(verify)) {
    // 抽不出验收方式 → 降级成 blocked（仍然落账，绝不静默丢）
    return create({ ...arguments[0], kind: 'blocked', verify: '', retryAt: retryAt || now + 24 * 3600_000 })
  }

  const cueObj = (() => {
    if (cue && typeof cue === 'object' && Number(cue.at)) return cue
    if (typeof cue === 'string') return parseCue(cue, now)
    return null
  })()
  const cueAt = Number(cueObj?.at || 0)

  const items = all()
  // 去重：同 kind 同对象，且时间线索相差 10 分钟内
  const dup = items.find((x) => ['open', 'leased', 'blocked', 'wish'].includes(x.state)
    && x.kind === k && norm(x.object) === obj
    && (!cueAt || !Number(x.cue?.at) || Math.abs(Number(x.cue.at) - cueAt) <= 10 * 60_000))
  if (dup) return { ok: true, action: 'dup', intent: dup }

  const item = {
    id: `in-${now.toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
    kind: k, object: obj,
    text: norm(text).slice(0, 160),
    action: norm(action).slice(0, 40),
    verify: k === 'intent' ? verify : '',
    cue: cueObj ? { type: cueObj.type || 'at', at: Number(cueObj.at), to: Number(cueObj.to || 0) || 0, label: String(cueObj.label || '').slice(0, 30) } : null,
    origin: norm(origin).slice(0, 60),
    state: k === 'wish' ? 'wish' : k === 'blocked' ? 'blocked' : 'open',
    retryAt: Number(retryAt) || 0,
    priority: Number(priority) || 0.5,
    attempts: 0,
    lease: null,
    verifyState: null,
    createdAt: now,
    dueAt: Number(dueAt || 0) || cueAt || now + DUE_DEFAULT_MS,
    updatedAt: now,
  }
  items.push(item)
  save(items.length > MAX_ITEMS ? items.slice(-MAX_ITEMS) : items)
  journal({ ev: 'create', id: item.id, kind: item.kind, object: item.object, verify: item.verify, dueAt: item.dueAt })
  bump('intentCreated')
  return { ok: true, action: 'added', intent: item }
}

/** 拿租约（同一条同时只能被一个执行者持有）。 */
export function lease(id, holder = String(process.pid), { ttlMs = 120_000, now = Date.now() } = {}) {
  const items = all()
  const x = items.find((i) => i.id === id)
  if (!x) return { ok: false, reason: 'not-found' }
  if (!['open', 'leased', 'blocked'].includes(x.state)) return { ok: false, reason: 'not-open' }
  if (x.state === 'leased' && Number(x.lease?.until || 0) > now && x.lease?.holder !== holder) {
    return { ok: false, reason: 'busy', holder: x.lease.holder, until: x.lease.until }
  }
  x.lease = { holder: String(holder), until: now + ttlMs, fencing: Number(x.lease?.fencing || 0) + 1 }
  x.state = 'leased'
  x.attempts = Number(x.attempts || 0) + 1
  x.updatedAt = now
  save(items)
  journal({ ev: 'lease', id, holder: String(holder), fencing: x.lease.fencing, attempts: x.attempts })
  return { ok: true, fencing: x.lease.fencing, intent: x }
}

/**
 * 结算。
 * @param {{ok:boolean, reason?:string, evidence?:string[], force?:boolean}} r
 */
export function settle(id, { ok = false, reason = '', evidence = [], force = false, now = Date.now() } = {}) {
  const items = all()
  const x = items.find((i) => i.id === id)
  if (!x) return { ok: false, reason: 'not-found' }
  const proofs = (Array.isArray(evidence) ? evidence : evidence ? [evidence] : []).map(String).filter(Boolean)
  if (ok && !proofs.length && !force) {
    x.state = 'failed'
    x.verifyState = { ok: false, at: now, reason: 'no-evidence', evidence: [] }
    x.lease = null
    x.updatedAt = now
    save(items)
    journal({ ev: 'failed', id, reason: 'no-evidence' })
    bump('intentNoEvidence')
    return { ok: false, reason: 'no-evidence', intent: x }
  }
  x.state = ok ? 'done' : 'failed'
  x.verifyState = { ok: Boolean(ok), at: now, reason: String(reason || ''), evidence: proofs.slice(0, 6) }
  x.lease = null
  x.doneAt = now
  x.updatedAt = now
  save(items)
  journal({ ev: ok ? 'done' : 'failed', id, reason: String(reason || ''), evidence: proofs.slice(0, 6) })
  if (ok) { reward({ weight: 1 }); bump('intentDone') }
  else { tension(0.5); bump('intentFailed') }
  return { ok: true, intent: x }
}

export function markMissed(id, { reason = '过了 24 小时还没做', now = Date.now() } = {}) {
  const items = all()
  const x = items.find((i) => i.id === id)
  if (!x || ['done', 'missed'].includes(x.state)) return null
  x.state = 'missed'
  x.lease = null
  x.missedAt = now
  x.updatedAt = now
  x.verifyState = { ok: false, at: now, reason, evidence: [] }
  save(items)
  journal({ ev: 'missed', id, reason })
  tension(1)
  bump('intentMissed')
  return x
}

/** 开机/唤醒补做：<6h 立刻做、6~24h 做+记债、>24h 标 missed。 */
export function catchUp(now = Date.now()) {
  const out = { doing: [], debt: [], missed: [], retry: [] }
  for (const x of all()) {
    if (x.state === 'blocked') {
      if (!x.retryAt || Number(x.retryAt) <= now) out.retry.push(x)
      continue
    }
    if (!isDue(x, now)) continue
    const lateH = (now - Number(x.dueAt || now)) / 3600_000
    if (lateH <= 6) out.doing.push({ ...x, lateH: Number(lateH.toFixed(1)) })
    else if (lateH <= 24) { out.debt.push({ ...x, lateH: Number(lateH.toFixed(1)) }); tension(0.2) }
    else { const m = markMissed(x.id, { now }); if (m) out.missed.push(m) }
  }
  if (out.doing.length || out.debt.length || out.missed.length) bump('intentCatchUp', out.doing.length + out.debt.length + out.missed.length)
  return out
}

/** 这次没做成但不是她的错（额度满/材料缺）：退回 open 并顺延，不算失信。 */
export function defer(id, mins = 360, why = '这次没做成', { now = Date.now() } = {}) {
  const items = all()
  const x = items.find((i) => i.id === id)
  if (!x || ['done', 'missed'].includes(x.state)) return null
  const next = now + Math.max(1, Number(mins) || 360) * 60_000
  x.state = 'open'
  x.dueAt = next
  x.retryAt = next
  x.lease = null
  x.deferCount = Number(x.deferCount || 0) + 1
  x.lastWhy = String(why || '').slice(0, 200)
  x.updatedAt = now
  save(items)
  journal({ ev: 'defer', id, why: x.lastWhy, dueAt: next })
  bump('intentDefer')
  return x
}

/** 执行器该动手的那些：到点 + 没被租走（blocked 只有在 retryAt 也到了才算）。 */
export function executable(now = Date.now()) {
  return all()
    .filter((x) => {
      if (x.kind === 'wish') return false
      if (x.state === 'blocked') return !x.retryAt || Number(x.retryAt) <= now
      return x.state === 'open' && Number(x.dueAt || 0) <= now
    })
    .sort((a, b) => Number(a.dueAt || 0) - Number(b.dueAt || 0))
}

/** 提示词块：欠着的 + 真没做成的（≤400 字）。 */
export function promptBlock({ now = Date.now(), limit = 8 } = {}) {
  const rows = all().filter((x) => ['open', 'leased', 'blocked', 'missed', 'wish'].includes(x.state))
    .sort((a, b) => Number(a.dueAt || 0) - Number(b.dueAt || 0))
    .slice(0, limit)
  if (!rows.length) return ''
  const lines = rows.map((x) => {
    const late = Number(x.dueAt || 0) < now ? Math.round((now - Number(x.dueAt)) / 3600_000) : 0
    const state = x.state === 'missed' ? '没做成'
      : x.state === 'blocked' ? '现在做不了'
        : x.kind === 'wish' ? '只能想想' : late > 0 ? `欠着 ${late} 小时` : '到点了'
    const ver = x.verify ? `（验收：${x.verify}）` : ''
    return `· [${state}] ${x.kind === 'intent' ? '答应过' : ''}${x.object}${ver}`
  })
  return '【你自己记着的事】（做过没有你自己知道，别糊弄）\n' + lines.join('\n')
}

/** 债务视图（派生，可删可重建）。 */
export function debts(now = Date.now()) {
  return all()
    .filter((x) => (x.state === 'missed') || (['open', 'leased', 'blocked'].includes(x.state) && Number(x.dueAt || 0) < now))
    .map((x) => ({
      id: x.id, object: x.object, state: x.state,
      lateH: Math.max(0, Math.round((now - Number(x.dueAt || now)) / 3600_000)),
      verify: x.verify, kind: x.kind,
    }))
    .sort((a, b) => b.lateH - a.lateH)
}

/** 成就视图：真做成、且有证据。 */
export function wins(now = Date.now(), days = 7) {
  const from = now - days * 86400_000
  return all()
    .filter((x) => x.state === 'done' && Number(x.doneAt || 0) >= from)
    .map((x) => ({ id: x.id, object: x.object, at: x.doneAt, evidence: x.verifyState?.evidence || [] }))
}

/** 把旧 promises 账本镜像进来（S4 过渡期：旧的仍是执行者，这边只观察）。 */
export function mirrorPromise(p, now = Date.now()) {
  if (!p || !p.id) return null
  const object = norm(p.what || p.text)
  if (!object) return null
  const verify = /看|追|番|剧|片|集/.test(object) ? 'ledger'
    : /唱|录|发语音/.test(object) ? 'file'
      : /发|推|告诉|回/.test(object) ? 'delivery' : 'delivery'
  const r = create({
    kind: p.state === 'failed' ? 'blocked' : 'intent',
    object, text: p.text || '', verify,
    cue: p.dueAt ? { type: 'at', at: Number(p.dueAt), label: '旧账本' } : null,
    origin: `promise:${p.id}`, priority: 0.6, now,
  })
  return r.ok ? r.intent : null
}

export function stats() {
  const items = all()
  const by = items.reduce((m, x) => { m[x.state] = (m[x.state] || 0) + 1; return m }, {})
  return {
    total: items.length,
    byState: by,
    openDue: due().length,
    missingVerify: items.filter((x) => x.state !== 'wish' && x.kind === 'intent' && !x.verify).length,
    noEvidenceDone: items.filter((x) => x.state === 'done' && !(x.verifyState?.evidence || []).length).length,
  }
}