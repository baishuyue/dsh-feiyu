// 辅助服务守护（10-27）
// 病根：抖音私信陪聊（douyin-dm-server）是**插件启动时 spawn 一次**的子进程，
// 它一崩就再没人管 —— 真实发生：09:46 起过一次，之后进程没了，主人发私信一整天没人回。
// qq-server 是唯一的常驻体（插件会拉它、dsd 里也能看见），所以让它当监工：
//   · 每 90s 探一次 /health，死了就拉起来（带退避，别 crash-loop）
//   · 同时兜 B站 自己作品评论的巡检（主人要的"有新评论就自己去回"）
// 只做**拉起**，不做杀进程：插件自己那份逻辑还在，谁先起算谁的，探测到活着就什么都不做。
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { config } from './config.mjs'
import { dataPath } from './paths.mjs'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const FEIYU_MJS = path.join(ROOT, 'tools', 'feiyu.mjs')
const SUP_FILE = () => dataPath('aux-supervisor.json')

function readState() {
  try { return JSON.parse(fs.readFileSync(SUP_FILE(), 'utf8')) } catch { return {} }
}
function writeState(s) {
  try { fs.mkdirSync(path.dirname(SUP_FILE()), { recursive: true }); fs.writeFileSync(SUP_FILE(), JSON.stringify(s, null, 1)) } catch {}
}

function say(line) {
  const t = new Date().toISOString().replace('T', ' ').slice(0, 19)
  try {
    fs.mkdirSync(path.dirname(SUP_FILE()), { recursive: true })
    fs.appendFileSync(dataPath('aux-supervisor.log'), `${t} ${line}\n`)
  } catch {}
}

/** 端口上到底活没活（HTTP /health 优先，退化成 TCP 探测）。 */
export async function probeHealth(port, timeoutMs = 2500) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!r.ok) return { alive: false, why: 'HTTP ' + r.status }
    const j = await r.json().catch(() => ({}))
    return { alive: j?.ok !== false, json: j }
  } catch (e) {
    return { alive: false, why: String(e?.message || e).slice(0, 60) }
  }
}

function spawnDetached(args, logName, env = {}) {
  const logPath = dataPath(logName)
  fs.mkdirSync(path.dirname(logPath), { recursive: true })
  const fd = fs.openSync(logPath, 'a')
  const child = spawn(process.execPath, [FEIYU_MJS, ...args], {
    detached: true,
    windowsHide: true,
    stdio: ['ignore', fd, fd],
    env: { ...process.env, ...env },
  })
  child.unref()
  try { fs.closeSync(fd) } catch {}
  return child
}

/**
 * 保证抖音私信陪聊活着。
 * 退避：同一个服务 10 分钟内最多拉起 3 次，之后改成 10 分钟一次并喊一声（防止死循环刷进程）。
 */
export async function ensureDouyinDm({ force = false } = {}) {
  const cfg = config()
  if (cfg.platforms?.douyin === false || cfg.douyin?.enabled === false) return { skipped: 'douyin.enabled 关着' }
  if (cfg.douyin?.dm?.enabled === false) return { skipped: 'douyin.dm.enabled 关着' }
  const port = String(cfg.douyin?.dm?.port || 8095)
  const h = await probeHealth(port)
  if (h.alive) return { alive: true, port, json: h.json }

  const st = readState()
  const key = 'douyin-dm'
  const now = Date.now()
  const rec = st[key] || { tries: [], lastStart: 0 }
  rec.tries = (rec.tries || []).filter((t) => now - t < 10 * 60_000)
  if (!force) {
    if (rec.tries.length >= 3 && now - rec.lastStart < 10 * 60_000) {
      say(`抖音私信 10 分钟内已拉起 ${rec.tries.length} 次都没活，先等一等（端口 ${port}）`)
      st[key] = rec; writeState(st)
      return { alive: false, port, backedOff: true, tries: rec.tries.length }
    }
  }
  const child = spawnDetached(['douyin-dm-server', '--port', port], 'douyin-dm-watchdog.log')
  rec.tries.push(now); rec.lastStart = now
  st[key] = rec; writeState(st)
  say(`抖音私信没在跑（${h.why || '端口空'}）→ 已拉起 PID ${child.pid}，端口 ${port}`)
  return { alive: true, started: true, pid: child.pid, port }
}

/** B站 自己作品评论巡检：到点就跑一次 replies --own-only --go（额度/自刹车由它自己管）。 */
const lastOwnScan = { at: 0, running: false }
export async function ensureBiliOwnReply({ everyMin = 0 } = {}) {
  const cfg = config()
  const rp = cfg.bilibili?.replies ?? {}
  if (!cfg.bilibili || cfg.bilibili.enabled === false) return { skipped: 'bilibili 关着' }
  if (rp.enabled !== true || rp.ownWorks === false) return { skipped: 'bilibili.replies 关着' }
  const every = Number(everyMin || rp.autoMin || 12) * 60_000
  if (!everyMin && Date.now() - lastOwnScan.at < every) return { skipped: '还没到点' }
  if (lastOwnScan.running) return { skipped: '上一轮还在跑' }
  lastOwnScan.running = true
  try {
    const out = await new Promise((resolve) => {
      const child = spawn(process.execPath, [FEIYU_MJS, 'replies', '--own-only', '--go', '--max', '2'], { windowsHide: true })
      let buf = ''
      child.stdout.on('data', (d) => { buf += d.toString() })
      child.stderr.on('data', (d) => { buf += d.toString() })
      child.on('exit', () => resolve(buf))
      child.on('error', (e) => resolve(buf + '\n' + e.message))
    })
    lastOwnScan.at = Date.now()
    const interesting = out.split('\n').filter((l) => /已回复|回评失败|新评论|⛔|⚠|自己作品/.test(l)).slice(0, 6).join(' | ')
    if (interesting) say(`B站 自己作品巡检：${interesting}`)
    return { ran: true, out: interesting }
  } finally {
    lastOwnScan.running = false
  }
}

/** qq-server 启动时挂上：先原地修一次，之后每 90s 探活。 */
export function superviseAux({ intervalMs = 90_000 } = {}) {
  const tick = async () => {
    try { await ensureDouyinDm() } catch (e) { say('探抖音私信出错：' + String(e.message).slice(0, 80)) }
    try { await ensureBiliOwnReply() } catch (e) { say('B站 巡检出错：' + String(e.message).slice(0, 80)) }
  }
  setTimeout(() => { void tick() }, 8_000)
  return setInterval(() => { void tick() }, Math.max(30_000, intervalMs))
}