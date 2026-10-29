// brain/episode —— 情景记忆（海马）：事件 → 一条"事情"（v3 §4 L1）。
//
// 与旧 episodes.jsonl 的三个区别：
//   1. 一条 = 事情（gist），不是一句话的 120 字截断。quote 留原文，gist 给渲染。
//   2. gist 在**写入时**就产出（规则），夜间 LLM 只负责重写 —— 白天也有东西可召回。
//   3. 行**永不改写**（append-only）；强度/复述次数放在 sem/strength.json 里单独进化。
import fs from 'node:fs'
import path from 'node:path'
import { appendJsonl, readJsonl, readJson, mutateJson, fileInfo, listFiles } from './json.mjs'
import { epDir, epFile } from './paths.mjs'
import { semDir } from './paths.mjs'
import { isoOf, relTime } from './clock.mjs'
import { consume as consumeEvents } from './event.mjs'
import { bump } from './metrics.mjs'

const EP_RE = /^\d{4}-\d{2}\.jsonl$/

/** 强度表（唯一可变的记忆元数据；与正文分离，正文永不改）。 */
const strengthPath = () => path.join(semDir(), 'strength.json')
export function strengths() {
  return readJson(strengthPath(), {}) || {}
}
export function touchStrength(ids, { delta = 0.2, now = Date.now() } = {}) {
  const list = Array.isArray(ids) ? ids : [ids]
  try {
    mutateJson(strengthPath(), {}, (cur) => {
      for (const id of list) {
        const row = cur[id] || { strength: 1, hits: 0, lastHit: 0 }
        row.hits = Number(row.hits || 0) + 1
        row.strength = Math.min(3, Number(row.strength || 1) + delta)
        row.lastHit = now
        cur[id] = row
      }
      return cur
    })
  } catch {}
}

/** 情绪极性与唤醒（rule-only，毫秒级；LLM 版的情绪判断在巩固里）。 */
const POS = /开心|高兴|笑死|太好|好耶|喜欢|爱了|爽|舒服|可爱|好听|好看|厉害|谢谢|抱抱|亲亲/
const NEG = /难过|难受|哭|累|烦|气死|生气|崩溃|无聊|害怕|慌|痛|失眠|加班|糟|讨厌/
const EMO_TAG = /\[\[([^\]]{1,8})\]\]|\[([^\]]{1,6})\]/

export function feelOf(text, extra = {}) {
  const t = String(text || '')
  let valence = 0
  if (POS.test(t)) valence += 0.45
  if (NEG.test(t)) valence -= 0.45
  let arousal = 0.3
  const bangs = (t.match(/[!！]/g) || []).length
  const asks = (t.match(/[?？]/g) || []).length
  arousal += Math.min(0.3, bangs * 0.08) + Math.min(0.1, asks * 0.04)
  if (/[哈嘿]哈|hhh|233/i.test(t)) arousal += 0.1
  const tag = (t.match(EMO_TAG) || [])[1] || (t.match(EMO_TAG) || [])[2] || extra.emotion || ''
  if (tag) {
    if (/开心|高兴|撒娇|喜欢|兴奋/.test(tag)) { valence += 0.2; arousal += 0.1 }
    if (/难过|委屈|哭|低落/.test(tag)) { valence -= 0.2 }
    if (/生气|急|怒/.test(tag)) { valence -= 0.25; arousal += 0.2 }
  }
  valence = Math.max(-1, Math.min(1, Number(valence.toFixed(2))))
  arousal = Math.max(0, Math.min(1, Number(arousal.toFixed(2))))
  return { valence, arousal, label: labelOf(valence, arousal) }
}

function labelOf(v, a) {
  if (v >= 0.3 && a >= 0.55) return '雀跃'
  if (v >= 0.2) return '高兴'
  if (v <= -0.4 && a >= 0.5) return '上火'
  if (v <= -0.2) return '低落'
  if (a >= 0.6) return '兴奋'
  return '日常'
}

const UNRESOLVED = /等我|待会|一会|等下|回头|明天|改天|下次|答应|说好|记得|别忘|还没|没看完|看到一半/

/** 实体候选：书名号/引号里的作品、@到的人、已知实体表。 */
export function extractEntities(text, seenNames = []) {
  const t = String(text || '')
  const out = new Set()
  for (const m of t.matchAll(/《([^》]{1,24})》/g)) out.add(m[1].trim())
  for (const m of t.matchAll(/「([^」]{1,20})」/g)) out.add(m[1].trim())
  for (const m of t.matchAll(/@([\w\u4e00-\u9fa5]{2,16})/g)) out.add(m[1].trim())
  for (const n of seenNames) {
    if (n && n.length >= 2 && t.includes(n)) out.add(n)
  }
  return [...out].slice(0, 6)
}

