// brain/store —— 写锁 + 原子事务（v3 的 I1「单写者」在这里落地）。
//
// 设计取舍（为什么不搞一个中心进程）：
//   本机没有服务管理器、机器还会睡眠，多一个常驻进程就多一种"半夜没了"的故障。
//   单写者的实质是"同一时刻只有一个写者"，用**带 TTL 的写锁 + temp/rename** 就能保证，
//   而每个 IO 进程只写自己的 inbox 分片（天然单写者）。
//
// 锁的语义：
//   · 只有短事务持锁（读-改-写一份 JSON），持锁期间不做网络/LLM。
//   · 持锁进程死了 → pid 探活失败或 ts 超过 staleMs → 下一个人直接接管。
import fs from 'node:fs'
import path from 'node:path'
import { ensureDir, readJson, writeJsonAtomic, shortHash } from './json.mjs'
import { lockPath } from './paths.mjs'

const sab = new Int32Array(new SharedArrayBuffer(4))
export function sleepSync(ms) {
  try { Atomics.wait(sab, 0, 0, Math.max(1, ms)) } catch { const t = Date.now(); while (Date.now() - t < ms) { /* spin */ } }
}

function alive(pid) {
  try { process.kill(Number(pid), 0); return true } catch (e) { return e && e.code === 'EPERM' }
}

/**
 * 拿锁执行一段同步逻辑。拿不到（超时）就抛 —— 调用方决定是跳过还是重试。
 */
export function withLock(name, fn, { timeoutMs = 3000, staleMs = 15000 } = {}) {
  const file = lockPath(name)
  ensureDir(path.dirname(file))
  const started = Date.now()
  for (;;) {
    let fd = null
    try {
      fd = fs.openSync(file, 'wx')
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      let hold = null
      try { hold = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}
      const stale = !hold || !hold.ts || (Date.now() - Number(hold.ts) > staleMs) || !alive(hold.pid)
      if (stale) { try { fs.rmSync(file, { force: true }) } catch {} ; continue }
      if (Date.now() - started > timeoutMs) throw new Error(`brain 写锁忙：${name}`)
      sleepSync(15 + Math.floor(Math.random() * 25))
      continue
    }
    try {
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now(), name }))
    } finally {
      try { fs.closeSync(fd) } catch {}
    }
    try {
      return fn()
    } finally {
      try { fs.rmSync(file, { force: true }) } catch {}
    }
  }
}

/** 读-改-写一份 JSON（原子）。fn 返回 undefined 表示不改。 */
export function mutateJson(file, fallback, fn) {
  const key = 'json-' + shortHash(path.resolve(file))
  return withLock(key, () => {
    const cur = readJson(file, fallback)
    const next = fn(cur)
    const value = next === undefined ? cur : next
    writeJsonAtomic(file, value)
    return value
  })
}

/** 游标（inbox / 巩固 / 索引都能用）。 */
export function readCursor(file, fallback = {}) {
  return readJson(file, fallback)
}
export function writeCursor(file, value) {
  return writeJsonAtomic(file, value)
}

/** 一次性独占（巩固任务这类"同一时刻只能有一个"的活）。 */
export function tryExclusive(name, { staleMs = 10 * 60 * 1000 } = {}) {
  const file = lockPath(name)
  ensureDir(path.dirname(file))
  try {
    const hold = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (hold && hold.pid && alive(hold.pid) && Date.now() - Number(hold.ts || 0) < staleMs) return null
    fs.rmSync(file, { force: true })
  } catch {}
  try {
    const fd = fs.openSync(file, 'wx')
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now(), name }))
    fs.closeSync(fd)
  } catch { return null }
  const release = () => {
    try {
      const hold = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (hold?.pid === process.pid) fs.rmSync(file, { force: true })
    } catch {}
  }
  return release
}

/** 心跳：长时间任务里定期调一下，别被当成死锁接管。 */
export function touchLock(name) {
  const file = lockPath(name)
  try {
    const hold = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (hold?.pid === process.pid) writeJsonAtomic(file, { ...hold, ts: Date.now() })
  } catch {}
}