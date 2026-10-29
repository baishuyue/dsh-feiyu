// brain/index-inv —— 倒排索引（内存版，随进程重建）。
//
// 为什么不用 sqlite/FTS5：本机 166 条/天，一年 6 万行；启动扫 1~2 秒就建完了，
// 而 node:sqlite 的 trigram 分词对"烧鸭"这种两字词命中不了（10-29 实测），
// 换存储不换索引，等于白折腾。这里用 bigram 倒排 + df 权重，两字词天然支持。
import { episodeById, allEpisodes } from './episode.mjs'
import { fileInfo, listFiles } from './json.mjs'
import { epDir } from './paths.mjs'
import path from 'node:path'

const STOP = new Set(['的', '了', '是', '在', '我', '你', '他', '她', '它', '们', '和', '就', '都', '也', '不', '有', '这', '那', '一个', '什么', '怎么', '时候'])

const norm = (s) => String(s || '')
  .toLowerCase()
  .replace(/\[CQ:[^\]]*\]/g, ' ')
  .replace(/\[\[[^\]]*\]\]/g, ' ')
  .replace(/[\s，。！？、,.!?：:；;“”"'（）()《》「」【】\-—_/\\|]/g, '')

/** 中文按 bigram，英文/数字按整词切。 */
export function tokens(text) {
  const t = norm(text)
  const out = []
  for (const w of t.match(/[a-z0-9]{2,}/g) || []) if (!STOP.has(w)) out.push(w)
  const zh = t.replace(/[a-z0-9]+/g, '')
  for (let i = 0; i < zh.length - 1; i++) {
    const g = zh.slice(i, i + 2)
    if (STOP.has(g)) continue
    out.push(g)
  }
  return out
}

const cache = { stamp: '', index: null, sizes: null }

function stamp() {
  return listFiles(epDir(), /^\d{4}-\d{2}\.jsonl$/).map((f) => {
    const i = fileInfo(path.join(epDir(), f))
    return `${f}:${i.size}:${i.mtime}`
  }).join('|')
}

/** {token: Set(epId)} + 每条 ep 的 token 集合（懒建）。 */
export function build() {
  const st = stamp()
  if (cache.index && cache.stamp === st) return cache.index
  const index = new Map()
  const per = new Map()
  const rows = allEpisodes()
  for (const r of rows) {
    const set = new Set(tokens(`${r.gist || ''} ${r.quote || ''} ${(r.entities || []).join(' ')}`))
    per.set(r.id, set)
    for (const tk of set) {
      let bucket = index.get(tk)
      if (!bucket) { bucket = new Set(); index.set(tk, bucket) }
      bucket.add(r.id)
    }
  }
  cache.stamp = st
  cache.index = { index, per, total: rows.length }
  return cache.index
}

/**
 * 按线索取候选（并集），返回 Map(id → 命中分 0..1)。
 * 打分 = Σ idf(token) / 查询 token 数（idf 让"烧鸭"这种稀有词压过"今天"）。
 */
export function search(cues, { limit = 200 } = {}) {
  const { index, total } = build()
  const toks = [...new Set(tokens(cues))]
  const hits = new Map()
  for (const tk of toks) {
    const bucket = index.get(tk)
    if (!bucket) continue
    const idf = Math.log(1 + total / Math.max(1, bucket.size))
    for (const id of bucket) hits.set(id, (hits.get(id) || 0) + idf)
  }
  const list = [...hits.entries()]
    .map(([id, s]) => [id, s / Math.max(1, Math.sqrt(toks.length) * 2)])
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
  return new Map(list)
}

export function stats() {
  const { index, total } = build()
  return { episodes: total, tokens: index.size }
}

export { episodeById }