// 三层记忆 —— dafeiyu 骨架 brain/memory.py 的 JS 移植（SQLite+FTS5 → JSONL/JSON）。
//
//   · 情节 episodes  每次"看视频/分享/评论"的事件流（jsonl，append-only）
//   · 关系 facts     关于主人/网友的长期事实（去重）
//   · 世界 lore      她自己的设定与名场面
// 检索：2-gram 分词 + 关键词命中（十万条以内够用 —— dafeiyu 的原则：
// 「别一开始就上向量库，人格才是瓶颈」）。
import fs from 'node:fs'
import path from 'node:path'
import { dataPath } from './paths.mjs'

const EP_FILE = dataPath('episodes.jsonl')
const FACT_FILE = dataPath('facts.json')
// QQ 有自己的记忆空间：单独一个 episodes 文件（跟微信/B站分开，也方便以后单独做"自我迭代"）。
// 老数据还在主文件里，读取时两个文件一起读，所以换了位置也接得上。
const QQ_EP_FILE = dataPath('qq', 'episodes.jsonl')
// 微信也有自己的记忆空间，而且定位不同：那是"替主人干活"的工作记录，
// 不属于她的人格经历 —— 所以 recall() 默认不读它，绝不串进 QQ/B站/抖音的提示词。
const WECHAT_EP_FILE = dataPath('wechat', 'episodes.jsonl')
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

/** chatId 形如 qq:123456 → 'qq'。 */
export function platformOf(chatId) {
  return String(chatId || '').split(':')[0] || 'misc'
}

/** 平台对应的记忆文件：QQ / 微信 各自独立，B站/抖音 共用主文件。 */
export function episodeFile(platform) {
  if (platform === 'qq') return QQ_EP_FILE
  if (platform === 'wechat') return WECHAT_EP_FILE
  return EP_FILE
}

/** 记一条事件。role: user|assistant|event。summary 取前 120 字。
 *  platform 缺省时按 chatId 前缀推断（曾出过 54 条无平台标记的脏数据）。 */
export function remember(platform, chatId, userId, role, text) {
  const p = String(platform || platformOf(chatId) || 'misc')
  const t = String(text ?? '')
  const rec = {
    ts: Date.now(), platform: p, chatId, userId, role,
    text: t, summary: t.slice(0, 120),
  }
  const file = episodeFile(p)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, JSON.stringify(rec) + '\n')
}

/**
 * 读记忆行。
 * @param {string} chatId 指定会话；传空串表示"全量"（回忆/统计用）
 * @param {{includeWechat?: boolean}} opts 全量读取时是否带上微信（默认不带）
 */
function readRows(chatId, opts = {}) {
  const files = chatId
    ? [...new Set([EP_FILE, episodeFile(platformOf(chatId))])]
    : [EP_FILE, QQ_EP_FILE, ...(opts.includeWechat ? [WECHAT_EP_FILE] : [])]
  const rows = []
  for (const file of files) {
    let lines = []
    try { lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean) } catch { continue }
    for (const line of lines) {
      try {
        const r = JSON.parse(line)
        if (!chatId) { rows.push(r); continue }
        if (r.chatId === chatId) rows.push(r)
      } catch {}
    }
  }
  rows.sort((a, b) => Number(a.ts) - Number(b.ts))
  return rows
}

/** 最近 n 条对话（按 chatId 过滤，时间正序返回）。返回 {role, content} 格式，供 LLM 直接使用。 */
export function recent(chatId, n = 8) {
  return readRows(chatId).slice(-n).map(r => ({ role: r.role, content: r.text }))
}

/** 关键词回忆：命中 >7 天前的旧事（用来「主动想起」）。 */
export function recall(query, n = 2, minDays = 7, opts = {}) {
  const qs = tokens(query).filter(w => w.length > 1)
  if (!qs.length) return []
  const cutoff = Date.now() - minDays * 86400_000
  const hits = []
  for (const r of readRows('', opts)) {
    // 微信是工作记录，不进人格回忆（老数据也在主文件里，这里一并挡掉）
    if (!opts.includeWechat && r.platform === 'wechat') continue
    if (r.role !== 'user' || Number(r.ts ?? 0) >= cutoff) continue
    const grams = new Set(tokens(r.summary + r.text))
    let hitCount = 0
    for (const q of qs) if (grams.has(q)) hitCount++
    if (hitCount > 0) hits.push({ hitCount, summary: r.summary, ts: r.ts })
  }
  hits.sort((a, b) => b.hitCount - a.hitCount || a.ts - b.ts)
  return hits.slice(0, n).map(h => h.summary)
}

