// brain/facts —— 语义记忆（新皮层）：事实 = 主体 + 谓词 + 客体 + 有效期 + 证据（v3 O5）。
//
// 三个硬约束（每一条都对应一个真实事故）：
//   1. **无 prov 不入库**：lore.json 205 条里混着抖音分享标题和运维笔记，
//      没有证据链的"事实"是灾难（10-26 她拿分享标题当自己的经历讲）。
//   2. **写入即换算绝对时间**：owner-facts 只存 HH:MM 却贴"今天已经知道的事"，
//      一周前的"今天吃了烧鸭"到现在还在误导她 —— 这类错误在这里不可能再犯。
//   3. **冲突不硬删**：两个来源打架就标 disputed，让她照实说"我记的是 X，Y 也说过"。
import { readJson, mutateJson } from './json.mjs'
import { factsPath, loreClassPath } from './paths.mjs'
import { endOfDay, isoOf, stamp } from './clock.mjs'

/** 谓词闭集：合并键必须是有限集合，否则同义谓词永远合不到一起。 */
export const PREDICATES = [
  'food.eat', 'food.like', 'food.dislike',
  'activity.do', 'plan.go', 'mood.state', 'health.state',
  'media.like', 'media.dislike', 'media.progress',
  'person.alias', 'place.visit',
  'preference.like', 'preference.dislike',
  'work.do', 'work.todo', 'note',
]

export const P_LABEL = {
  'food.eat': '他吃过的东西',
  'food.like': '他爱吃的',
  'food.dislike': '他不爱吃的',
  'activity.do': '他在做什么',
  'plan.go': '他说要去做的',
  'mood.state': '他的状态',
  'health.state': '他的身体',
  'media.like': '他提到的作品',
  'media.dislike': '他不喜欢的作品',
  'media.progress': '看到哪了',
  'person.alias': '谁是谁',
  'place.visit': '他去过/要去的地方',
  'preference.like': '他喜欢什么',
  'preference.dislike': '他讨厌什么',
  'work.do': '工作上的事',
  'work.todo': '工作待办',
  note: '杂项',
}

/** 来源权重：主人亲口 > 群友 > 她自己推断 > 网上。 */
const SOURCE_W = { owner: 1.0, owner_facts: 0.9, group: 0.6, self: 0.5, web: 0.3, import: 0.4 }

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
const keyOf = (f) => `${f.s}|${f.p}|${norm(f.o).toLowerCase()}`

function load() {
  const j = readJson(factsPath(), null)
  if (!j || !Array.isArray(j.items)) return { items: [], updatedAt: 0 }
  return j
}

function save(items) {
  try { mutateJson(factsPath(), { items: [] }, () => ({ items, updatedAt: Date.now() })) } catch {}
  return items
}

export function all() {
  return load().items
}

export function isLive(f, now = Date.now()) {
  if (f.status !== 'active') return false
  const from = Number(f.valid?.from || 0)
  const to = Number(f.valid?.to || 0) || Number.MAX_SAFE_INTEGER
  return from <= now && now <= to
}

export function active(now = Date.now()) {
  return all().filter((f) => isLive(f, now))
}

/**
 * 记一条事实。
 * @returns {{ok:true, action:'added'|'merged'|'superseded'|'disputed', fact:object}|{ok:false, reason:string}}
 */
