// B站 API 层：WBI 签名 + 24h 缓存 + 风控熔断 + 300ms 节流。
// 复用 dsh-bili-whale 的 tools/lib/bili-api.mjs（MIT）的完整实现 ——
// 这层是它被 B站 风控反复教育后的成果（缓存/退避/节流/playurl 的 -412 误伤判定），
// 别自己另写一套 ✗。改动：数据路径 → ~/.feiyu-ai，环境变量 → FEIYU_NO_CACHE，
// 并为 feed 增加 search/type 的 WBI 映射。
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { dataPath } from './paths.mjs'

const MIXIN = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52]
const keyOf = u => String(u).split('/').at(-1).split('.')[0]

export function signWbi(params, images, now = Date.now()) {
  const raw = keyOf(images?.img_url ?? '') + keyOf(images?.sub_url ?? '')
  if (raw.length !== 64) throw new Error('WBI 签名密钥缺失，请稍后重试或检查登录状态')
  const key = MIXIN.map(i => raw[i]).join('').slice(0, 32)
  const values = { ...params, wts: Math.floor(now / 1000) }
  delete values.w_rid
  const query = Object.keys(values).sort().map(k => `${encodeURIComponent(k)}=${encodeURIComponent(String(values[k]).replace(/[!'()*]/g, ''))}`).join('&')
  return `${query}&w_rid=${crypto.createHash('md5').update(query + key).digest('hex')}`
}

// ─────────────────────────────────────────────────────────────────────────────
// 三样保护（B站 的 412 是 IP 级限流，换接口救不了）：
//   ① 缓存    同一份元信息 24 小时内只问一次
//   ② 退避    撞到 412/风控码就熔断一段时间，不再硬闯（指数退避，封顶 30 分钟）
//   ③ 节流    两次请求之间至少隔 300ms
// ─────────────────────────────────────────────────────────────────────────────

const CACHE_FILE = dataPath('api-cache.json')
const BAN_FILE = dataPath('api-ban.json')
const REQ_LOG = dataPath('api-requests.log')
const CACHE_TTL_MS = 24 * 3600 * 1000
const logReq = (hit, p) => {
  if (noCacheEnv()) return
  try { fs.appendFileSync(REQ_LOG, `${new Date().toISOString()} ${hit ? 'HIT ' : 'NET '} ${p}\n`) } catch {}
}

// 只缓存「静态一点的元信息」✗ 动态内容（评论/收件箱/动态流）绝不能缓存 ✓
const CACHEABLE = [
  /^\/x\/web-interface\/(wbi\/)?view$/,
  /^\/x\/space\/wbi\/acc\/info$/,
]
const NAV_TTL_MS = 10 * 60 * 1000
// 风控码：撞到就熔断
const BAN_CODES = new Set([-412, -352, -799, -509, -10403])
// playurl 上的 -412 多半是内容受限（大会员/地区/独播），不熔断 —— bili-whale 实测教训
const CONTENT_RESTRICTED = [/^\/x\/player\/(wbi\/)?playurl$/]
const isContentRestricted = (p) => CONTENT_RESTRICTED.some((re) => re.test(p))

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}
function writeJson(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(value))
  } catch {}
}

// 缓存键：去掉每次都变的签名参数（wts / w_rid），按账号摘要隔离
function cacheKey(url, headers) {
  const u = new URL(url)
  if (u.pathname === '/x/web-interface/view') u.pathname = '/x/web-interface/wbi/view'
  const params = [...u.searchParams.entries()]
    .filter(([k]) => k !== 'wts' && k !== 'w_rid')
    .sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv))
  const h = new Headers(headers)
  const account = crypto.createHash('sha256').update(h.get('cookie') ?? '').update('\0').update(h.get('authorization') ?? '').digest('hex')
  return account + ':' + u.hostname + u.pathname + '?' + new URLSearchParams(params).toString()
}
const cacheable = (url) => {
  const u = new URL(url)
  return u.hostname === 'api.bilibili.com' && CACHEABLE.some((re) => re.test(u.pathname))
}
const isNav = (url) => {
  const u = new URL(url)
  return u.hostname === 'api.bilibili.com' && u.pathname === '/x/web-interface/nav'
}

