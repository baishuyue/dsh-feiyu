// brain/event —— 事件层：一切进脑的东西先变成一个"事件"（v3 §3/§10）。
//
// 为什么要多这一层（不改就永远治不好的三个病）：
//   1. 群聊里"谁说的"以前靠 `昵称：正文` 拼字符串（qq-server.mjs:344），
//      回到私聊再召回就被当成了主人说的话 —— 现在是结构化 who.kind。
//   2. 平台只是"在哪说的"，不是"归谁存"；scope 在捕获时定死，读时按 audience 渲染。
//   3. 微信是独立代理：**入口直接拒收**，不是"存了不读"（I7）。
import fs from 'node:fs'
import path from 'node:path'
import { appendJsonl, readJsonl, readJson, writeJsonAtomic } from './json.mjs'
import { inboxFile, inboxCursor, inboxDir } from './paths.mjs'
import { isoOf } from './clock.mjs'
import { bump } from './metrics.mjs'

export const ACTS = ['say', 'action', 'observe', 'promise', 'feel', 'push']
export const SCOPES = ['private', 'group', 'public']

/** 微信：独立代理，不进中枢（I7）。 */
export const ISOLATED_PLATFORMS = new Set(['wechat', 'wx'])

let _ownerIds = null
/** 主人身份由 index.mjs 装配时注入（避免 config ⇄ brain 的循环依赖）。 */
export function setOwnerIds(list) {
  _ownerIds = Array.isArray(list) ? list.map(String) : null
}
function ownerIds() {
  return _ownerIds || []
}

/**
 * 归一化一条事件。
 * @returns {{ok:true, event:object}|{ok:false, reason:string}}
 */
export function normalize(input = {}) {
  const platform = String(input.platform || 'qq')
  if (ISOLATED_PLATFORMS.has(platform)) {
    bump('wechatRejected')
    return { ok: false, reason: 'wechat-isolated' }
  }
  const text = String(input.text ?? '').trim()
  if (!text && !input.vision && !input.kind) return { ok: false, reason: 'empty' }

  const isGroup = input.isGroup === true || input.scope === 'group'
  const role = String(input.role || 'user')
  const uid = String(input.userId ?? '')
  const owners = ownerIds()
  let whoKind
  if (role === 'assistant' || role === 'self') whoKind = 'self'
  else if (isGroup) whoKind = 'group_member'
  else if (platform === 'bili' || platform === 'web') whoKind = 'external'
  else if (owners.length) whoKind = owners.includes(uid) ? 'owner' : 'stranger'
  else whoKind = 'owner'          // 私聊默认就是主人（qq/抖音私信本来只陪他一个人）
  if (input.isOwner === true) whoKind = 'owner'

  const act = (() => {
    const k = String(input.kind || '')
    if (ACTS.includes(k)) return k
    if (role === 'assistant') return 'say'
    if (k === 'push' || k === 'share') return 'push'
    if (role === 'event' || k === 'action' || k === 'self') return 'action'
    return 'say'
  })()

  const scope = SCOPES.includes(input.scope) ? input.scope
    : isGroup ? 'group'
      : (platform === 'bili' || platform === 'web') ? 'public' : 'private'

  const at = Number(input.at) || Date.now()
  const event = {
    ev: String(input.ev || `e_${at.toString(36)}_${String(input.proc || platform).slice(0, 6)}_${Math.random().toString(36).slice(2, 6)}`),
    at,
    atIso: isoOf(at),
    src: { proc: String(input.proc || platform), platform, msgId: input.msgId ? String(input.msgId) : '' },
    where: { platform, chat: String(input.chatId ?? ''), group: isGroup ? String(input.groupId ?? input.chatId ?? '') : null },
    who: {
      kind: whoKind, id: uid,
      name: String(input.name || (whoKind === 'self' ? '我' : whoKind === 'owner' ? '主人' : uid || '某人')).slice(0, 24),
    },
    act, text: text.slice(0, 2000),
    quote: input.quote ? String(input.quote).slice(0, 500) : '',
    scope,
    meta: {
      isGroup,
      atMe: input.atMe === true,
      emotion: input.emotion ? String(input.emotion).slice(0, 20) : '',
      vision: input.vision ? String(input.vision).slice(0, 300) : '',
      replyTo: input.replyTo ? String(input.replyTo) : '',
    },
  }
  return { ok: true, event }
}

/**
 * 发一条事件（IO 进程唯一的写动作）。永不抛。
 * @returns {{ok:boolean, reason?:string, event?:object}}
 */
export function emit(input = {}) {
  try {
    const n = normalize(input)
    if (!n.ok) return n
    const file = inboxFile(n.event.src.proc, new Date(n.event.at))
    const ok = appendJsonl(file, n.event)
    bump(ok ? 'eventsIn' : 'eventsLost')
    return ok ? { ok: true, event: n.event } : { ok: false, reason: 'append-failed' }
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) }
  }
}

/**
 * 取走所有还没消费的事件（每个分片一个行号游标）。
 * 只被 brain 的 ingest 调用；游标写回是原子的。
 */
export function consume({ max = 500 } = {}) {
  const out = []
  let files = []
  try {
    files = fs.readdirSync(inboxDir()).filter((f) => f.endsWith('.jsonl')).sort()
  } catch { return out }
  for (const name of files) {
    const file = path.join(inboxDir(), name)
    const curFile = inboxCursor(file)
    const cur = readJson(curFile, { lines: 0 }) || { lines: 0 }
    const rows = readJsonl(file)
    let lines = Number(cur.lines || 0)
    if (rows.length < lines) lines = 0     // 文件被轮转过
    for (const r of rows.slice(lines)) {
      if (out.length >= max) return out
      out.push(r)
    }
    if (rows.length !== lines) writeJsonAtomic(curFile, { lines: rows.length, at: Date.now() })
  }
  return out
}

/** 只数一数积压（doctor / metrics 用）。 */
export function backlog() {
  let n = 0
  try {
    for (const name of fs.readdirSync(inboxDir())) {
      if (!name.endsWith('.jsonl')) continue
      const file = path.join(inboxDir(), name)
      const cur = readJson(inboxCursor(file), { lines: 0 }) || { lines: 0 }
      n += Math.max(0, readJsonl(file).length - Number(cur.lines || 0))
    }
  } catch {}
  return n
}