/** 清洗标记：CQ 码、表情标签、情绪标签、多余空白。 */
export function cleanText(text) {
  return String(text || '')
    .replace(/\[CQ:[^\]]*\]/g, ' ')
    .replace(/\[表情[:：][^\]]*\]/g, ' ')
    .replace(/\[\[[^\]]{1,10}\]\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function firstSentence(t, max = 60) {
  const s = cleanText(t)
  const m = s.match(/^[^。！？!?\n]{1,80}[。！？!?]?/)
  return (m ? m[0] : s).slice(0, max)
}

/**
 * gist：写入时就产出。群聊带上说话人（"阿强：…"），私聊说事不说人。
 */
export function gistOf(ev) {
  const body = firstSentence(ev.text, 60)
  if (!body) return ev.meta?.vision ? `（看到：${String(ev.meta.vision).slice(0, 40)}）` : '（一条没有文字的消息）'
  if (ev.who.kind === 'group_member') return `${ev.who.name}：${body}`
  if (ev.who.kind === 'owner') return `主人：${body}`
  if (ev.who.kind === 'self') return body
  return body
}

/** 与最近若干条 gist 的新鲜度（3-gram Jaccard 的反面）。 */
function noveltyOf(gist, recentGists) {
  const grams = (s) => {
    const t = String(s).replace(/[\s，。！？、,.!?：:；;“”"'（）()]/g, '')
    const out = new Set()
    for (let i = 0; i < t.length - 2; i++) out.add(t.slice(i, i + 3))
    return out
  }
  const a = grams(gist)
  if (!a.size) return 0.4
  let best = 0
  for (const g of recentGists.slice(-20)) {
    const b = grams(g)
    if (!b.size) continue
    let inter = 0
    for (const x of a) if (b.has(x)) inter++
    best = Math.max(best, inter / (a.size + b.size - inter))
  }
  return Number((1 - best).toFixed(2))
}

/**
 * 显著性（v3 §4 L1 修正版）：
 *   ① 它**不决定存不存**，只决定重放顺序/事实抽取优先级/召回权重；
 *   ② 重复出现归 strength，不进这里（旧方案把 novelty 与复述强化并列，方向相反）。
 */
export function salienceOf({ text = '', who = {}, act = 'say', feel = {}, entities = [], novelty = 0.5 }) {
  const t = String(text || '')
  const selfRef = /你|您|主人/.test(t) ? 1 : (who.kind === 'owner' ? 0.8 : 0.3)
  const val = Math.abs(Number(feel.valence) || 0)
  const aro = Number(feel.arousal) || 0.3
  const unresolved = UNRESOLVED.test(t) || act === 'promise' ? 1 : 0
  const ent = entities.length ? 1 : 0.2
  const s = 0.30 * selfRef + 0.20 * val + 0.15 * aro + 0.15 * unresolved + 0.10 * novelty + 0.10 * ent
  return Math.max(0, Math.min(1, Number(s.toFixed(3))))
}

/** 事件 → 情景行（不改写、不丢字段）。 */
export function makeEpisode(ev, { recentGists = [], knownNames = [] } = {}) {
  const gist = gistOf(ev)
  const feel = feelOf(ev.text, { emotion: ev.meta?.emotion })
  const entities = extractEntities(ev.text, knownNames)
  const novelty = noveltyOf(gist, recentGists)
  const salience = salienceOf({ text: ev.text, who: ev.who, act: ev.act, feel, entities, novelty })
  return {
    id: `ep-${isoOf(ev.at).slice(0, 10).replace(/-/g, '')}-${String(new Date(ev.at).getHours()).padStart(2, '0')}${String(new Date(ev.at).getMinutes()).padStart(2, '0')}-${Math.random().toString(36).slice(2, 6)}`,
    at: ev.at,
    atIso: isoOf(ev.at),
    who: { self: 'feiyu', others: ev.who.kind === 'self' ? [] : [ev.who] },
    where: ev.where,
    scope: ev.scope,
    act: ev.act,
    gist,
    quote: cleanText(ev.text).slice(0, 120),
    feel,
    salience,
    novelty,
    entities,
    evidence: [],
    srcEv: ev.ev,
    // msgId 必须留在情景里：QQ 重连/重放会把同一条消息再报一次，靠它去重
    meta: { ...(ev.meta || {}), msgId: ev.src?.msgId || undefined },
  }
}

/* ── 读取 ─────────────────────────────────────────────────────────── */

const cache = { stamp: '', rows: [] }

function epFiles() {
  return listFiles(epDir(), EP_RE).map((f) => path.join(epDir(), f))
}

function stampOf(files) {
  return files.map((f) => { const i = fileInfo(f); return `${f}:${i.size}:${i.mtime}` }).join('|')
}

/** 全部情景（带 2 秒缓存；60k 行约 1~2 秒，够用）。 */
export function allEpisodes() {
  const files = epFiles()
  const st = stampOf(files)
  if (cache.stamp === st) return cache.rows
  const rows = []
  for (const f of files) for (const r of readJsonl(f)) rows.push(r)
  rows.sort((a, b) => Number(a.at) - Number(b.at))
  cache.stamp = st
  cache.rows = rows
  return rows
}

export function recentEpisodes({ hours = 26, now = Date.now(), limit = 0 } = {}) {
  const from = now - hours * 3600_000
  const rows = allEpisodes().filter((r) => Number(r.at) >= from)
  return limit > 0 ? rows.slice(-limit) : rows
}

export function episodeById(id) {
  return allEpisodes().find((r) => r.id === id) || null
}

/** 渲染一行：相对时间 + 谁 + 事（带 id，方便"你说的哪句"对质）。 */
export function renderLine(ep, now = Date.now()) {
  const when = relTime(ep.at, now)
  const mark = ep.scope === 'group' ? '[群]' : ep.scope === 'public' ? '[外面]' : ''
  const who = ep.who?.others?.[0]
  const speaker = who ? (who.kind === 'owner' ? '' : `${who.name || ''} `) : ''
  return `${when}${mark} ${speaker}${ep.gist}`.replace(/\s+/g, ' ').trim()
}

/* ── 摄入 ─────────────────────────────────────────────────────────── */

const SEEN_PATH = () => path.join(semDir(), 'seen-srcev.json')

function seenSet() {
  const j = readJson(SEEN_PATH(), { ids: [] })
  return new Set(Array.isArray(j.ids) ? j.ids : [])
}

function saveSeen(set) {
  const ids = [...set].slice(-8000)
  try { mutateJson(SEEN_PATH(), { ids: [] }, () => ({ ids, at: Date.now() })) } catch {}
}

/**
 * 把 inbox 里的事件变成情景行。幂等：同一个 srcEv 只会落一条。
 * @returns {{ingested:number, skipped:number}}
 */
export function ingest({ limit = 500, now = Date.now() } = {}) {
  const events = consumeEvents({ max: limit })
  if (!events.length) return { ingested: 0, skipped: 0 }
  const seen = seenSet()
  const rows = allEpisodes()
  const recentGists = rows.slice(-20).map((r) => r.gist)
  const known = entities().map((e) => e.name).filter(Boolean)
  let ingested = 0, skipped = 0
  for (const ev of events) {
    if (!ev || !ev.ev) { skipped++; continue }
    if (seen.has(ev.ev)) { skipped++; continue }
    // 同一条消息重复上报（重连/重放）：srcEv 之外再用 msgId+文本兜一道
    const dup = ev.src?.msgId
      ? rows.slice(-60).some((r) => r.srcEv === ev.ev || (r.meta?.msgId && String(r.meta.msgId) === String(ev.src.msgId)))
      : false
    if (dup) { seen.add(ev.ev); skipped++; continue }
    const ep = makeEpisode(ev, { recentGists, knownNames: known })
    if (!appendJsonl(epFile(new Date(ep.at)), ep)) { skipped++; continue }
    seen.add(ev.ev)
    recentGists.push(ep.gist)
    rows.push(ep)               // 同批次里的重放也要认出来（rows 是开跑前的快照）
    ingested++
  }
  if (ingested || skipped) {
    saveSeen(seen)
    bump('episodesIn', ingested)
    if (skipped) bump('episodesDup', skipped)
    cache.stamp = ''            // 强制下次重读
  }
  return { ingested, skipped }
}

/** 已知实体（先只做人和作品；v3 O12 的最小版）。 */
export function entities() {
  const j = readJson(path.join(semDir(), 'entities.json'), { items: [] })
  return Array.isArray(j.items) ? j.items : []
}

/** 补一条"她真的做了"的情景（动作也需要记忆，不只是聊天）。 */
export function appendAction({ text, at = Date.now(), platform = 'tools', scope = 'private', chatId = '', evidence = [], who = 'self' }) {
  const ev = {
    ev: `e_${at.toString(36)}_act_${Math.random().toString(36).slice(2, 6)}`,
    at, atIso: isoOf(at),
    src: { proc: 'tools', platform, msgId: '' },
    where: { platform, chat: chatId, group: scope === 'group' ? chatId : null },
    who: { kind: who === 'self' ? 'self' : 'owner', id: '', name: who === 'self' ? '我' : '主人' },
    act: 'action', text, quote: '', scope,
    meta: { isGroup: scope === 'group', atMe: false, emotion: '', vision: '', replyTo: '' },
  }
  const ep = makeEpisode(ev, { recentGists: allEpisodes().slice(-20).map((r) => r.gist) })
  ep.evidence = evidence
  if (!appendJsonl(epFile(new Date(at)), ep)) return null
  cache.stamp = ''
  bump('actionsLogged')
  return ep
}