// FEIYU_NO_CACHE=1 → 关掉缓存与熔断（测试/排障用）
const noCacheEnv = () => process.env.FEIYU_NO_CACHE === '1'

let lastRequestAt = 0
let requestQueue = Promise.resolve()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function throttle() {
  const turn = requestQueue.then(async () => {
    const gap = Date.now() - lastRequestAt
    if (gap < 300) await sleep(300 - gap)
    lastRequestAt = Date.now()
  })
  requestQueue = turn.catch(() => {})
  return turn
}

function bannedUntilNow() {
  const b = readJson(BAN_FILE, {})
  return Number(b.until ?? 0) > Date.now() ? Number(b.until) : 0
}
function setBan(ms, why) {
  writeJson(BAN_FILE, { until: Date.now() + ms, why, at: new Date().toISOString() })
}

// 说明：读失败仍返回 {code, message} 形状，让调用方自己决定「必需」还是「可选」。
// cookie 和响应正文永远不会进日志。
export async function apiGet(input, headers = {}, opts = {}) {
  const url = new URL(input)
  const ttl = opts.ttlMs ?? CACHE_TTL_MS
  const noCache = opts.noCache === true
  // ⚠️ 缓存键必须在【改写路径之前】算好（读用原始 view，写完带 w_rid 就永远命中不了）
  const key = cacheKey(url.href, headers)
  const canCache = cacheable(url.href) || isNav(url.href)
  const biliHost = url.hostname === 'bilibili.com' || url.hostname.endsWith('.bilibili.com')
  const stale = () => {
    if (noCache || noCacheEnv() || !cacheable(url.href)) return null
    const hit = readJson(CACHE_FILE, {})[key]
    return hit?.data?.code === 0 && Date.now() - Number(hit.at ?? 0) < 7 * CACHE_TTL_MS
      ? { ...hit.data, _cached: true, _stale: true } : null
  }

  // ① 熔断中：不再打网络
  const banned = noCacheEnv() || !biliHost ? 0 : bannedUntilNow()
  if (banned) {
    const mins = Math.max(1, Math.round((banned - Date.now()) / 60000))
    const hit = stale()
    if (hit) return hit
    return { code: -412, message: `HTTP 412 —— 本机被 B站 限流了，约 ${mins} 分钟后自动恢复（期间用缓存过日子）` }
  }

  // ② 缓存命中
  if (!noCache && canCache && !noCacheEnv()) {
    const hit = readJson(CACHE_FILE, {})[key]
    const useTtl = isNav(url.href) ? NAV_TTL_MS : ttl
    if (hit && Date.now() - Number(hit.at ?? 0) < useTtl) { logReq(true, url.pathname); return { ...hit.data, _cached: true } }
  }

  try {
    const signedPaths = {
      '/x/web-interface/view': '/x/web-interface/wbi/view',
      '/x/player/playurl': '/x/player/wbi/playurl',
      '/x/web-interface/search/type': '/x/web-interface/wbi/search/type',   // feed 选题的搜索源
    }
    if (url.hostname === 'api.bilibili.com' && signedPaths[url.pathname]) {
      const nav = await apiGet('https://api.bilibili.com/x/web-interface/nav', headers, { noCache })
      if (!nav.data?.wbi_img) return { code: -1, message: `WBI 签名不可用：${nav.message || 'nav 未返回密钥'}` }
      url.pathname = signedPaths[url.pathname]
      url.search = signWbi(Object.fromEntries(url.searchParams), nav.data.wbi_img)
    }

    // ③ 节流：两次请求至少隔 300ms
    await throttle()
    if (biliHost && !noCacheEnv() && bannedUntilNow()) return stale() ?? { code: -412, message: 'B站风控退避中，请稍后重试' }

    logReq(false, url.pathname)
    const response = await fetch(url.href, { headers, signal: AbortSignal.timeout(30000) })

    // HTTP 412/429：平台级风控 → 熔断（默认 5 分钟，指数退避封顶 30 分钟）
    if (biliHost && (response.status === 412 || response.status === 429)) {
      const prev = readJson(BAN_FILE, {})
      const streak = Number(prev.streak ?? 0) + 1
      const mins = Math.min(30, 5 * 2 ** (streak - 1))
      if (!noCacheEnv()) setBan(mins * 60_000, `HTTP ${response.status}`)
      if (!noCacheEnv()) writeJson(BAN_FILE, { ...readJson(BAN_FILE, {}), streak, endpoint: url.pathname })
      const hit = stale()
      if (hit) return hit
      return { code: -412, message: `HTTP ${response.status}（B站 风控）—— 已熔断 ${mins} 分钟，别再打了` }
    }
    if (!response.ok) return { code: -1, message: `HTTP ${response.status}（B站风控或接口异常，请稍后重试）` }

    const text = await response.text()
    let data
    try {
      data = JSON.parse(text)
      if (!data || typeof data !== 'object') throw new Error('invalid JSON payload')
    } catch {
      return { code: -1, message: `非 JSON 响应（HTTP ${response.status}），可能是风控或接口变更` }
    }

    // 接口层风控码：同样熔断（B站 有时 HTTP 200 但 code=-412）
    if (biliHost && BAN_CODES.has(Number(data.code))) {
      if (Number(data.code) === -412 && isContentRestricted(url.pathname)) {
        return { ...data, message: `${data.message ?? ''}（这条播放地址受限：大会员专属/地区限制，不是限流）` }
      }
      const prev = readJson(BAN_FILE, {})
      const streak = Number(prev.streak ?? 0) + 1
      const mins = Math.min(30, 5 * 2 ** (streak - 1))
      if (!noCacheEnv()) writeJson(BAN_FILE, { until: Date.now() + mins * 60_000, why: `code=${data.code}`, at: new Date().toISOString(), streak, endpoint: url.pathname })
      return { ...data, message: `${data.message ?? ''}（B站 风控 ${data.code}）—— 已熔断 ${mins} 分钟` }
    }
    // 成功了：清退避计数，写缓存
    if (Number(data.code) === 0) {
      const b = readJson(BAN_FILE, {})
      if (!noCacheEnv() && b.streak && b.endpoint === url.pathname) writeJson(BAN_FILE, { ...b, streak: 0 })
      if (!noCache && canCache && !noCacheEnv()) {
        const store = readJson(CACHE_FILE, {})
        store[key] = { at: Date.now(), data }
        const keys = Object.keys(store)
        if (keys.length > 400) {
          keys.sort((a, b2) => Number(store[a].at ?? 0) - Number(store[b2].at ?? 0))
          for (const k of keys.slice(0, keys.length - 400)) delete store[k]
        }
        writeJson(CACHE_FILE, store)
      }
    }
    return data
  } catch (error) {
    return { code: -1, message: error.name === 'TimeoutError' ? '请求超时（30 秒）' : '请求失败（网络异常或 WBI 签名密钥无效）' }
  }
}

/** 请求头：cookie 从凭据拼（B站 的接口对 UA/referer 都挑食）。 */
export function makeHeaders(cred, extra = {}) {
  return {
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    referer: 'https://www.bilibili.com/',
    cookie: `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}; buvid3=${cred.buvid3}`,
    ...extra,
  }
}

/** 给「依赖体检 / 排障」用的现状。 */
export function apiState() {
  const ban = readJson(BAN_FILE, {})
  const cache = readJson(CACHE_FILE, {})
  const until = Number(ban.until ?? 0)
  return {
    banned: until > Date.now(),
    banMinutesLeft: until > Date.now() ? Math.ceil((until - Date.now()) / 60000) : 0,
    banWhy: ban.why ?? null,
    cacheEntries: Object.keys(cache).length,
  }
}
