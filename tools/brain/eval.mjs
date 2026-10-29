// brain/eval —— 检索评测台（v3 §12）。
//
// 为什么必须先有它：召回权重（0.30 词面 / 0.20 新鲜度 / …）是我拍的，不是量出来的。
// 没有评测台，"她记性变好了"就只能靠感觉；有了它，改权重前后能给出 Recall@6 的差。
//
// 语料直接用现有记忆（不造干净数据）：随机挑一条**两天前**的情景，
// 从它的 quote 里取一个真实片段当线索，看它能不能被捞回来。
import { allEpisodes } from './episode.mjs'
import * as recall from './recall.mjs'

const STOP = /^(今天|昨天|明天|刚刚|哈哈|什么|怎么|可以|我们|你们|他们|就是|这个|那个|不知|知道|没|有|一|是)/
const JUNK = /[@【】\[\]{}<>|\\/]|https?:|--|^\d{1,3}$|^[a-zA-Z]{1,2}$/

/** 线索要"像人真的会问的那样"：过滤掉 @--、【Da 这类报错/卡片残渣（它们本来就不该被记住）。 */
function usableCue(seg) {
  const s = String(seg || '').trim()
  if (s.length < 2) return false
  if (JUNK.test(s)) return false
  if (STOP.test(s)) return false
  if (!/[\u4e00-\u9fa5]/.test(s) && s.length < 3) return false
  return true
}

/** 造题：{id, cues, expect, kind} */
export function buildQueries({ limit = 120, now = Date.now(), minAgeDays = 2 } = {}) {
  const eps = allEpisodes().filter((e) => now - Number(e.at) >= minAgeDays * 86400_000
    && (e.quote || '').length >= 8
    // 只用"真有人说话"的情景考它：卡片/账本/工具行本来就是噪音，拿它们当题会给假分
    && Array.isArray(e.who?.others) && e.who.others.length > 0
    && (e.act === 'say' || e.act === 'observe')
    && !/^(tools|report)$/.test(String(e.where?.platform || '')))
  const out = []
  const step = Math.max(1, Math.floor(eps.length / limit))
  for (let i = 0; i < eps.length && out.length < limit; i += step) {
    const ep = eps[i]
    const cue = pickCue(ep)
    if (!cue) continue
    out.push({ id: ep.id, cues: cue, expect: ep.id, kind: (ep.entities || []).length ? 'entity' : 'phrase', at: ep.at })
  }
  return out
}

function pickCue(ep) {
  const ent = (ep.entities || []).find((e) => usableCue(e))
  if (ent) return ent
  const q = String(ep.quote || '').replace(/[\s，。！？、,.!?：:；;“”"'（）()]/g, '')
  for (let i = 0; i + 3 <= q.length; i++) {
    const seg = q.slice(i, i + 3)
    if (!usableCue(seg)) continue
    return seg
  }
  return ''
}

/**
 * 跑评测。
 * @returns {{n:number, recallAt6:number, mrr:number, misses:Array}}
 */
export function run({ queries = null, now = Date.now(), limit = 120, weightsOverride = {}, audience = 'private' } = {}) {
  const qs = queries || buildQueries({ limit, now })
  let hit6 = 0, mrr = 0
  const misses = []
  for (const q of qs) {
    const r = recall.search({ cues: q.cues, now, limit: 30, audience, weightsOverride })
    const ids = r.items.map((x) => x.ep.id)
    const pos = ids.indexOf(q.expect)
    if (pos >= 0 && pos < 6) hit6++
    if (pos >= 0) mrr += 1 / (pos + 1)
    else if (misses.length < 8) misses.push({ cues: q.cues, expect: q.expect, got: ids.slice(0, 3) })
  }
  const n = qs.length || 1
  return { n: qs.length, recallAt6: Number((hit6 / n).toFixed(3)), mrr: Number((mrr / n).toFixed(3)), misses }
}

/** 坐标上升调权重（纯 JS，秒级；每次只动一维 ±0.06）。 */
export function calibrate({ queries = null, now = Date.now(), rounds = 2, step = 0.06 } = {}) {
  const qs = queries || buildQueries({ limit: 120, now })
  let best = { ...recall.DEFAULT_WEIGHTS }
  let bestScore = run({ queries: qs, now, weightsOverride: best }).recallAt6
  for (let r = 0; r < rounds; r++) {
    for (const k of Object.keys(recall.DEFAULT_WEIGHTS)) {
      for (const dir of [1, -1]) {
        const cand = { ...best, [k]: Math.max(0, Number((best[k] + dir * step).toFixed(3))) }
        const score = run({ queries: qs, now, weightsOverride: cand })
        const s = score.recallAt6 * 2 + score.mrr
        const cur = bestScore * 2 + run({ queries: qs, now, weightsOverride: best }).mrr
        if (s > cur + 1e-6) {
          best = cand
          bestScore = score.recallAt6
        }
      }
    }
  }
  return { weights: best, recallAt6: bestScore, baseline: run({ queries: qs, now }).recallAt6, n: qs.length }
}