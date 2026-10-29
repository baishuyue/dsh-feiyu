// brain/taskqueue —— 身体/工具协议（v3 §6）：脑出任务，身体执行，结果回账。
//
// 为什么不在事件循环里直接干：看番/剪片/发视频要几十秒到几分钟，钉住事件循环她就不能回话。
// 所以：脑只往队列里放一条"要做的事"，常驻体（qq-server）认领、异步 spawn、把结果写回来。
//
// 协议（全部落盘，进程崩了能续）：
//   enqueue({kind,args,note}) → 行 {id,kind,args,note,state:'queued',fencing:0}
//   claim(worker)             → 拿最老的一条 queued（或租约过期的），state='leased'
//   complete(id,{ok,result})  → state='done'|'failed'，追加 task/log.jsonl
// 白名单：只许跑认识的 kind（**不认字符串拼命令**，args 必须是数组、逐个透传）。
import path from 'node:path'
import { taskDir } from './paths.mjs'
import { readJson, writeJsonAtomic, appendJsonl, readJsonl, mutateJson } from './json.mjs'
import { bump } from './metrics.mjs'
import { withLock } from './store.mjs'

export const KINDS = ['binge', 'produce', 'dm-read', 'card-open', 'tts', 'web-search', 'backup']
const queueFile = () => path.join(taskDir(), 'tasks.json')
const logFile = () => path.join(taskDir(), 'task-log.jsonl')
const MAX_ROWS = 400
let seq = 0
const newId = () => `tk-${Date.now().toString(36)}-${(++seq).toString(36)}`

export function enqueue({ kind, args = [], note = '', priority = 0, ttlMs = 30 * 60_000, now = Date.now() } = {}) {
  const k = String(kind || '')
  if (!KINDS.includes(k)) return { ok: false, reason: 'unknown-kind' }
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) return { ok: false, reason: 'bad-args' }
  const row = {
    id: newId(), kind: k, args: args.slice(0, 12), note: String(note || '').slice(0, 200),
    priority: Number(priority) || 0, state: 'queued', createdAt: now, ttlMs: Number(ttlMs) || 1800000,
    lease: null, fencing: 0,
  }
  const out = withLock('tasks', () => {
    const q = readJson(queueFile(), { rows: [] })
    q.rows = [...(q.rows || []), row].slice(-MAX_ROWS)
    writeJsonAtomic(queueFile(), q)
    return true
  })
  if (!out) return { ok: false, reason: 'lock-timeout' }
  bump('taskQueued')
  return { ok: true, task: row }
}

/** 认领一条。worker 名字只用来排查（谁拿走的）。 */
export function claim(worker = 'qq-server', { now = Date.now(), leaseMs = 180000 } = {}) {
  const r = withLock('tasks', () => {
    const q = readJson(queueFile(), { rows: [] })
    const rows = q.rows || []
    const free = (t) => t.state === 'queued' || (t.state === 'leased' && Number(t.lease?.until || 0) < now)
    const pick = rows.filter(free).sort((a, b) => (b.priority - a.priority) || (a.createdAt - b.createdAt))[0]
    if (!pick) return null
    pick.state = 'leased'
    pick.fencing = Number(pick.fencing || 0) + 1
    pick.lease = { holder: String(worker).slice(0, 40), until: now + Number(leaseMs), at: now }
    writeJsonAtomic(queueFile(), q)
    return { ...pick }
  })
  if (!r) return { ok: false, reason: 'empty-or-lock' }
  bump('taskClaimed')
  return { ok: true, task: r }
}

export function complete(id, { ok = false, result = '', error = '', now = Date.now() } = {}) {
  const r = withLock('tasks', () => {
    const q = readJson(queueFile(), { rows: [] })
    const row = (q.rows || []).find((t) => t.id === id)
    if (!row) return null
    row.state = ok ? 'done' : 'failed'
    row.finishedAt = now
    row.result = String(result || '').slice(0, 2000)
    row.error = String(error || '').slice(0, 400)
    row.lease = null
    // 收尾后从队列里挪走，只留 log（队列保持短）
    q.rows = (q.rows || []).filter((t) => t.id !== id)
    writeJsonAtomic(queueFile(), q)
    return { ...row }
  })
  if (!r) return { ok: false, reason: 'not-found' }
  appendJsonl(logFile(), { id, kind: r.kind, ok: Boolean(ok), result: r.result, error: r.error, at: now, tookMs: now - Number(r.createdAt || now) })
  bump(ok ? 'taskDone' : 'taskFailed')
  return { ok: true, task: r }
}

export function list({ state = '' } = {}) {
  const rows = (readJson(queueFile(), { rows: [] }).rows) || []
  return state ? rows.filter((r) => r.state === state) : rows
}

export function history(limit = 50) {
  return readJsonl(logFile(), { limit })
}

export function stats() {
  const rows = list()
  return {
    queued: rows.filter((r) => r.state === 'queued').length,
    leased: rows.filter((r) => r.state === 'leased').length,
    kinds: KINDS,
  }
}

/** 给 CLI 用的：把一条 task 还原成 argv（白名单 kind + 逐项参数，绝不拼 shell）。 */
export function argvOf(task) {
  if (!task || !KINDS.includes(String(task.kind))) return null
  return [String(task.kind), ...(task.args || []).map(String)]
}