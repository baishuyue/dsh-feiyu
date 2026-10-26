// 账本 —— 让她**自己**看得到今天吃了多少饭钱、还能吃多少、今天还能干几件事。
//
// 背景（10-26 主人报）：她记忆里反复问"账本/饭钱"，因为她根本读不到账本 ——
// 一个只把钱挂在嘴上、却查不了账的角色，只能一直问主人。把账本变成她能读的东西，
// 这个圈才闭上。
//
// 三个数据源，全部有据可查：
//   ① token 用量：DSH 自己的会话日志（~/.dsh/sessions/*/*/session.v4.jsonl.zstd）
//      每行一个 zstd 帧、用量在 type=assistant/message 的 data.usage 里 —— 见 ledger_usage.py
//   ② 饭钱折算：token × 单价（config.ledger.price，默认按 DeepSeek 档位估，标 ≈）
//   ③ 动作额度：她自己那几本账（quota.json / bili-actions.json / douyin-*.json / imggen.json）
//
// 余额（官方钱包）走可选接口：config.ledger.balanceUrl + apiKey 配了才查，
// 查不到就明确说"看不到余额"，绝不编一个 0（宁可让她去问主人，也不能骗她）。
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { config } from './config.mjs'
import { dataPath } from './paths.mjs'

const PY_TIMEOUT = 120_000
const USAGE_CACHE = () => dataPath('cache', 'ledger-usage.json')

/** 找 python：voice.python → FEIYU_TTS_PYTHON → GPT-SoVITS 自带 venv（和 prosody 用同一套）。 */
export function pythonPath(cfg = config()) {
  const cands = [
    cfg.voice?.python,
    process.env.FEIYU_TTS_PYTHON,
    'D:/GPT-SoVITS/.venv/Scripts/python.exe',
  ].filter(Boolean)
  for (const c of cands) {
    try {
      if (fs.existsSync(c)) return c
    } catch {}
  }
  return cands[cands.length - 1]
}

function sessionsDir(cfg = config()) {
  const d = cfg.ledger?.sessionsDir
  if (d) return d
  const home = process.env.USERPROFILE || os.homedir()
  return path.join(home, '.dsh', 'sessions')
}

/** 会话日志的指纹（路径+大小+修改时间），变了才重算 —— 21MB 全量扫一次约 1.3 秒。 */
function usageSignature(dir) {
  const parts = []
  try {
    for (const ws of fs.readdirSync(dir)) {
      const wsDir = path.join(dir, ws)
      let inner
      try { inner = fs.readdirSync(wsDir) } catch { continue }
      for (const s of inner) {
        const f = path.join(wsDir, s, 'session.v4.jsonl.zstd')
        let st
        try { st = fs.statSync(f) } catch { continue }
        parts.push(`${ws}/${s}:${st.size}:${Math.round(st.mtimeMs)}`)
      }
    }
  } catch {}
  return createHash('sha1').update(parts.sort().join('|')).digest('hex')
}

/**
 * token 用量（她 / 主人分开）。
 * @returns {Promise<{days:Array, lifetime:object, sessions:number, cached:boolean, error?:string}>}
 */
export async function usage(opts = {}) {
  const cfg = config()
  const dir = opts.sessionsDir || sessionsDir(cfg)
  const sig = usageSignature(dir)
  const cacheFile = USAGE_CACHE()
  if (!opts.fresh) {
    try {
      const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
      if (c.signature === sig && c.data) return { ...c.data, cached: true }
    } catch {}
  }
  const py = opts.python || pythonPath(cfg)
  // 用 fileURLToPath 拼脚本路径：Windows 上 import.meta.url 带盘符和中文/空格路径，
  // 直接切字符串会拼出 /D:/… 这种 python 不认的路径
  const here = path.dirname(fileURLToPath(import.meta.url))
  const args = [path.join(here, 'ledger_usage.py'),
    '--sessions', dir, '--mine', cfg.ledger?.mineWorkspace || 'feiyu-work']
  const data = await new Promise((resolve, reject) => {
    execFile(py, args, { timeout: PY_TIMEOUT, maxBuffer: 32 * 1024 * 1024, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(String(stderr || err.message).slice(0, 400)))
        try { resolve(JSON.parse(String(stdout))) } catch (e) { reject(new Error('账本 python 输出不是 JSON：' + String(stdout).slice(0, 200))) }
      })
  })
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true })
    fs.writeFileSync(cacheFile, JSON.stringify({ signature: sig, at: Date.now(), data }, null, 0))
  } catch {}
  return { ...data, cached: false }
}

// ── 饭钱折算 ────────────────────────────────────────────────────────────────
/** 单价（元/百万 token）。默认值按 DeepSeek 档位估，可在 config.ledger.price 覆盖。 */
export function price(cfg = config()) {
  const p = cfg.ledger?.price || {}
  return {
    input: num(p.inputPerM, 2),
    cache: num(p.cachePerM, 0.2),
    output: num(p.outputPerM, 3),
  }
}

