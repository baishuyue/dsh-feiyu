// brain/attention —— 注意力：一个时刻只有一个"正在生成"（v3 O2 / I2）。
//
// 现状：四个生成器各跑各的（tryProactive / tryGroupChat / douyin tick / qq handle），
// 靠 chance 掷骰子决定她"想不想说话"。结果是他发消息时她可能正在别处生成，
// 或者两个通道同时开口。这里把它变成：**排队 + 优先级 + 租约**。
import { readJson, mutateJson } from './json.mjs'
import { attentionPath, genPath } from './paths.mjs'
import { bump } from './metrics.mjs'

const empty = () => ({
  focus: null,                       // {chat, since, label}
  inbox: [],                         // [{id, chat, label, urgency, at, kind}]
  policy: { interruptAbove: 0.75, queueAbove: 0.35, dropBelow: 0.2, maxQueueMin: 30 },
  updatedAt: 0,
})

export function policy() {
  return readJson(attentionPath(), empty())?.policy || empty().policy
}

/** 紧迫度（0..1）：主人 > 私聊/@ > 连续消息 > 正事 > 等待 > 情绪。 */
export function urgencyOf({ isOwner = false, isPrivate = false, atMe = false, streak = 1, important = false, waitedMin = 0, emotion = 0 }) {
  const s = 0.35 * (isOwner ? 1 : isPrivate ? 0.5 : 0.2)
    + 0.20 * (isPrivate || atMe ? 1 : 0.3)
    + 0.15 * Math.min(1, Math.max(0, (streak - 1) / 3))
    + 0.15 * (important ? 1 : 0)
    + 0.10 * Math.min(1, waitedMin / 30)
    + 0.05 * Math.min(1, Math.abs(emotion))
  return Number(Math.max(0, Math.min(1, s)).toFixed(3))
}

/** 一条消息到达：进队列（同 chat 合并，只留最新一条的紧迫度里最高的）。 */
export function arrive({ chat, label = '', urgency = 0.3, kind = 'chat', ev = '', now = Date.now() }) {
  const st = readJson(attentionPath(), empty()) || empty()
  st.inbox = Array.isArray(st.inbox) ? st.inbox : []
  const prev = st.inbox.filter((x) => x.chat === chat)
  st.inbox = st.inbox.filter((x) => x.chat !== chat)
  st.inbox.push({
    id: ev || `q_${now.toString(36)}`,
    chat, label: String(label).slice(0, 60), kind,
    urgency: Math.max(Number(urgency) || 0, ...prev.map((x) => Number(x.urgency) || 0), 0),
    at: prev[0]?.at || now,
    streak: prev.length + 1,
  })
  st.inbox.sort((a, b) => (b.urgency - a.urgency) || (a.at - b.at))
  st.inbox = st.inbox.slice(0, 12)
  st.updatedAt = now
  try { mutateJson(attentionPath(), empty(), () => st) } catch {}
  bump('attentionIn')
  return st.inbox
}

export function state() {
  const st = readJson(attentionPath(), empty())
  return { ...empty(), ...(st || {}) }
}

/** 当前谁在生成（含租约）。 */
export function leaseState(now = Date.now()) {
  const g = readJson(genPath(), { chat: null, holder: '', until: 0, fencing: 0 }) || {}
  const alive = g.chat && Number(g.until) > now
  return { ...g, alive }
}

/**
 * 申请生成租约。同 chat 串行；别的 chat 正在生成时，只有紧迫度高于 interruptAbove 才排队等待
 * —— 注意：永远不打断正在进行的那一句（半句比晚回更糟），只是决定"下一句先回谁"。
 */
export function claim(chat, holder = String(process.pid), { ttlMs = 90_000, now = Date.now() } = {}) {
  const g = leaseState(now)
  if (g.alive && g.chat !== chat) return { ok: false, reason: 'busy', busyWith: g.chat, until: g.until }
  if (g.alive && g.chat === chat && g.holder !== holder) return { ok: false, reason: 'same-chat-busy', until: g.until }
  const next = { chat, holder, until: now + ttlMs, fencing: Number(g.fencing || 0) + 1, at: now }
  try { mutateJson(genPath(), {}, () => next) } catch {}
  return { ok: true, fencing: next.fencing }
}

export function release(chat, holder = String(process.pid)) {
  const g = leaseState()
  if (g.chat === chat && g.holder === holder) {
    try { mutateJson(genPath(), {}, () => ({ chat: null, holder: '', until: 0, fencing: Number(g.fencing || 0) })) } catch {}
  }
}

export function setFocus(chat, label = '') {
  try {
    mutateJson(attentionPath(), empty(), (cur) => ({ ...(cur || empty()), focus: chat ? { chat, since: Date.now(), label } : null, updatedAt: Date.now() }))
  } catch { return null }
  return { chat, label }
}

export function focus(now = Date.now()) {
  const st = state()
  if (!st.focus) return null
  return { ...st.focus, minutes: Math.max(0, Math.round((now - Number(st.focus.since || now)) / 60000)) }
}

/** 下一条该回谁（队列里优先级最高的那条；低于 dropBelow 的丢掉）。 */
export function next(now = Date.now()) {
  const st = state()
  const p = st.policy || empty().policy
  const alive = (st.inbox || []).filter((x) => now - Number(x.at) <= p.maxQueueMin * 60_000)
  const kept = alive.filter((x) => Number(x.urgency) >= p.dropBelow)
  if (alive.length !== kept.length) bump('attentionDropped', alive.length - kept.length)
  const head = kept.sort((a, b) => (b.urgency - a.urgency) || (a.at - b.at))[0] || null
  if (!head) return null
  const waitedMin = Math.round((now - Number(head.at)) / 60000)
  return { ...head, waitedMin, overQueue: Number(head.urgency) < p.queueAbove }
}

/** 从队列里移除已处理的 chat。 */
export function done(chat) {
  try {
    mutateJson(attentionPath(), empty(), (cur) => {
      const st = { ...empty(), ...(cur || {}) }
      st.inbox = (st.inbox || []).filter((x) => x.chat !== chat)
      return st
    })
  } catch {}
}

/** 给她自己看/给别人看的一行："正忙着看番 3 分钟"。 */
export function busyLine(now = Date.now()) {
  const g = leaseState(now)
  if (!g.alive) return ''
  const f = focus(now)
  const label = f?.label || '别的事'
  const min = Math.max(1, Math.round((now - Number(g.at || now)) / 60000))
  return `正在${label}，${min} 分钟了`
}