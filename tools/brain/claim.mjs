// brain/claim —— 声称-证据闸（O11）。
//
// 病根：`persona.mjs` 那句「绝对不许说"我不知道""我没做过"」逼着模型用编造填空白；
// 而"我看完了"这种话又没有任何人核对。这里做三件事：
//   ① 出站前抓可验证动词 + 对象，去**所有**账本里找证据（交付 / 意图 / 事实 / binge 看番账本）；
//   ② 找到**相反**证据（账本说她只看到第 2 集）才纠正 —— 而且改成"还没看"，不是"正要接着看"；
//   ③ 什么都没查到 = **不说话**，只记账。
//
// ⚠️ 10-29 的事故（主人当场引用并质问）：旧实现把"完成态"反转成"将来态" ——
//    「我看完了第3集」→「我正要接着看第3集」、「我追到第8集了」→「我正要接着看第8集了」。
//    这是**语义错乱**：证据缺失不等于没发生，把已发生的事说成将要发生，比原句更假。
//    另外 binge 账本里明明有 seen:[1,2,3,4,5]，"看完第3集"本来就有证据 —— 证据源少查了一个。
//    现在的规矩：有证据放行；有反证才改；没证据不改字（只留审计痕迹）。
import fs from 'node:fs'
import path from 'node:path'
import { appendJsonl } from './json.mjs'
import { claimsPath } from './paths.mjs'
import { dataPath } from '../lib/paths.mjs'
import * as delivery from './delivery.mjs'
import * as intents from './intents.mjs'
import * as facts from './facts.mjs'
import { bump } from './metrics.mjs'

/** 可验证动词 → 反证时的说法。degrade 必须是能直接嵌回原句的短句：
 *  「我看完了第3集」→「我还没看第3集」、「已经发给你了」→「还没发给你」。 */
const VERBS = [
  { key: 'watch', re: /(看完|看了|追完|追到第|看到第|看过了|刷完|刷到第)/, degrade: '还没看' },
  { key: 'send', re: /(发给你了|已经发给你|发过去了|推给你了|传给你了|已经发了|已经发)/, degrade: '还没发给你' },
  { key: 'write', re: /(写完了|写好了|已经写了)/, degrade: '还没写完' },
  { key: 'sing', re: /(唱完了|录好了|唱给你听了)/, degrade: '还没录好' },
  { key: 'make', re: /(做好了|做完了|弄好了|剪完了|上传了|发出去了)/, degrade: '还没弄好' },
  { key: 'reply', re: /(回他了|已经回了|回过他了)/, degrade: '还没回他' },
]

const STOP = new Set(['了', '的', '我', '你', '他', '她', '已经', '都', '就', '还', '在', '一', '个', '这', '那', '刚', '刚刚'])

/** 抽对象：动词后面那截 + 书名号作品名。 */
export function detect(text) {
  const s = String(text || '')
  const out = []
  for (const v of VERBS) {
    const m = v.re.exec(s)
    if (!m) continue
    let tail = s.slice(m.index + m[0].length).replace(/^[，。！？、,.!?\s]+/, '')
    tail = tail.split(/[，。！？!?；;\n]/)[0].trim().replace(/^[了过]+/, '')
    const book = /《([^》]{1,24})》/.exec(s)
    const object = (tail && tail.length <= 20 ? tail : '') || (book ? book[1] : '')
    out.push({ verb: v.key, matched: m[0], index: m.index, object, degrade: v.degrade, raw: s.slice(Math.max(0, m.index - 10), m.index + 30) })
  }
  return out.slice(0, 2)
}

/** binge 看番账本（~/.feiyu-ai/binge/<番名>.json，含 seen:[1,2,3]）—— 这是"看完第几集"最硬的证据。 */
let bingeCache = { at: 0, rows: [] }
function bingeRows(now = Date.now()) {
  if (now - bingeCache.at < 60_000 && bingeCache.rows.length) return bingeCache.rows
  const dir = dataPath('binge')
  const rows = []
  try {
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
      const seen = (Array.isArray(j?.seen) ? j.seen : []).map(Number).filter((n) => Number.isFinite(n))
      if (j?.show && seen.length) rows.push({ show: String(j.show), seen, last: Math.max(...seen) })
    }
  } catch { /* 没有账本就当没有，不猜 */ }
  bingeCache = { at: now, rows }
  return rows
}

/** 从文本里取"第 N 集"。 */
function epOf(text) {
  const m = /第\s*([0-9]{1,4})\s*[集话话]/.exec(String(text || ''))
  return m ? Number(m[1]) : 0
}

