// brain/self —— 自我模型 + 叙事（默认网络 O10）。
//
// 为什么要有写闸：她有文件权限（selfup），能改自己的 persona.md。
// 一个能改自己"我是谁"的角色，如果没有版本与留痕，一次手滑就再也说不清"她原来是什么样"。
// 这里：主人层只读、自助层可改（要理由 + 证据）、每周叙事段重写、每次写前存历史。
import fs from 'node:fs'
import path from 'node:path'
import { readJson, mutateJson, shortHash, ensureDir } from './json.mjs'
import { selfPath, selfMetaPath, selfHistoryDir } from './paths.mjs'
import { isoOf } from './clock.mjs'

export const SECTIONS = ['owner', 'self', 'narrative']
const MARK = (s) => [`<!-- ${s}:begin -->`, `<!-- ${s}:end -->`]

const TEMPLATE = `# 我是谁

<!-- owner:begin -->
（这一段只有主人能改：名字、称呼、关系、底线。）
<!-- owner:end -->

<!-- self:begin -->
（这一段是你自己写的：你怎么看自己、最近在意什么。改之前想一下为什么。）
<!-- self:end -->

<!-- narrative:begin -->
（每周重写一次：我最近的故事，三百字以内。）
<!-- narrative:end -->
`

export function ensure() {
  try {
    if (!fs.existsSync(selfPath())) {
      ensureDir(path.dirname(selfPath()))
      fs.writeFileSync(selfPath(), TEMPLATE)
      mutateJson(selfMetaPath(), {}, () => ({ createdAt: Date.now(), version: 1 }))
    }
  } catch {}
  return selfPath()
}

export function read() {
  ensure()
  let raw = ''
  try { raw = fs.readFileSync(selfPath(), 'utf8') } catch {}
  const get = (s) => {
    const [b, e] = MARK(s)
    const i = raw.indexOf(b), j = raw.indexOf(e)
    if (i < 0 || j < 0 || j < i) return ''
    return raw.slice(i + b.length, j).trim()
  }
  return { raw, owner: get('owner'), self: get('self'), narrative: get('narrative') }
}

function setSection(raw, section, text) {
  const [b, e] = MARK(section)
  const i = raw.indexOf(b), j = raw.indexOf(e)
  const body = `\n${String(text || '').trim()}\n`
  if (i < 0 || j < 0) return raw + `\n${b}${body}${e}\n`
  return raw.slice(0, i + b.length) + body + raw.slice(j)
}

/** 存历史（每次写入前一份，保留最近 60 份）。 */
function snapshot(raw, why = '') {
  try {
    ensureDir(selfHistoryDir())
    const name = `${isoOf().replace(/[:+]/g, '').slice(0, 15)}-${shortHash(raw, 6)}.md`
    fs.writeFileSync(path.join(selfHistoryDir(), name), raw)
    const files = fs.readdirSync(selfHistoryDir()).sort()
    for (const f of files.slice(0, Math.max(0, files.length - 60))) {
      try { fs.rmSync(path.join(selfHistoryDir(), f), { force: true }) } catch {}
    }
    mutateJson(selfMetaPath(), {}, (cur) => ({ ...(cur || {}), lastWhy: String(why).slice(0, 120), lastAt: Date.now() }))
  } catch {}
}

/**
 * 写一段。
 * @param {'owner'|'self'|'narrative'} section
 * @param {{by?:string, reason?:string, prov?:string[], force?:boolean}} opts
 */
export function write(section, text, { by = 'self', reason = '', prov = [], force = false } = {}) {
  if (!SECTIONS.includes(section)) return { ok: false, reason: 'unknown-section' }
  if (section === 'owner' && by !== 'owner' && !force) {
    return { ok: false, reason: 'owner-locked' }        // 主人层默认锁死
  }
  if (section === 'self' && by === 'self' && !String(reason || '').trim() && !force) {
    return { ok: false, reason: 'reason-required' }     // 改自己必须写理由
  }
  ensure()
  const cur = read()
  const before = cur.raw
  snapshot(before, `${section}:${reason}`)
  const next = setSection(before, section, text)
  try {
    fs.writeFileSync(selfPath(), next)
    mutateJson(selfMetaPath(), {}, (m) => ({
      ...(m || {}), version: Number(m?.version || 0) + 1, updatedAt: Date.now(),
      lastSection: section, lastBy: by, lastReason: String(reason).slice(0, 120), prov: (prov || []).slice(0, 4),
    }))
    return { ok: true, version: readMeta().version }
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) }
  }
}

export function readMeta() {
  return readJson(selfMetaPath(), { version: 0 }) || { version: 0 }
}

export function history(limit = 10) {
  try {
    const files = fs.readdirSync(selfHistoryDir()).sort().reverse().slice(0, limit)
    return files.map((f) => ({ file: f, at: fs.statSync(path.join(selfHistoryDir(), f)).mtimeMs }))
  } catch { return [] }
}

/** 每晚核对一次：文件被绕过写闸改动过就报出来（doctor 会看）。 */
export function manifest() {
  const cur = read().raw
  const meta = readMeta()
  return { hash: shortHash(cur, 16), version: Number(meta.version || 0), drift: Boolean(meta.hash && meta.hash !== shortHash(cur, 16)) }
}

export function settleManifest() {
  const hash = shortHash(read().raw, 16)
  mutateJson(selfMetaPath(), {}, (m) => ({ ...(m || {}), hash, hashedAt: Date.now() }))
  return hash
}

/** 提示词块（≤250 字：自我三句 + 叙事一句）。 */
export function renderBlock({ limit = 250 } = {}) {
  const s = read()
  const lines = []
  if (s.self) lines.push('你怎么看自己：' + s.self.replace(/\s+/g, ' ').slice(0, 100))
  if (s.narrative) lines.push('最近的故事：' + s.narrative.replace(/\s+/g, ' ').slice(0, 120))
  return lines.join('\n').slice(0, limit)
}

export function ownerBlock({ limit = 400 } = {}) {
  const s = read()
  // 模板里那几行"（这一段只有主人能改…）"不是真内容：主人还没写就当空
  const real = String(s.owner || '').split('\n').filter((l) => l.trim() && !/^[（(]/.test(l.trim())).join(' ')
  return real.replace(/\s+/g, ' ').slice(0, limit)
}

export { TEMPLATE }