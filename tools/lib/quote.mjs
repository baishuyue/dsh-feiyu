// 引用消息（10-27）—— 她能"看见"别人引用的到底是哪一条
//
// 病根：QQ/OneBot 的引用是这样上报的
//   message: [ { type:'reply', data:{ id:'1234567' } }, { type:'text', data:{ text:'这句啥意思' } } ]
// 老代码只把 reply 段折成一句「【引用回复了一条消息】」，**被引用的正文一个字都没取**。
// 于是主人引用她的"我明天去看番"再问"你去了吗"，她看到的是"【引用回复了一条消息】你去了吗"，
// 只能瞎猜，答得驴唇不对马嘴。
//
// 这里做三件事：
//   ① 她自己发出去的每条消息，把 message_id → 正文 记进一个小环形表（引用自己的话时零延迟、零请求）
//   ② 收到消息时同样登记（主人引用的常常是他自己或群友前面那句）
//   ③ 表里没有 → 让 NapCat 的 get_msg 把原文取回来（含图片/语音/卡片的描述）
import fs from 'node:fs'
import { dataPath } from './paths.mjs'

const MAX = 400                      // 环形表上限（够覆盖最近一两天的来回）
const FILE = () => dataPath('msg-index.json')
const ring = new Map()               // id -> { who, text, name, at }
let dirty = false
let loaded = false

function load() {
  if (loaded) return
  loaded = true
  try {
    const arr = JSON.parse(fs.readFileSync(FILE(), 'utf8'))
    for (const it of Array.isArray(arr) ? arr : []) if (it?.id) ring.set(String(it.id), it)
  } catch {}
}

function flush() {
  if (!dirty) return
  dirty = false
  try {
    const arr = [...ring.entries()].slice(-MAX).map(([id, v]) => ({ id, ...v }))
    fs.writeFileSync(FILE(), JSON.stringify(arr), 'utf8')
  } catch {}
}

/** 登记一条"说过的消息"。who: me | owner | other */
export function remember(id, { text = '', who = 'other', name = '', at = Date.now() } = {}) {
  const key = String(id ?? '').trim()
  if (!key || key === 'undefined' || key === 'null') return
  load()
  const t = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!t) return
  ring.set(key, { who, text: t.slice(0, 300), name: String(name ?? '').slice(0, 24), at })
  while (ring.size > MAX) ring.delete(ring.keys().next().value)
  dirty = true
  if (ring.size % 10 === 0) flush()
}

export function get(id) {
  load()
  return ring.get(String(id ?? '')) || null
}

export function save() { flush() }

/** 把一条被引用的消息说给她听。speakerLabel 是"现在说话的人"（群聊用昵称）。 */
export function describe(rec, { selfName = '你', selfQQ = '', ownerQQ = '' } = {}) {
  if (!rec) return '【他引用了一条消息，但原文我没取到（可能是很久以前的/已撤回）】'
  const who = rec.who === 'me' ? '你自己刚说的'
    : rec.who === 'owner' ? '他自己前面说的'
    : rec.name ? `${rec.name}说的` : '别人说的'
  const when = timeOf(rec.at)
  return `【他引用的是${who}这一句${when ? '（' + when + '）' : ''}：「${rec.text}」】`
}

function timeOf(ts) {
  try {
    const d = new Date(Number(ts))
    if (!Number.isFinite(d.getTime())) return ''
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
  } catch { return '' }
}

/** OneBot 的 get_msg 返回体 → 一条可登记的记录（供 qq-server 调）。 */
export function fromGetMsg(data, { selfQQ = '', ownerQQ = '', parseMessage }) {
  if (!data || typeof data !== 'object') return null
  const senderQQ = String(data.sender?.user_id ?? data.user_id ?? '')
  const p = parseMessage ? parseMessage(data.message, selfQQ) : { text: String(data.raw_message ?? ''), images: [], marks: [] }
  const bits = [p.text, ...(p.marks || [])].filter(Boolean)
  const text = bits.join(' ').trim()
  if (!text) return null
  return {
    who: senderQQ && senderQQ === String(selfQQ) ? 'me' : (senderQQ && senderQQ === String(ownerQQ) ? 'owner' : 'other'),
    text,
    name: String(data.sender?.card || data.sender?.nickname || senderQQ || '').slice(0, 24),
    at: Number(data.time) ? Number(data.time) * 1000 : Date.now(),
  }
}

/** 从消息段里挖引用 id（array 与 CQ 码两种上报都认）。 */
export function replyIdOf(message) {
  if (Array.isArray(message)) {
    const seg = message.find((s) => s?.type === 'reply')
    return String(seg?.data?.id ?? seg?.data?.message_id ?? '').trim()
  }
  if (typeof message === 'string') {
    const m = /\[CQ:reply,id=(-?\d+)/.exec(message)
    return m ? m[1] : ''
  }
  return ''
}

export function size() { load(); return ring.size }
export function clear() { ring.clear(); dirty = true; flush() }