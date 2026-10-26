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
import { normalizeMemoryText } from './normalize.mjs'

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
 *  platform 缺省时按 chatId 前缀推断（曾出过 54 条无平台标记的脏数据）。
 *  写入前做占位符归一（normalize.mjs）：裸的 `[分享视频]` 会让模型以为"内容丢了"。 */
export function remember(platform, chatId, userId, role, text, extra = {}) {
  const p = String(platform || platformOf(chatId) || 'misc')
  const t = normalizeMemoryText(String(text ?? ''))
  const rec = {
    ts: Date.now(), platform: p, chatId, userId, role,
    text: t, summary: t.slice(0, 120),
    // isGroup：群聊行。群里的"user"是群友不是主人，混进 recallAll 会被渲染成「主人：…」，
    // 于是她在私聊里把群友的话当主人的话记（10-26 实锤：把群友"叫爸爸"当成主人说的）。
    ...(extra.isGroup ? { isGroup: true } : {}),
  }
  const file = episodeFile(p)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, JSON.stringify(rec) + '\n')
  rotateIfBig(file)
}

// 单文件太大时按月份分片（照 dsh-world「按天归档 + 原文全留」的思路，只是粒度用月）。
// 分片命名 episodes-YYYY-MM.jsonl，放在同一目录；读取端会把它们一起读（见 shardsOf）。
const ROTATE_BYTES = 6 * 1024 * 1024

function shardName(base, stamp) {
  const d = new Date(stamp)
  const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  return path.join(path.dirname(base), `episodes-${ym}.jsonl`)
}

/** 把 base 里"不是本月"的行搬到按月分片，只留本月在主文件。失败就原样不动。 */
function rotateIfBig(base) {
  try {
    if (!fs.existsSync(base) || fs.statSync(base).size < ROTATE_BYTES) return
    const lines = fs.readFileSync(base, 'utf8').split('\n').filter(Boolean)
    const now = new Date(), ymNow = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
    const keep = [], move = new Map()
    for (const line of lines) {
      let r = null
      try { r = JSON.parse(line) } catch {}
      const ts = Number(r?.ts) || 0
      const d = new Date(ts || Date.now())
      const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
      if (!ts || ym === ymNow) { keep.push(line); continue }
      if (!move.has(ym)) move.set(ym, [])
      move.get(ym).push(line)
    }
    for (const [ym, rows] of move) {
      const target = path.join(path.dirname(base), `episodes-${ym}.jsonl`)
      fs.appendFileSync(target, rows.join('\n') + '\n')
    }
    // 先写分片再截断主文件：中途崩溃最多重复，不会丢
    fs.writeFileSync(base, keep.join('\n') + (keep.length ? '\n' : ''))
  } catch {}
}

/** 主文件 + 它的所有按月分片。 */
export function shardsOf(base) {
  const dir = path.dirname(base)
  const out = [base]
  try {
    for (const f of fs.readdirSync(dir)) {
      if (/^episodes-\d{4}-\d{2}\.jsonl$/.test(f)) out.push(path.join(dir, f))
    }
  } catch {}
  return out
}

/**
 * 读记忆行。
 * @param {string} chatId 指定会话；传空串表示"全量"（回忆/统计用）
 * @param {{includeWechat?: boolean}} opts 全量读取时是否带上微信（默认不带）
 */
function readRows(chatId, opts = {}) {
  const bases = chatId
    ? [...new Set([EP_FILE, episodeFile(platformOf(chatId))])]
    : [EP_FILE, QQ_EP_FILE, ...(opts.includeWechat ? [WECHAT_EP_FILE] : [])]
  const files = []
  for (const b of bases) files.push(...shardsOf(b))
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

/** 最近 n 条对话（按 chatId 过滤，时间正序返回）。返回 {role, content} 格式，供 LLM 直接使用。
 *  ⚠️ 只放 user/assistant（10-25 修的 bug）：抖音那边会把"刷到某条视频"记成 role=event 的流水，
 *  混进 messages 里会被模型接口直接拒掉（HTTP 422 unknown variant `event`）——
 *  抖音 interact 因此整条链路一条评论都生成不出来。 */
export function recent(chatId, n = 8) {
  return readRows(chatId)
    .filter(r => r.role === 'user' || r.role === 'assistant')
    .slice(-n)
    .map(r => ({ role: r.role, content: r.text }))
}


/** 该会话里「主人最后一次说话」「她最后一次说话」的时间戳（给时间常驻层用）。 */
export function lastByRole(chatId) {
  const rows = readRows(chatId)
  let lastUser = 0, lastAssistant = 0
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]
    if (!lastUser && r.role === 'user') lastUser = Number(r.ts) || 0
    if (!lastAssistant && r.role === 'assistant') lastAssistant = Number(r.ts) || 0
    if (lastUser && lastAssistant) break
  }
  return { lastUser, lastAssistant }
}

