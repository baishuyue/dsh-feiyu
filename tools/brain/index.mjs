// brain/index —— 脑的对外门面：IO 进程只跟这里打交道（v3 §2/§6）。
//
// 约定：**任何导出的函数都不抛**。脑是旁路，宁可这一轮没记住，也不许把聊天带崩。
import { config } from '../lib/config.mjs'
import { extract as extractOwnerFacts } from '../lib/owner-facts.mjs'
import * as event from './event.mjs'
import * as episode from './episode.mjs'
import * as working from './working.mjs'
import * as attention from './attention.mjs'
import * as intents from './intents.mjs'
import * as facts from './facts.mjs'
import * as affect from './affect.mjs'
import * as delivery from './delivery.mjs'
import * as claim from './claim.mjs'
import * as assembleMod from './assemble.mjs'
import * as consolidate from './consolidate.mjs'
import * as doctor from './doctor.mjs'
import * as metrics from './metrics.mjs'
import * as recall from './recall.mjs'
import * as selfM from './self.mjs'
import * as schema from './schema.mjs'
import * as competence from './competence.mjs'
import * as taskqueue from './taskqueue.mjs'
import * as backfill from './backfill.mjs'

export { event, episode, working, attention, intents, facts, affect, delivery, claim, assembleMod as assemble, consolidate, doctor, metrics, recall, selfM, schema, competence, taskqueue, backfill }

const OWNER_KEY_MAP = { food: 'food.eat', doing: 'activity.do', plan: 'plan.go', mood: 'mood.state', media: 'media.like' }

/** 启动时调一次：注入主人身份 + 确保自我文件在。 */
export function configure(cfg = config()) {
  try {
    const b = cfg.brain || {}
    event.setOwnerIds(b.ownerIds || [])
    if (b.enabled !== false) selfM.ensure()
  } catch {}
}

export function mode() {
  try { return String(config().brain?.mode || 'off') } catch { return 'off' }
}

/**
 * 这个 chat 是否走新装配。
 * 私聊：platform 在 livePlatforms 里就切；群聊：必须显式列进 liveGroups（群聊的对照组最要紧）。
 */
export function liveFor({ platform = 'qq', chatId = '', isGroup = false } = {}) {
  try {
    const b = config().brain || {}
    if (b.enabled === false || b.mode !== 'live') return false
    const platforms = Array.isArray(b.livePlatforms) && b.livePlatforms.length ? b.livePlatforms : ['qq']
    const chats = Array.isArray(b.liveChats) ? b.liveChats.filter(Boolean) : []
    if (isGroup) {
      const groups = Array.isArray(b.liveGroups) ? b.liveGroups.filter(Boolean) : []
      if (!groups.length) return false
      if (!platforms.includes(platform)) return false
      return groups.includes(String(chatId))
    }
    if (!platforms.includes(platform)) return false
    if (chats.length && !chats.includes(String(chatId))) return false
    return true
  } catch { return false }
}

/** 事件进脑（IO 侧调用；同步、极快、永不抛）。 */
export function onEvent(input = {}) {
  try {
    const r = event.emit(input)
    if (!r.ok) return r
    const ev = r.event
    try { episode.ingest({ limit: 20 }) } catch {}
    const eps = episode.allEpisodes()
    const ep = eps.find((e) => e.srcEv === ev.ev) || null
    if (ep && ev.who.kind === 'owner') learnOwnerFacts(ev, ep.id)
    if (ep) {
      try {
        working.refresh(ev.where.chat, {
          topic: ep.gist.slice(0, 80),
          mood: affect.line().replace(/^你现在的底色：/, '').slice(0, 60),
          recallA: ep.quote ? `刚说的：${ep.quote.slice(0, 60)}` : '',
        })
      } catch {}
      try {
        attention.arrive({
          chat: ev.where.chat,
          label: ep.gist,
          kind: 'chat',
          urgency: attention.urgencyOf({
            isOwner: ev.who.kind === 'owner',
            isPrivate: ev.scope === 'private',
            atMe: ev.meta?.atMe,
            important: /答应|说好|记得|几点|叫我|提醒/.test(ev.text),
            emotion: Math.abs(Number(ep.feel?.valence || 0)),
          }),
        })
      } catch {}
      try { affect.feel({ valence: ep.feel.valence, arousal: ep.feel.arousal }) } catch {}
    }
    return { ok: true, event: ev, ep }
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) }
  }
}