/** 找证据：交付日志 → 意图结算 → 事实 → 看番账本。 */
export function evidenceFor(hit, { now = Date.now(), minutes = 24 * 60, chat = '', text = '' } = {}) {
  const object = typeof hit === 'string' ? hit : String(hit?.object || '')
  const verb = typeof hit === 'string' ? '' : String(hit?.verb || '')
  const src = String(text || object)
  const obj = object.trim()
  const refs = []
  if (obj) {
    const d = delivery.find(obj, { minutes, now, chat })
    if (d.ok) refs.push(...d.refs.map((r) => ({ kind: 'delivery', ref: `${r.chat}#${r.msgId || r.hash}` })))
    const done = intents.all().find((x) => x.state === 'done'
      && String(x.object).includes(obj.slice(0, 8))
      && (x.verifyState?.evidence || []).length)
    if (done) refs.push({ kind: 'intent', ref: done.id, evidence: done.verifyState.evidence })
    const f = facts.all().find((x) => String(x.o).includes(obj) && x.status === 'active')
    if (f) refs.push({ kind: 'fact', ref: f.id, prov: f.prov })
  }
  if (verb === 'watch') {
    const ep = epOf(src)
    const rows = bingeRows(now)
    const named = rows.filter((r) => src.includes(r.show))
    const pool = named.length ? named : rows
    if (ep) {
      const row = pool.find((r) => r.seen.includes(ep))
      if (row) refs.push({ kind: 'binge', ref: `${row.show}:E${ep}` })
    } else {
      // 没写集数但确实看过这部 → 也算弱证据（别把"我看过了"一棍子打死）
      const row = named[0] || pool[0]
      if (row && row.last > 0) refs.push({ kind: 'binge', ref: `${row.show}:E1-E${row.last}` })
    }
  }
  return { ok: refs.length > 0, refs }
}

/** 找**相反**证据：账本明确显示她没做到那一步。 */
export function contradictionFor(hit, { now = Date.now(), text = '' } = {}) {
  const object = String(hit?.object || '')
  const src = String(text || object)
  if (hit?.verb === 'watch') {
    const ep = epOf(src)
    const row = bingeRows(now).find((r) => src.includes(r.show))
    if (row && ep && !row.seen.includes(ep)) {
      return { kind: 'binge', why: `账本显示只看到第${row.last}集` }
    }
  }
  const key = object.slice(0, 8)
  if (key) {
    const bad = intents.all().find((x) => String(x.object).includes(key)
      && (x.state === 'failed' || x.state === 'missed' || (x.state === 'open' && Number(x.dueAt || 0) < now)))
    if (bad) return { kind: 'intent', why: String(bad.lastWhy || bad.verifyState?.reason || '这件事没做成') }
  }
  return null
}

/**
 * 过闸。
 * @returns {{text:string, changed:boolean, findings:Array}}
 */
export function gate(text, { now = Date.now(), chat = '', dryRun = false } = {}) {
  const src = String(text || '')
  const findings = []
  const edits = []
  for (const hit of detect(src)) {
    const ev = evidenceFor(hit, { now, chat, text: src })
    let verdict = ev.ok ? 'ok' : 'unknown'
    let contra = null
    if (!ev.ok) {
      contra = contradictionFor(hit, { now, text: src })
      if (contra) verdict = 'contradicted'
    }
    findings.push({ ...hit, evidence: ev.refs, contra, verdict, ok: verdict === 'ok' })
    if (verdict !== 'contradicted' || dryRun) continue
    // 只有账本说她没做到那一步，才改口；改的是"还没…"，不是把完成态拗成将来态。
    const at = Number.isInteger(hit.index) ? hit.index : src.indexOf(hit.matched)
    if (at < 0) continue
    let verb = hit.matched
    // matched 末尾的"第"是量词，留在原文里（"追到第8集"→"还没看第8集"，不能吃成"还没看8集"）
    if (/第$/.test(verb) && /^[0-9一二三四五六七八九十百]/.test(src.slice(at + verb.length))) verb = verb.slice(0, -1)
    let end = at + verb.length
    const aspect = /^[了过]+/.exec(src.slice(end))
    if (aspect) end += aspect[0].length
    edits.push({ at, end, degrade: hit.degrade })
  }
  // 从右往左替换：前面的下标不会漂
  edits.sort((a, b) => b.at - a.at)
  let out = src
  let last = Infinity
  for (const e of edits) {
    if (e.end > last) continue // 区间重叠就跳过（宁可少改，不许改烂）
    out = out.slice(0, e.at) + e.degrade + out.slice(e.end)
    last = e.at
  }
  const changed = out !== src
  appendJsonl(claimsPath(), {
    at: now, chat, changed,
    findings: findings.map((f) => ({ verb: f.verb, object: f.object, verdict: f.verdict, refs: f.evidence.map((r) => r.kind), contra: f.contra?.kind || '' })),
    head: src.slice(0, 40),
  })
  if (findings.length) bump('claimsChecked', findings.length)
  if (findings.some((f) => f.verdict === 'unknown')) bump('claimsUnknown')
  if (changed) bump('claimsRewritten')
  return { text: out, changed, findings }
}