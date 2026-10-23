// 风控闸门 —— dafeiyu 骨架 ops/guard.py 的 JS 移植。
//
// 所有外发消息都必须过这里：
//   · DRY_RUN   默认开（第一周只打印不真发 —— dafeiyu 的铁律）
//   · 清洗      banned 词（"作为AI"…）+ 剥 markdown
//   · 限速      同一 chat 两条消息最小间隔
//   · 去重      3-gram Jaccard 超阈值判复读，宁可沉默不刷屏
// 状态持久化（sent-log.json / sent-at.json）：CLI 每次都是新进程，内存态没有意义 ✗
import fs from 'node:fs'
import { dataPath } from './paths.mjs'
import { config } from './config.mjs'

const SENT_LOG = dataPath('sent-log.json')
const SENT_AT = dataPath('sent-at.json')

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}
function writeJson(file, value) {
  fs.mkdirSync(dataPath(), { recursive: true })
  const temp = file + '.' + process.pid + '.tmp'
  fs.writeFileSync(temp, JSON.stringify(value))
  fs.renameSync(temp, file)
}

/** 3-gram 集合（dafeiyu guard.py _grams）。 */
function grams(s, n = 3) {
  s = String(s ?? '').replace(/\s+/g, '')
  const out = new Set()
  for (let i = 0; i < Math.max(0, s.length - n + 1); i++) out.add(s.slice(i, i + n))
  return out
}

/** 清洗：去黑名单词、剥 markdown、压空白。 */
export function clean(text, cfg = config()) {
  let t = String(text ?? '')
  for (const bad of cfg.guard?.banned ?? []) t = t.split(bad).join('')
  t = t.replace(/\*\*(.+?)\*\*/g, '$1')
  t = t.replace(/`{1,3}/g, '')
  t = t.replace(/\n{3,}/g, '\n\n')
  return t.trim()
}

/** 复读检测：与最近 20 条输出的 3-gram Jaccard 超过阈值即判重。 */
export function dupOk(chatId, text, cfg = config()) {
  const thr = Number(cfg.guard?.dupThreshold ?? 0.6)
  const g1 = grams(text)
  if (!g1.size) return true
  const log = readJson(SENT_LOG, {})[chatId] ?? []
  for (const old of log.slice(-20)) {
    const g2 = grams(old)
    if (!g2.size) continue
    let inter = 0
    for (const g of g1) if (g2.has(g)) inter++
    const j = inter / (g1.size + g2.size - inter)
    if (j > thr) return false
  }
  return true
}

/**
 * 统一判定入口（发送前）。
 * @returns {{ok: boolean, why: string}} ok=false 时 why 说明原因。
 */
export function allow(chatId, text, cfg = config(), opts = {}) {
  if (opts.checkDryRun !== false && cfg.guard?.dryRun) return { ok: false, why: `DRY_RUN（干跑：只打印不真发；确认没问题后把 feiyu.config.json 的 guard.dryRun 改 false）` }
  const gap = Math.max(0, Number(cfg.guard?.minGapSec ?? 25))
  const at = readJson(SENT_AT, {})[chatId] ?? 0
  if (Date.now() - at < gap * 1000) return { ok: false, why: `间隔不足 ${gap}s` }
  if (!dupOk(chatId, text, cfg)) return { ok: false, why: '复读检测（3-gram 相似度过高）—— 换个说法再发' }
  return { ok: true, why: '' }
}

/** 发送成功后记账（时间 + 内容）。 */
export function commit(chatId, text) {
  const log = readJson(SENT_LOG, {})
  const list = log[chatId] ?? []
  list.push(String(text))
  log[chatId] = list.slice(-50)
  writeJson(SENT_LOG, log)
  const at = readJson(SENT_AT, {})
  at[chatId] = Date.now()
  writeJson(SENT_AT, at)
}