function num(v, d) {
  // null / '' / 非数字都落回默认值 —— 别让 `cachePerM: null` 变成 0：
  // 缓存单价算成 0 会把饭钱算少，账本少报钱比多报更坑
  if (v === null || v === undefined || v === '') return d
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}

/** token 用量 → 元。 */
export function costOf(u, cfg = config()) {
  if (!u) return 0
  const p = price(cfg)
  return (u.input || 0) / 1e6 * p.input + (u.cache || 0) / 1e6 * p.cache + (u.output || 0) / 1e6 * p.output
}

// ── 动作额度 ────────────────────────────────────────────────────────────────
function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

function dayKey(d = new Date()) {
  // 账本文件用的是本地日期（quota.mjs 的 dayKey 同口径）
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 今天的账：她自己那几本（0 = 不限，所以余量显示"不限"）。 */
export function quotas(cfg = config(), today = dayKey(), dir = dataPath()) {
  const q = readJson(path.join(dir, 'quota.json'), { log: [] })
  // quota.mjs 的口径：log 里带 share:true 的才是"分享"，其余是普通回复；at 是 UTC ISO，
  // 判"今天"要用本地日期（toLocaleDateString('sv-SE') === YYYY-MM-DD）
  const log = Array.isArray(q?.log) ? q.log : []
  const localDay = (v) => new Date(v).toLocaleDateString('sv-SE')
  const todayLog = log.filter((e) => e?.at && localDay(e.at) === today)
  const sharesToday = todayLog.filter((e) => e.share).length
  const repliesToday = todayLog.length - sharesToday
  const act = readJson(path.join(dir, 'bili-actions.json'), {})
  const actsToday = act?.day === today ? act : {}
  const one = (name) => {
    const j = readJson(path.join(dir, name), {})
    return j?.day === today ? Number(j.count || 0) : 0
  }
  const list = [
    { key: 'share', label: 'B站 分享', used: Math.max(sharesToday, Number(actsToday.share || 0)), limit: Number(cfg.quota?.shareDaily ?? 3) },
    { key: 'reply', label: 'B站 回评', used: repliesToday, limit: 0 },
    { key: 'dyn', label: 'B站 动态', used: actsToday.dyn ?? 0, limit: Number(cfg.bili?.dynamic?.dailyMax ?? 0) },
    { key: 'img', label: '表情包生成', used: one('imggen.json'), limit: Number(cfg.imageGen?.dailyMax ?? 30) },
    { key: 'douyin-share', label: '抖音 分享', used: one('douyin-share.json'), limit: Number(cfg.douyin?.shareDaily ?? 0) },
    { key: 'douyin-comment', label: '抖音 评论', used: one('douyin-comment.json'), limit: Number(cfg.douyin?.commentDaily ?? 0) },
    { key: 'douyin-produce', label: '抖音 作品', used: one('douyin-produce.json'), limit: Number(cfg.douyin?.produceDaily ?? 0) },
  ]
  return list.map((x) => ({
    ...x,
    left: x.limit > 0 ? Math.max(0, x.limit - x.used) : null,   // null = 不限
  }))
}

/** 可选：官方钱包余额（配了 url+key 才查，其它一律返回 null，不编数字）。 */
export async function balance(cfg = config(), opts = {}) {
  const url = cfg.ledger?.balanceUrl
  const key = cfg.ledger?.apiKey || process.env.DEEPSEEK_API_KEY
  if (!url || !key) return null
  const timeoutMs = Number(cfg.ledger?.balanceTimeoutMs ?? 8000)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }, signal: ctrl.signal })
    if (!r.ok) return null
    const j = await r.json()
    const infos = j?.balance_infos
    if (!Array.isArray(infos) || !infos.length) return null
    const w = infos.find((x) => x?.currency === 'CNY') || infos[0]
    const total = Number(w?.total_balance)
    return Number.isFinite(total) ? { currency: w.currency, total, granted: w.granted_balance, toppedUp: w.topped_up_balance } : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 完整账本。
 * @param {{days?:number, fresh?:boolean}} opts
 */