/** 随机想起一条旧事（没有线索时的「被动回忆」）。 */
export function randomOld(days = 7, random = Math.random, opts = {}) {
  const cutoff = Date.now() - days * 86400_000
  const pool = []
  for (const r of readRows('', opts)) {
    if (!opts.includeWechat && r.platform === 'wechat') continue
    if (r.role === 'user' && Number(r.ts ?? 0) < cutoff) pool.push(r.summary)
  }
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
// lore 分两池（10-24 设计）：
//   · 价值观（评分标尺/风控教训/边界取舍这类）—— 永久保留，常驻注入提示词
//   · 兴趣（口味）—— FIFO 200，口味会变，老兴趣自然让位
// 按 tag 区分：「兴趣」标签进兴趣池，其余都算价值观。

const isInterest = (x) => x.kind === 'interest' || x.tag === '兴趣'

export function addLore(tag, text) {
  const list = readJson(LORE_FILE, [])
  list.push({ tag: String(tag), text: String(text), ts: Date.now(), kind: String(tag) === '兴趣' ? 'interest' : 'value' })
  const values = list.filter(x => !isInterest(x))
  const interests = list.filter(isInterest)
  writeJson(LORE_FILE, [...values, ...interests.slice(-200)].sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0)))
}

export function lore(tag) {
  const list = readJson(LORE_FILE, [])
  return (tag ? list.filter(x => x.tag === tag) : list).map(x => x.text)
}

/** 价值观池（长期观念/标尺，永久保留）—— 提示词常驻。 */
export function loreValues(max = 8) {
  return readJson(LORE_FILE, []).filter(x => !isInterest(x)).slice(-max).map(x => x.text)
}

/** 兴趣池：最近 24 条里随机抽 max 条（每次聊到的话题不完全一样）。 */
export function loreInterests(max = 3, random = Math.random) {
  const tail = readJson(LORE_FILE, []).filter(isInterest).slice(-24)
  if (tail.length <= max) return tail.map(x => x.text)
  const picked = new Set()
  let guard = 0
  while (picked.size < max && guard++ < 50) picked.add(Math.floor(random() * tail.length))
  return [...picked].map((i) => tail[i].text)
}

/** 她自己养成的兴趣口味 → 2-gram 池。feed/watch 选题时用它做动态偏好加权，
 *  打通「看到→记住→想再看」的进化闭环（静态 preferences 是主人给的起点，口味自己长）。 */
export function interestGrams(n = 24) {
  const grams = new Set()
  for (const item of readJson(LORE_FILE, []).filter(isInterest).slice(-n)) {
    for (const g of tokens(item.text)) if (g.length >= 2) grams.add(g)
  }
  return grams
}

/** 一段文本与兴趣池的重合度（命中 2-gram 个数）。 */
export function interestScore(haystack, grams) {
  if (!grams || !grams.size) return 0
  const hs = new Set(tokens(haystack))
  let hits = 0
  for (const g of grams) if (hs.has(g)) hits += 1
  return hits
}

// ---------- 归档 ----------

/** 把超过 days 的旧事件挪到 <file>.archive.jsonl（不删，想考古随时翻），
 *  主文件只留近期 —— recall/最近对话的检索池保持干净。各常驻服务启动时调用。 */
export function sweepEpisodes(days = 90) {
  const cutoff = Date.now() - days * 86400_000
  let archived = 0
  for (const file of [EP_FILE, QQ_EP_FILE, WECHAT_EP_FILE]) {
    try {
      const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
      if (lines.length <= 1) continue
      const keep = [], old = []
      for (const line of lines) {
        try { (Number(JSON.parse(line).ts ?? 0) >= cutoff ? keep : old).push(line) } catch { keep.push(line) }
      }
      if (!old.length) continue
      fs.appendFileSync(file.replace(/\.jsonl$/, '') + '.archive.jsonl', old.join('\n') + '\n')
      fs.writeFileSync(file, keep.length ? keep.join('\n') + '\n' : '')
      archived += old.length
    } catch {}
  }
  return archived
}

// ---------- 统计 ----------

export function stats() {
  let episodes = 0
  for (const file of [EP_FILE, QQ_EP_FILE, WECHAT_EP_FILE]) {
    try { episodes += fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).length } catch {}
  }
  const f = readJson(FACT_FILE, {})
  return {
    episodes,
    facts: Object.values(f).reduce((n, arr) => n + (Array.isArray(arr) ? arr.length : 0), 0),
    lore: readJson(LORE_FILE, []).length,
  }
}