/** 主人一句话里的事实 → 结构化事实（带 ep 证据）。 */
export function learnOwnerFacts(ev, epId) {
  const got = extractOwnerFacts(ev.text)
  for (const g of got) {
    const p = OWNER_KEY_MAP[g.key] || 'note'
    facts.add({
      s: 'owner', p, o: g.value,
      validFrom: ev.at, validUntil: null,
      prov: [epId], source: 'owner', conf: 0.8, raw: g.line, now: ev.at,
    })
  }
  return got
}

/** 一条消息真的发出去了：记交付证据；若挂了意图，顺手结算。 */
export function onSent({ chat = '', text = '', msgId = '', platform = '', intentId = '', kind = 'text', at = Date.now() } = {}) {
  try {
    const row = delivery.record({ chat, text, msgId, platform, intentId, kind, at })
    if (intentId) intents.settle(intentId, { ok: true, evidence: [`delivery:${chat}#${msgId || row.hash}`], now: at })
    return row
  } catch { return null }
}

/**
 * 出站前过声称闸：没证据的"我看完了"当场改成"我正要看"。
 * @returns {{text:string, changed:boolean}}
 */
export function craftReply(text, { chat = '', now = Date.now() } = {}) {
  try {
    const b = config().brain || {}
    if (b.claim?.enabled === false) return { text: String(text || ''), changed: false }
    const r = claim.gate(text, { chat, now })
    return { text: r.text, changed: r.changed }
  } catch { return { text: String(text || ''), changed: false } }
}

/** 新装配（live 模式才用；其余情况返回 null，调用方落回 buildMessages）。 */
export function assembleFor(opts = {}) {
  if (!liveFor(opts)) return null
  try { return assembleMod.assemble(opts) } catch { return null }
}

/**
 * 每分钟的心跳（qq-server 已有 tick 里调）：补做 + 报告"该巩固了"。
 * 巩固本身要调 LLM，不许在本进程里做 —— 由调用方 spawn 子进程。
 */
export function tick(now = Date.now()) {
  const out = { catchUp: null, shouldConsolidate: false, backlog: 0, due: [] }
  try { episode.ingest({ limit: 200 }) } catch {}
  try { out.catchUp = intents.catchUp(now) } catch {}
  try { out.backlog = event.backlog() } catch {}
  try { out.due = intents.due(now).map((x) => ({ id: x.id, object: x.object, action: x.action, verify: x.verify, lateH: Math.round((now - Number(x.dueAt)) / 3600_000) })) } catch {}
  try {
    const b = config().brain || {}
    const at = String(b.consolidateAt || '04:30')
    const [h, m] = at.split(':').map(Number)
    const d = new Date(now)
    const target = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h || 4, m || 30, 0, 0).getTime()
    const st = consolidate.status()
    const ageH = st.lastRunAt ? (now - st.lastRunAt) / 3600_000 : 999
    out.shouldConsolidate = now >= target && ageH >= 20
  } catch {}
  return out
}

/** 巩固（CLI / 子进程调用）。chatFn 可选，不传就只跑规则。 */
export function runConsolidation({ now = Date.now(), chatFn = null, dryRun = false } = {}) {
  const r = consolidate.run({ now, chatFn, dryRun })
  try { if (!dryRun) rebuildDerived({ now }) } catch {}
  return r
}

/** 派生层重建：图式（O6）+ 能力自评（O13）。都是可删可重建的，失败不算数据事故。 */
export function rebuildDerived({ now = Date.now(), write = true } = {}) {
  const out = { schema: null, competence: null }
  try { out.schema = schema.build({ now, write }) } catch (e) { out.schema = { error: String(e?.message || e) } }
  try { out.competence = competence.derive({ now, write }) } catch (e) { out.competence = { error: String(e?.message || e) } }
  return out
}

export function status() {
  try { return doctor.run({ measurePrompt: false }) } catch (e) { return { ok: false, error: String((e && e.message) || e) } }
}