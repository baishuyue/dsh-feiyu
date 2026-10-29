// brain/delivery —— 交付证据（"说出去了"这件事唯一的硬凭据）。
//
// 为什么必须有它：`guard.commit` 只留最后 50 条纯文本 + 一个 sent-at（guard.mjs:97-105），
// 所以"我看完第 5 集了"这种话根本无法核对。旧的 `verify: sent-log#chat@after` 是纸面设计，
// 这里补上真的账：谁、在哪个 chat、第几条 msgId、什么类型、文本哈希。
import { appendJsonl, readJsonl } from './json.mjs'
import { deliveryPath } from './paths.mjs'
import { shortHash } from './json.mjs'
import { bump } from './metrics.mjs'

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()

/** 记一条外发成功。 */
export function record({ chat = '', msgId = '', kind = 'text', text = '', intentId = '', platform = '', at = Date.now(), extra = {} } = {}) {
  const t = norm(text)
  const row = {
    ts: Number(at) || Date.now(),
    platform: String(platform || ''),
    chat: String(chat || ''),
    msgId: String(msgId || ''),
    kind: String(kind || 'text'),
    hash: shortHash(t, 12),
    head: t.slice(0, 60),
    intentId: String(intentId || ''),
    ...extra,
  }
  if (appendJsonl(deliveryPath(), row)) bump('delivered')
  return row
}

export function recent({ chat = '', minutes = 1440, limit = 200, now = Date.now() } = {}) {
  const from = now - minutes * 60_000
  return readJsonl(deliveryPath(), { limit: 500 })
    .filter((r) => Number(r.ts) >= from && (!chat || r.chat === chat))
    .slice(-limit)
}

/**
 * 找证据：文本里出现的对象，最近 N 小时内有没有真的发出去过。
 * @returns {{ok:boolean, refs:object[]}}
 */
export function find(text, { minutes = 1440, now = Date.now(), chat = '' } = {}) {
  const t = norm(text)
  if (!t) return { ok: false, refs: [] }
  const rows = recent({ chat, minutes, now })
  const refs = rows.filter((r) => {
    if (!r.head) return false
    const a = r.head.slice(0, 12)
    return t.includes(a) || a.includes(t.slice(0, 12))
  })
  return { ok: refs.length > 0, refs }
}

/** 某 chat 最近一条（"我刚刚是不是跟你说过…"）。 */
export function last(chat, { minutes = 120, now = Date.now() } = {}) {
  const rows = recent({ chat, minutes, now, limit: 5 })
  return rows[rows.length - 1] || null
}

export function stats({ now = Date.now() } = {}) {
  const today = recent({ minutes: 1440, now, limit: 1000 })
  return { last24h: today.length, last: today[today.length - 1]?.ts || 0 }
}