export async function report(opts = {}) {
  const cfg = config()
  const today = dayKey()
  const u = await usage(opts)
  const days = Array.isArray(u.days) ? u.days : []
  const find = (d) => days.find((x) => x.day === d)
  const todayRow = find(today) || { day: today, mine: emptyTok(), all: emptyTok() }
  const last7 = days.slice(-7)
  const mine7 = last7.reduce((a, r) => addTok(a, r.mine), emptyTok())
  const daysWithUse = last7.filter((r) => (r.mine?.total || 0) > 0).length || 1
  const avgMineCost = costOf(mine7, cfg) / daysWithUse
  const budget = num(cfg.ledger?.dailyBudget, 0)          // 0 = 没设预算
  const todayCost = costOf(todayRow.mine, cfg)
  const bal = opts.balance === false ? null : await balance(cfg)
  return {
    today,
    me: {
      tokens: todayRow.mine,
      cost: round2(todayCost),
      budget: budget > 0 ? budget : null,
      leftOfBudget: budget > 0 ? round2(budget - todayCost) : null,
      overBudget: budget > 0 ? todayCost > budget : false,
    },
    master: { tokens: todayRow.other || emptyTok(), cost: round2(costOf(todayRow.other || emptyTok(), cfg)) },
    week: { days: last7.length, mine: mine7, cost: round2(costOf(mine7, cfg)), avgPerDay: round2(avgMineCost) },
    lifetime: {
      mineTokens: u.lifetime?.mine?.total ?? 0,
      mineCost: round2(costOf(u.lifetime?.mine, cfg)),
    },
    balance: bal,
    runwayDays: bal && avgMineCost > 0 ? Math.floor(bal.total / avgMineCost) : null,
    quotas: quotas(cfg, today),
    price: price(cfg),
    usageCached: !!u.cached,
    sessions: u.sessions ?? 0,
  }
}

function emptyTok() {
  return { input: 0, output: 0, cache: 0, total: 0, calls: 0 }
}

function addTok(a, b) {
  const o = { ...a }
  for (const k of Object.keys(emptyTok())) o[k] = (a?.[k] || 0) + (b?.[k] || 0)
  return o
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100
}

/** 一行摘要（给提示语注入用，别塞太长）。 */
export function brief(r) {
  if (!r) return ''
  const p = []
  p.push(`今天吃了 ${fmtTok(r.me.tokens.total)} token ≈ ¥${r.me.cost}`)
  if (r.me.budget != null) {
    p.push(r.me.overBudget ? `超了预算 ¥${Math.abs(r.me.leftOfBudget)}（预算 ¥${r.me.budget}/天）` : `预算 ¥${r.me.budget}/天，还剩 ¥${r.me.leftOfBudget}`)
  }
  const q = (r.quotas || []).filter((x) => x.limit > 0).map((x) => `${x.label} ${x.left}/${x.limit}`)
  if (q.length) p.push('额度：' + q.join(' · '))
  if (r.balance) p.push(`钱包余额 ¥${r.balance.total}（按这个花法还能撑 ${r.runwayDays} 天）`)
  return p.join(' ； ')
}

// ── 给提示语用的缓存 ──────────────────────────────────────────────────────
// 唤醒/聊天提示都是同步拼字符串，不能在里面 await 一次 python（1.3 秒）。
// 所以由 tick 定时刷一份到 cache，提示语只读这一份。
const BRIEF_CACHE = () => dataPath('cache', 'ledger-brief.json')
const BRIEF_TTL_MS = 30 * 60_000

/** 重算并落盘账本摘要（scheduler 每 5 分钟调一次）。失败不抛，保留旧缓存。 */
export async function refreshBrief(opts = {}) {
  try {
    const r = await report(opts)
    const payload = { at: Date.now(), today: r.today, line: brief(r), report: { me: r.me, week: r.week, balance: r.balance, runwayDays: r.runwayDays, quotas: r.quotas } }
    const f = BRIEF_CACHE()
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, JSON.stringify(payload, null, 0))
    return payload
  } catch (e) {
    return null
  }
}

/** 读缓存（同步，给提示语注入）。没缓存返回 null —— 提示语里就干脆不提账本。 */
export function readBrief() {
  try {
    const j = JSON.parse(fs.readFileSync(BRIEF_CACHE(), 'utf8'))
    if (!j || typeof j.line !== 'string' || !j.line) return null
    return { ...j, stale: Date.now() - Number(j.at || 0) > BRIEF_TTL_MS }
  } catch {
    return null
  }
}

/**
 * 常驻进程（qq-server / douyin-dm-server / scheduler）开一次就行：
 * 立刻刷一版，然后每 minutes 分钟刷一版。返回 unref 过的 timer，不挡进程退出。
 */
export function startBriefRefresher(minutes = 10, log = () => {}) {
  const go = () => {
    refreshBrief()
      .then((p) => { if (p) log('账本已刷新：' + p.line.slice(0, 90)) })
      .catch(() => {})
  }
  go()
  const t = setInterval(go, Math.max(1, minutes) * 60_000)
  if (typeof t.unref === 'function') t.unref()
  return t
}

export function fmtTok(n) {
  const v = Number(n) || 0
  if (v >= 1e8) return (v / 1e8).toFixed(2) + ' 亿'
  if (v >= 1e4) return (v / 1e4).toFixed(1) + ' 万'
  return String(Math.round(v))
}