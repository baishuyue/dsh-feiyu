// 三层记忆 —— dafeiyu 骨架 brain/memory.py 的 JS 移植（SQLite+FTS5 → JSONL/JSON）。
//
//   · 情节 episodes  每次"看视频/分享/评论"的事件流（jsonl，append-only）
//   · 关系 facts     关于主人/网友的长期事实（去重）
//   · 世界 lore      她自己的设定与名场面
// 检索：2-gram 分词 + 关键词命中（十万条以内够用 —— dafeiyu 的原则：
// 「别一开始就上向量库，人格才是瓶颈」）。
import fs from 'node:fs'
import { dataPath } from './paths.mjs'

const EP_FILE = dataPath('episodes.jsonl')
const FACT_FILE = dataPath('facts.json')
const LORE_FILE = dataPath('lore.json')

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}
function writeJson(file, value) {
  fs.mkdirSync(dataPath(), { recursive: true })
  const temp = file + '.' + process.pid + '.tmp'
  fs.writeFileSync(temp, JSON.stringify(value, null, 1) + '\n')
  fs.renameSync(temp, file)
}

/** 极简分词：中文按 2-gram 切，英文按字符组 —— dafeiyu memory.py _tokens 的移植。 */
export function tokens(text) {
  const out = []
  let buf = ''
  for (const ch of String(text ?? '')) {
    if (ch >= '\u4e00' && ch <= '\u9fff') {
      buf += ch
      if (buf.length >= 2) { out.push(buf); buf = buf.slice(-1) }
    } else {
      buf = ''
      if (/[a-zA-Z0-9]/.test(ch)) out.push(ch.toLowerCase())
    }
  }
  return out
}

// ---------- 情节（episodes） ----------

/** 记一条事件。role: user|assistant|event。summary 取前 120 字。 */
export function remember(platform, chatId, userId, role, text) {
  const t = String(text ?? '')
  const rec = {
    ts: Date.now(), platform, chatId, userId, role,
    text: t, summary: t.slice(0, 120),
  }
  fs.mkdirSync(dataPath(), { recursive: true })
  fs.appendFileSync(EP_FILE, JSON.stringify(rec) + '\n')
}

/** 最近 n 条对话（按 chatId 过滤，时间正序返回）。 */
export function recent(chatId, n = 8) {
  const rows = []
  try {
    const lines = fs.readFileSync(EP_FILE, 'utf8').trim().split('\n').filter(Boolean)
    for (let i = lines.length - 1; i >= 0 && rows.length < n; i--) {
      try {
        const r = JSON.parse(lines[i])
        if (r.chatId === chatId) rows.push(r)
      } catch {}
    }
  } catch {}
  return rows.reverse()
}

/** 关键词回忆：命中 >7 天前的旧事（用来「主动想起」）。 */
export function recall(query, n = 2, minDays = 7) {
  const qs = tokens(query).filter(w => w.length > 1)
  if (!qs.length) return []
  const cutoff = Date.now() - minDays * 86400_000
  const hits = []
  try {
    const lines = fs.readFileSync(EP_FILE, 'utf8').trim().split('\n').filter(Boolean)
    for (const line of lines) {
      try {
        const r = JSON.parse(line)
        if (r.role !== 'user' || Number(r.ts ?? 0) >= cutoff) continue
        const grams = new Set(tokens(r.summary + r.text))
        let hitCount = 0
        for (const q of qs) if (grams.has(q)) hitCount++
        if (hitCount > 0) hits.push({ hitCount, summary: r.summary, ts: r.ts })
      } catch {}
    }
  } catch {}
  hits.sort((a, b) => b.hitCount - a.hitCount || a.ts - b.ts)
  return hits.slice(0, n).map(h => h.summary)
}

/** 随机想起一条旧事（没有线索时的「被动回忆」）。 */
export function randomOld(days = 7, random = Math.random) {
  const cutoff = Date.now() - days * 86400_000
  const pool = []
  try {
    const lines = fs.readFileSync(EP_FILE, 'utf8').trim().split('\n').filter(Boolean)
    for (const line of lines) {
      try {
        const r = JSON.parse(line)
        if (r.role === 'user' && Number(r.ts ?? 0) < cutoff) pool.push(r.summary)
      } catch {}
    }
  } catch {}
  if (!pool.length) return []
  return [pool[Math.floor(random() * pool.length)]]
}

// ---------- 关系（facts） ----------

export function addFact(userId, fact) {
  const all = readJson(FACT_FILE, {})
  const list = new Set(all[userId] ?? [])
  list.add(String(fact))
  all[userId] = [...list].slice(-50)
  writeJson(FACT_FILE, all)
}

export function facts(userId, max = 30) {
  const list = readJson(FACT_FILE, {})[userId] ?? []
  return list.slice(-max)
}

// ---------- 世界（lore） ----------

export function addLore(tag, text) {
  const list = readJson(LORE_FILE, [])
  list.push({ tag: String(tag), text: String(text), ts: Date.now() })
  writeJson(LORE_FILE, list.slice(-200))
}

export function lore(tag) {
  const list = readJson(LORE_FILE, [])
  return (tag ? list.filter(x => x.tag === tag) : list).map(x => x.text)
}

// ---------- 统计 ----------

export function stats() {
  let episodes = 0
  try { episodes = fs.readFileSync(EP_FILE, 'utf8').trim().split('\n').filter(Boolean).length } catch {}
  const f = readJson(FACT_FILE, {})
  return {
    episodes,
    facts: Object.values(f).reduce((n, arr) => n + (Array.isArray(arr) ? arr.length : 0), 0),
    lore: readJson(LORE_FILE, []).length,
  }
}