/**
 * 统一时序回忆 —— 把**不是本通道**的全部真实记录按时间拼成一份（照 dsh-world 的
 * src/history.ts renderHistory：一行一条、带本地时间、带会话标记、从新到旧）。
 *
 * 为什么合并：以前这里是两个补丁块（crossChannel 管"别的平台的对话"、ownRecent 管"她自己做的事"），
 * 各自过滤、各自取前几条，互相挤名额，还是盖不全 —— 10-25 连栽两次：
 *   ① QQ 说"在抖音看滑肉视频" → 抖音问滑肉她说"不知道"；
 *   ② 上网写了三段小说 → QQ 问起她说"写小说？没有呀"。
 * 病根是"按通道切碎的存储"，补丁只能在展示层兜。这里改成一次性全量、按时间排序、统一渲染。
 *
 * @param {string} chatId 当前通道的 chatId（这些行由 recent() 单独给，这里排除掉避免重复）
 * @param {{hours?: number, max?: number, perRow?: number, now?: number}} opts
 */
export function recallAll(chatId, opts = {}) {
  const { hours = 12, max = 12, perRow = 90, now = Date.now() } = opts
  const cutoff = now - hours * 3600_000
  const rows = readRows('').filter(r =>
    r.chatId !== chatId
    && r.isGroup !== true                           // 群聊行不进"最近真实发生的事"：群里说话的是群友，不是主人
    && r.platform !== 'wechat'                       // 微信是替主人干活的工作记录，不进人格记忆
    && (r.role === 'user' || r.role === 'assistant')
    && Number(r.ts) >= cutoff
    && String(r.text || '').trim())
  if (!rows.length) return { lines: [], count: 0, newest: 0 }
  // 去重（同一句被多通道记过）+ 挨个通道限流（一个话痨通道不能吃掉全部名额）
  const seen = new Set()
  const byChat = new Map()
  for (const r of rows) {
    const k = String(r.text).replace(/\s+/g, '').slice(0, 30)
    if (seen.has(k)) continue
    seen.add(k)
    const c = String(r.chatId || r.platform)
    if (!byChat.has(c)) byChat.set(c, [])
    byChat.get(c).push(r)
  }
  const per = Math.max(2, Math.ceil(max / byChat.size))
  const picked = []
  for (const arr of byChat.values()) picked.push(...arr.slice(-per))
  // 按时间正序，最后的 max 条 → 渲染时再翻成"从新到旧"（跟她读记忆的习惯一致）
  picked.sort((a, b) => Number(a.ts) - Number(b.ts))
  const finalRows = picked.slice(-max)
  const where = (r) => {
    const p = r.platform
    const base = p === 'qq' ? 'QQ' : p === 'douyin' ? '抖音' : p === 'bilibili' ? 'B站'
      : p === 'web' ? '上网' : p === 'wechat' ? '微信' : String(p || '别处')
    return r.isGroup ? base + '群' : base   // 群聊单独标出来：她得知道这句是"群里谁说的"
  }
  const hhmm = (ts) => {
    const d = new Date(Number(ts))
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
  }
  const lines = finalRows.slice().reverse().map(r => {
    const text = String(r.text).replace(/\s+/g, ' ').replace(/^[（(]|[）)]$/g, '').slice(0, perRow)
    // ⚠️ 10-26 修「认贼作父」的根子就在这一行：以前所有 user 行一律渲染成「主人：」，
    // 于是群友的话进了私聊记忆就变成"主人说的"，她连"叫爸爸"都当成主人说的。
    // 现在：群聊行的 user 是**群友**，文本自带「昵称：」前缀（qq-server 写入时加的），原样呈现；
    // 只有真正的一对一私聊行才配得上「主人：」。
    if (r.role === 'assistant') return `${hhmm(r.ts)} [${where(r)}] 我：${text}`
    return r.isGroup
      ? `${hhmm(r.ts)} [${where(r)}] ${text}`
      : `${hhmm(r.ts)} [${where(r)}] 主人：${text}`
  })
  return { lines, count: lines.length, newest: Number(finalRows.at(-1)?.ts || 0) }
}

/**
 * 全文检索她自己的一生（`feiyu mem grep 关键词`）。
 * 照 dsh-world 的思路：不做向量库，靠"原文全留 + 按原话找"。
 */
export function grepEpisodes(pattern, { days = 0, limit = 30, role = '' } = {}) {
  const re = pattern instanceof RegExp ? pattern : new RegExp(String(pattern || ''), 'i')
  const cutoff = days > 0 ? Date.now() - days * 86400_000 : 0
  const rows = readRows('').filter(r =>
    r.platform !== 'wechat'
    && Number(r.ts) >= cutoff
    && (!role || r.role === role)
    && (re.test(String(r.text || '')) || re.test(String(r.summary || ''))))
  return rows.slice(-limit).map(r => ({
    ts: r.ts, platform: r.platform, chatId: r.chatId, role: r.role,
    text: String(r.text || '').replace(/\s+/g, ' ').slice(0, 300),
  }))
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