export function add({
  s = 'owner', p, o, validFrom, validUntil, prov, source = 'owner', conf = 0.7, raw = '', now = Date.now(),
} = {}) {
  const pred = PREDICATES.includes(String(p)) ? String(p) : 'note'
  const obj = norm(o).slice(0, 60)
  if (!obj) return { ok: false, reason: 'empty-object' }
  const proofs = (Array.isArray(prov) ? prov : prov ? [prov] : []).map(String).filter(Boolean).slice(0, 8)
  if (!proofs.length) return { ok: false, reason: 'no-prov' }     // 无证据不入库
  const from = Number(validFrom) || now
  // "今天/今晚"这类：有效期到当天 23:59；没写日期的一律当天
  const to = Number(validUntil) || (from === now || !validUntil ? endOfDay(from) : Number(validUntil))

  const items = all()
  const k = `${s}|${pred}|${obj.toLowerCase()}`
  const same = items.filter((f) => keyOf(f) === k)
  const live = same.find((f) => isLive(f, now))

  if (live) {
    live.belief = { conf: Math.max(Number(live.belief?.conf || 0), Number(conf)), hits: Number(live.belief?.hits || 1) + 1 }
    live.prov = [...new Set([...(live.prov || []), ...proofs])].slice(-8)
    live.valid = { from: Math.min(Number(live.valid?.from || from), from), to: Math.max(Number(live.valid?.to || to), to) }
    live.updatedAt = now
    save(items)
    return { ok: true, action: 'merged', fact: live }
  }

  // 冲突：同主体同谓词、时间重叠、客体不同
  const rivals = same.filter((f) => isLive(f, now) && norm(f.o).toLowerCase() !== obj.toLowerCase())
  for (const r of rivals) {
    const wNew = (SOURCE_W[source] ?? 0.5) * Number(conf)
    const wOld = (SOURCE_W[r.source] ?? 0.5) * Number(r.belief?.conf || 0.5)
    if (wNew > wOld + 0.1) {
      r.status = 'superseded'
      r.updatedAt = now
    } else if (wNew < wOld - 0.1) {
      return { ok: false, reason: 'outweighed', by: r.id }
    } else {
      r.status = 'disputed'
      r.updatedAt = now
    }
  }

  const fact = {
    id: `f-${now.toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
    s, p: pred, o: obj,
    valid: { from, to },
    prov: proofs,
    belief: { conf: Number(conf), hits: 1 },
    status: rivals.length ? 'disputed' : 'active',
    source, raw: norm(raw).slice(0, 120),
    createdAt: now, updatedAt: now,
  }
  items.push(fact)
  if (items.length > 3000) items.splice(0, items.length - 3000)
  save(items)
  return { ok: true, action: 'added', fact }
}

export function setStatus(id, status) {
  const items = all()
  const f = items.find((x) => x.id === id)
  if (!f) return null
  f.status = status
  f.updatedAt = Date.now()
  save(items)
  return f
}

/** 按线索找事实（召回用）。 */
export function search(text, { limit = 6, now = Date.now() } = {}) {
  const t = norm(text).toLowerCase()
  if (!t) return []
  return active(now)
    .filter((f) => t.includes(String(f.o).toLowerCase()) || t.includes(String(f.s).toLowerCase()) || String(f.o).length >= 2 && t.includes(String(f.o).slice(0, 2)))
    .sort((a, b) => Number(b.belief?.hits || 0) - Number(a.belief?.hits || 0))
    .slice(0, limit)
}

/** 提示词块（≤300 字；过期不注入，disputed 要带"另一个说法"）。 */
export function promptBlock({ limit = 4, now = Date.now(), subject = 'owner' } = {}) {
  const rows = active(now)
    .filter((f) => !subject || f.s === subject)
    .sort((a, b) => {
      const wa = SOURCE_W[a.source] ?? 0.5, wb = SOURCE_W[b.source] ?? 0.5
      return (wb - wa) || (Number(b.belief?.hits || 0) - Number(a.belief?.hits || 0)) || (b.updatedAt - a.updatedAt)
    })
    .slice(0, limit)
  if (!rows.length) return ''
  const lines = rows.map((f) => {
    const when = f.valid?.from ? stamp(f.valid.from) : ''
    const conflict = f.status === 'disputed' ? '（这条有另一种说法，别当成板上钉钉）' : ''
    return `· ${P_LABEL[f.p] || f.p}：${f.o}${when ? `（${when} 说的）` : ''}${conflict}`
  })
  return '【已经知道的事】（他自己说的，不用再问一遍）\n' + lines.join('\n')
}

export function conflicts(now = Date.now()) {
  const out = []
  const byKey = new Map()
  for (const f of active(now)) {
    const k = `${f.s}|${f.p}`
    if (!byKey.has(k)) byKey.set(k, [])
    byKey.get(k).push(f)
  }
  for (const [k, rows] of byKey) {
    const objs = new Set(rows.map((f) => norm(f.o).toLowerCase()))
    if (objs.size > 1) out.push({ key: k, rows: rows.map((f) => ({ id: f.id, o: f.o, conf: f.belief?.conf, source: f.source })) })
  }
  return out
}

export function stats() {
  const items = all()
  const live = active()
  return {
    total: items.length,
    active: live.length,
    disputed: items.filter((f) => f.status === 'disputed').length,
    superseded: items.filter((f) => f.status === 'superseded').length,
    noProv: items.filter((f) => !Array.isArray(f.prov) || !f.prov.length).length,
    byPredicate: live.reduce((m, f) => { m[f.p] = (m[f.p] || 0) + 1; return m }, {}),
  }
}

/* ── 迁移：旧 owner-facts → 结构化事实 ─────────────────────────────── */

const OWNER_KEY_MAP = {
  food: 'food.eat', doing: 'activity.do', plan: 'plan.go', mood: 'mood.state', media: 'media.like',
}

/**
 * 旧账本形如 `food|烧鸭|16:56|我中午吃了烧鸭`。它**只有时刻没有日期**，
 * 所以迁移时一律锚定"今天"（这是它唯一说得通的解释），并标 source=owner_facts。
 */
export function migrateOwnerFacts({ legacyRows = [], now = Date.now() } = {}) {
  const out = { added: 0, merged: 0, rejected: 0 }
  for (const row of legacyRows) {
    const parts = String(row).split('|')
    const key = String(parts[0] || '').trim()
    const value = String(parts[1] || '').trim()
    const at = String(parts[2] || '').trim()
    if (!key || !value) { out.rejected++; continue }
    const p = OWNER_KEY_MAP[key] || 'note'
    let from = now
    if (/^\d{1,2}:\d{2}$/.test(at)) {
      const d = new Date(now)
      const [h, m] = at.split(':').map(Number)
      from = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m, 0, 0).getTime()
      if (from > now) from = now          // 未来的时刻不可能是刚说的
    }
    const r = add({
      s: 'owner', p, o: value, validFrom: from, validUntil: endOfDay(from),
      prov: [`owner_facts:${key}:${value}`], source: 'owner_facts', conf: 0.6,
      raw: parts[3] || '', now,
    })
    if (r.ok) { if (r.action === 'merged') out.merged++; else out.added++ }
    else out.rejected++
  }
  return out
}

/* ── 迁移：205 条 lore 先分类，不动原文件 ─────────────────────────── */

const LORE_RULES = [
  { bucket: 'value', re: /原则|底线|应该|不许|必须|答应|尊重|诚实|自由/ },
  { bucket: 'interest', re: /喜欢|爱|兴趣|番|剧|歌|猫|吃|电影|小说|游戏|B站|抖音/ },
  { bucket: 'work', re: /代码|项目|插件|部署|仓库|测试|bug|接口|脚本/ },
  { bucket: 'ops', re: /后台|进程|端口|路径|启动|日志|定时|备份|重启/ },
]

/**
 * 把 lore.json 的每条按关键词分到 value/interest/work/ops/drop。
 * 只写 lore-classified.json（给人过目 + 后续 add() 用），**绝不改 lore.json**。
 */
export function classifyLore({ lore } = {}) {
  const items = []
  const push = (value, extra = {}) => {
    const t = norm(value || '').slice(0, 160)
    if (!t) return
    items.push({ text: t, ...extra })
  }
  const walk = (v, path = '') => {
    if (v == null) return
    if (typeof v === 'string') return push(v, { from: path })
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}[${i}]`))
    if (typeof v === 'object') {
      for (const [k, val] of Object.entries(v)) {
        if (/^(text|value|title|content|line|note|what|name)$/i.test(k) && typeof val === 'string') push(val, { from: path, field: k })
        else walk(val, path ? `${path}.${k}` : k)
      }
    }
  }
  walk(lore, 'lore')
  const seen = new Set()
  const out = { value: [], interest: [], work: [], ops: [], drop: [], builtAt: Date.now(), total: 0 }
  for (const it of items) {
    if (seen.has(it.text)) continue
    seen.add(it.text)
    const hit = LORE_RULES.find((r) => r.re.test(it.text))
    let bucket = hit?.bucket || 'drop'
    // 分享标题（"【】"+ 视频/播放/UP）不是她的事实
    if (/播放|UP主|视频标题|分享视频|\[分享|https?:\/\//.test(it.text)) bucket = 'drop'
    out[bucket].push(it)
  }
  out.total = seen.size
  try { mutateJson(loreClassPath(), {}, () => out) } catch {}
  return { total: out.total, value: out.value.length, interest: out.interest.length, work: out.work.length, ops: out.ops.length, drop: out.drop.length }
}