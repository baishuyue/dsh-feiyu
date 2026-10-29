// brain/affect —— 情绪与显著性（杏仁核）+ 调制层（多巴胺/去甲/血清素）。
//
// 与旧 mood.mjs 的分工：mood.mjs 管"饿不饿/几点/语气"，这里管**记忆的着色**。
// 三条硬规矩：
//   1. 情绪影响写入权重与召回偏置，不影响"存不存"。
//   2. 睡眠淡化：昨天吵的架今天提起来是"当时有点急"，不是原样再气一遍。
//   3. 只有**兑现**给奖励（多巴胺），"嘴上答应"不给 —— 这是治空口承诺的根。
import { readJson, mutateJson } from './json.mjs'
import { affectPath } from './paths.mjs'

const empty = () => ({ valence: 0, arousal: 0.3, tension: 0, updatedAt: 0, log: [] })

export function state() {
  return { ...empty(), ...(readJson(affectPath(), empty()) || {}) }
}

function label(v, a, tension) {
  if (tension >= 2 && v <= -0.1) return '心里压着事'
  if (v >= 0.35 && a >= 0.55) return '雀跃'
  if (v >= 0.15) return '高兴'
  if (v <= -0.35) return '低落'
  if (a >= 0.65) return '有点上头'
  return '平稳'
}

/** 感受一次（写进记忆的同一份值）。 */
export function feel({ valence = 0, arousal = 0.3 } = {}) {
  const cur = state()
  const next = {
    ...cur,
    valence: Math.max(-1, Math.min(1, Number(((cur.valence || 0) * 0.6 + Number(valence) * 0.4).toFixed(2)))),
    arousal: Math.max(0, Math.min(1, Number(((cur.arousal || 0.3) * 0.6 + Number(arousal) * 0.4).toFixed(2)))),
    updatedAt: Date.now(),
  }
  try { mutateJson(affectPath(), empty(), () => next) } catch {}
  return next
}

/**
 * 兑现奖励（多巴胺）：只有"真的做成了"才调。
 * 失败不加负权重（D2：不做痛感记忆），只把 tension 记进 debts（由 intents 说话）。
 */
export function reward({ weight = 1 } = {}) {
  const cur = state()
  const next = {
    ...cur,
    valence: Math.min(1, Number(((cur.valence || 0) + 0.12 * weight).toFixed(2))),
    arousal: Math.min(1, Number(((cur.arousal || 0.3) + 0.05 * weight).toFixed(2))),
    tension: Math.max(0, Number((cur.tension || 0) - 1)),
    updatedAt: Date.now(),
  }
  next.log = [...(cur.log || []), { at: Date.now(), kind: 'reward', weight }].slice(-50)
  try { mutateJson(affectPath(), empty(), () => next) } catch {}
  return next
}

/** 记一笔"答应了/拖了"（不是痛感，是压力；被 intents 用来解释迟到）。 */
export function tension(n = 1) {
  const cur = state()
  const next = { ...cur, tension: Math.max(0, Number(cur.tension || 0) + Number(n)), updatedAt: Date.now() }
  try { mutateJson(affectPath(), empty(), () => next) } catch {}
  return next
}

/** 睡眠淡化：巩固时调一次（arousal ×0.85，|valence| ×0.9）。 */
export function decay(rounds = 1) {
  const cur = state()
  let v = Number(cur.valence || 0), a = Number(cur.arousal || 0.3)
  for (let i = 0; i < rounds; i++) { v *= 0.9; a = 0.3 + (a - 0.3) * 0.85 }
  const next = { ...cur, valence: Number(v.toFixed(2)), arousal: Number(a.toFixed(2)), updatedAt: Date.now() }
  try { mutateJson(affectPath(), empty(), () => next) } catch {}
  return next
}

/** 提示词一行（≤200 字，进"时钟与情绪"槽）。 */
export function line() {
  const s = state()
  const v = Number(s.valence || 0)
  const moodWord = label(v, Number(s.arousal || 0), Number(s.tension || 0))
  const extra = s.tension >= 2 ? `；心里还压着 ${s.tension} 件事没落地` : ''
  return `你现在的底色：${moodWord}（情绪 ${v >= 0 ? '+' : ''}${v.toFixed(2)}，唤醒 ${Number(s.arousal || 0).toFixed(2)}）${extra}`
}