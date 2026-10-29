// brain/recall —— 检索回路（v3 §4 L3）：多路召回 → 重排 → 按 audience 渲染。
//
// 与旧 recallAll 的三个区别：
//   1. 旧版硬编码 12 小时（memory.mjs:210）—— 早上问昨晚的事就没了；这里 26h 只是"时间近邻"的一路，
//      真正的入口是倒排（多久以前都能捞到）。
//   2. 旧版 `r.isGroup !== true` 把群聊整段删掉（:214）—— 身份已经在写入时结构化了，
//      现在按 audience 决定"能不能说"，不是"存不存"。
//   3. 折叠只折闲聊；她自己做的事（action）和答应的事（promise）永不折叠，否则追番进度被吃掉。
import { allEpisodes, renderLine, strengths, extractEntities } from './episode.mjs'
import { search as indexSearch } from './index-inv.mjs'
import * as facts from './facts.mjs'
import * as intents from './intents.mjs'
import * as affect from './affect.mjs'
import { appendJsonl } from './json.mjs'
import { recallsPath } from './paths.mjs'
import { relTime } from './clock.mjs'

/**
 * 召回权重。
 * 初值是我拍的（lex 0.30 / recency 0.20 / …），**这组是评测台量出来的**：
 *   2026-10-29 用 1045 条真实情景出 120 道题（两人对话，两天前以上），
 *   lex 0.42 / recency 0.14 / salience 0.20 / affect 0.18 / self 0.14 / hits 0.06 / entity 0
 *   → Recall@6 0.85 → 0.875，MRR 0.70。entity 归零是因为实体表还基本是空的（O12 补上再祭一次）。
 * 重跑：node tools/feiyu.mjs brain eval --calibrate
 */
export const DEFAULT_WEIGHTS = {
  lex: 0.42, recency: 0.14, salience: 0.20, affect: 0.18, self: 0.14, hits: 0.06, entity: 0,
}

export function weights(over = {}) {
  const w = { ...DEFAULT_WEIGHTS, ...(over || {}) }
  const sum = Object.values(w).reduce((a, b) => a + Number(b || 0), 0) || 1
  for (const k of Object.keys(w)) w[k] = Number(w[k] || 0) / sum
  return w
}

export function cuesFrom({ text = '', recentTexts = [], entities = [], extra = '' } = {}) {
  const parts = [String(text || '')]
  for (const t of recentTexts.slice(-3)) parts.push(String(t || ''))
  if (entities.length) parts.push(entities.join(' '))
  if (extra) parts.push(String(extra))
  return parts.join(' ').slice(0, 600)
}

/** audience 决定"能说什么"，不决定"存什么"（I3）。 */
export function allowedFor(ep, audience = 'private') {
  if (!ep) return false
  if (audience === 'group') return ep.scope !== 'private'
  if (audience === 'public') return ep.scope === 'public'
  return true
}

function recencyScore(at, now) {
  const h = Math.max(0, (now - Number(at || now)) / 3600_000)
  return Math.exp(-h / 24)
}

/**
 * 检索 + 重排。
 * @returns {{items:Array, lexMax:number, candidates:number}}
 */
export function search({ cues, audience = 'private', now = Date.now(), limit = 6, chat = '', weightsOverride = {} } = {}) {
  const w = weights(weightsOverride)
  const lexHits = indexSearch(String(cues || ''), { limit: 240 })
  const lexMax = Math.max(0.0001, ...lexHits.values())
  const str = strengths()
  const cur = affect.state()
  const rows = allEpisodes()
  const byId = new Map(rows.map((r) => [r.id, r]))
  const cand = new Map()

  const addCandidate = (ep, lex = 0) => {
    if (!ep || !allowedFor(ep, audience)) return
    const prev = cand.get(ep.id)
    cand.set(ep.id, { ep, lex: Math.max(lex, prev?.lex || 0) })
  }

  for (const [id, s] of lexHits) addCandidate(byId.get(id) || null, s / lexMax)
  // 时间近邻（26h）：不靠关键词也能想起"刚刚才发生的事"
  for (const ep of rows) {
    if (Number(ep.at) >= now - 26 * 3600_000) addCandidate(ep, 0)
  }
  // 同 chat 的近 40 条（保证"这一轮之前刚说的话"一定在候选里）
  if (chat) {
    for (const ep of rows.filter((r) => r.where?.chat === chat).slice(-40)) addCandidate(ep, 0)
  }

  const scored = []
  for (const { ep, lex } of cand.values()) {
    const hit = str[ep.id]
    const s = w.lex * lex
      + w.recency * recencyScore(ep.at, now)
      + w.salience * Number(ep.salience || 0.3)
      + w.affect * (1 - Math.abs(Number(ep.feel?.valence || 0) - Number(cur.valence || 0)) / 2)
      + w.self * (ep.who?.others?.[0]?.kind === 'owner' ? 1 : 0.4)
      + w.hits * Math.min(1, Number(hit?.hits || 0) / 5)
      + w.entity * ((ep.entities || []).length ? 1 : 0.2)
    scored.push({ ep, score: Number(s.toFixed(4)), lex })
  }
  scored.sort((a, b) => b.score - a.score)

  // 折叠：只折"闲聊"（同实体 + 30 分钟内），action/promise 永不折叠
  const out = []
  const folded = new Map()
  for (const item of scored) {
    const ep = item.ep
    const talk = ep.act === 'say' || ep.act === 'observe'
    const key = talk ? `${ep.scope}|${(ep.entities || [])[0] || ''}|${Math.floor(Number(ep.at) / (30 * 60_000))}` : `id:${ep.id}`
    if (talk && folded.has(key)) { folded.set(key, folded.get(key) + 1); continue }
    if (talk) folded.set(key, 1)
    out.push(item)
    if (out.length >= limit) break
  }
  return { items: out, lexMax, candidates: cand.size, folded: [...folded.values()].reduce((a, b) => a + Math.max(0, b - 1), 0) }
}

/**
 * 组装召回包（给提示词用）。
 * @returns {{lines:string[], ids:string[], chars:number, ep:Array, facts:Array, intents:Array}}
 */
export function bundle({ platform = 'qq', chatId = '', userId = '', userText = '', isGroup = false, now = Date.now(), limit = 6 } = {}) {
  const audience = isGroup ? 'group' : (platform === 'bili' || platform === 'web') ? 'public' : 'private'
  const cues = cuesFrom({
    text: userText,
    recentTexts: allEpisodes().filter((r) => r.where?.chat === chatId).slice(-3).map((r) => r.gist),
    entities: extractEntities(userText),
    extra: affect.state().valence < -0.2 ? '难过 累 烦' : '',
  })
  const found = search({ cues, audience, now, limit, chat: chatId })
  const lines = []
  const ids = []
  for (const { ep, score } of found.items) {
    lines.push(`${renderLine(ep, now)}  ‹${ep.id}·${score.toFixed(2)}›`)
    ids.push(ep.id)
  }
  const factRows = (() => {
    const byText = facts.search(userText, { limit: 4, now })
    if (byText.length) return byText
    return facts.active(now).filter((f) => f.s === 'owner').slice(-4)
  })()
  return { lines, ids, ep: found.items, facts: factRows, intents: intents.due(now), chars: lines.join('\n').length }
}

/** 记一次检索（调参与复盘用，可旋删）。 */
export function logRecall(entry) {
  appendJsonl(recallsPath(), { at: Date.now(), ...entry })
}

export { relTime }