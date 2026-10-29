// brain/json —— 文件读写底座（无依赖）。
//
// 铁律（v3 设计 §3/§13）：
//   · 所有"整份 JSON"的写入都是 temp + rename：中途崩了要么旧要么新，绝不半份。
//   · 所有 JSONL 都是 append-only：只追加，不改行（记忆不硬删）。
//   · 坏行不抛异常：一行坏了跳过，别让一条脏数据把整轮回复带崩。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

/** 确保目录存在（幂等）。 */
export function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }) } catch {}
  return dir
}

/** 读 JSON；带 BOM 也认；坏了返回 fallback。 */
export function readJson(file, fallback = null) {
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    if (!raw.trim()) return fallback
    return JSON.parse(raw)
  } catch { return fallback }
}

/** 原子写 JSON（temp + rename）。 */
export function writeJsonAtomic(file, value) {
  ensureDir(path.dirname(file))
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, JSON.stringify(value, null, 1))
  fs.renameSync(temp, file)
  return value
}

/** 追加一行 JSONL。永远不抛：记忆写入失败不许影响聊天主链。 */
export function appendJsonl(file, obj) {
  try {
    ensureDir(path.dirname(file))
    fs.appendFileSync(file, JSON.stringify(obj) + '\n')
    return true
  } catch { return false }
}

/** 读 JSONL。limit 只取尾部 N 行（大文件不整份进内存）。 */
export function readJsonl(file, { limit = 0 } = {}) {
  let raw = ''
  try {
    if (!fs.existsSync(file)) return []
    const st = fs.statSync(file)
    if (limit > 0 && st.size > 4 * 1024 * 1024) {
      // 大文件：只读尾部（按行数估 512B/行，多读一点再截断）
      const want = Math.min(st.size, limit * 600)
      const fd = fs.openSync(file, 'r')
      try {
        const buf = Buffer.alloc(want)
        fs.readSync(fd, buf, 0, want, Math.max(0, st.size - want))
        raw = buf.toString('utf8')
        raw = raw.slice(raw.indexOf('\n') + 1)   // 丢掉被截断的首行
      } finally { fs.closeSync(fd) }
    } else {
      raw = fs.readFileSync(file, 'utf8')
    }
  } catch { return [] }
  const out = []
  for (const line of raw.split('\n')) {
    const s = line.trim()
    if (!s) continue
    try { out.push(JSON.parse(s)) } catch { /* 坏行跳过 */ }
  }
  return limit > 0 ? out.slice(-limit) : out
}

/**
 * 改一份 JSON：read → fn(当前值) → 原子写。fn 返回 undefined 表示"不写"。
 * 不带跨进程锁（要锁用 store.mjs 的 withLock / mutateJson）—— 这一版进程结构里
 * 大部分文件只有一个写者，锁只在 facts/intents 这类多入口的地方显式加。
 */
export function mutateJson(file, fallback, fn) {
  const cur = readJson(file, fallback)
  const next = fn(cur)
  if (next === undefined) return cur
  return writeJsonAtomic(file, next)
}

/** 文件大小 / 行数（doctor 用）。 */
export function fileInfo(file) {
  try {
    const st = fs.statSync(file)
    return { exists: true, size: st.size, mtime: st.mtimeMs }
  } catch { return { exists: false, size: 0, mtime: 0 } }
}

/** 目录下匹配的文件名（排序稳定）。 */
export function listFiles(dir, re) {
  try {
    return fs.readdirSync(dir).filter((f) => (re ? re.test(f) : true)).sort()
  } catch { return [] }
}

/** 短哈希（锁名 / 去重键用）。 */
export function shortHash(str, len = 10) {
  return crypto.createHash('sha1').update(String(str)).digest('hex').slice(0, len)
}