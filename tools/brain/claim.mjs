// brain/claim —— 声称-证据闸（元认知 O11 的最小可用版）。
//
// 病根：`persona.mjs:306` 那句「绝对不许说"我不知道""我没做过"」逼着模型用编造填空白；
// 而"我看完了"这种话又没有任何人核对。这里做两件事：
//   ① 出站前抓可验证动词 + 对象，去 delivery / intents / binge 账本 / facts 里找证据；
//   ② 找不到就**降时态**（"我正要看"），而不是否认（"没发生过"是禁语）。
import { appendJsonl } from './json.mjs'
import { claimsPath } from './paths.mjs'
import * as delivery from './delivery.mjs'
import * as intents from './intents.mjs'
import * as facts from './facts.mjs'
import { bump } from './metrics.mjs'

/** 可验证动词 → 降级说法（没证据时改成"还没做到"）。
 *  降级短语要能直接嵌进原句：后面往往还跟着"了 / 第3集 / ，等下给你看"，
 *  所以这里一律用短句，不许自带后半截（早期 write 的 fallback 写成"还在写，写完给你看"，
 *  结果变成"还在写，写完给你看等下给你看"）。 */
const VERBS = [
  { key: 'watch', re: /(看完|看了|追完|追到第|看到第|看过了|看完第|刷完|刷到第)/, fallback: '正要接着看' },
  { key: 'send', re: /(发给你了|已经发给你|发过去了|推给你了|传给你了|已经发了|已经发)/, fallback: '这就发你' },
  { key: 'write', re: /(写完了|写好了|已经写了)/, fallback: '还没写完' },
  { key: 'sing', re: /(唱完了|录好了|唱给你听了)/, fallback: '还没录好' },
  { key: 'make', re: /(做好了|做完了|弄好了|剪完了|上传了|发出去了)/, fallback: '还没弄好' },
  { key: 'reply', re: /(回他了|已经回了|回过他了)/, fallback: '还没回他' },
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
    out.push({ verb: v.key, matched: m[0], index: m.index, object, fallback: v.fallback, raw: s.slice(Math.max(0, m.index - 10), m.index + 30) })
  }
  return out.slice(0, 2)
}

/** 找证据：交付日志 → 意图结算 → 账本 → 事实。 */
export function evidenceFor(object, { now = Date.now(), minutes = 24 * 60, chat = '' } = {}) {
  const obj = String(object || '').trim()
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
  return { ok: refs.length > 0, refs }
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
    const ev = evidenceFor(hit.object, { now, chat })
    findings.push({ ...hit, evidence: ev.refs, ok: ev.ok })
    if (ev.ok || dryRun) continue
    // 没有证据：把"做完了"改成"正要去做"（不否认、不狡辩）。
    // 替换区间 = 动词短语本体 + 紧跟的"了/过"；末尾的"第"是量词，留在原文里
    // （"追到第8集" → "正要接着看第8集"，不能吃成"正要接着看8集"）。
    const at = Number.isInteger(hit.index) ? hit.index : src.indexOf(hit.matched)
    if (at < 0) continue
    let verb = hit.matched
    if (/第$/.test(verb) && /^[0-9一二三四五六七八九十百]/.test(src.slice(at + verb.length))) verb = verb.slice(0, -1)
    let end = at + verb.length
    const aspect = /^[了过]+/.exec(src.slice(end))
    if (aspect) end += aspect[0].length
    edits.push({ at, end, fallback: hit.fallback })
  }
  // 从右往左替换：先动的落在后面，前面的下标就不会漂
  edits.sort((a, b) => b.at - a.at)
  let out = src
  let last = Infinity
  for (const e of edits) {
    if (e.end > last) continue // 与已处理的区间重叠，跳过（宁可少改，不许改烂）
    out = out.slice(0, e.at) + e.fallback + out.slice(e.end)
    last = e.at
  }
  const changed = out !== src
  appendJsonl(claimsPath(), {
    at: now, chat, changed,
    findings: findings.map((f) => ({ verb: f.verb, object: f.object, ok: f.ok, refs: f.evidence.map((r) => r.kind) })),
    head: src.slice(0, 40),
  })
  if (findings.length) bump('claimsChecked', findings.length)
  if (changed) bump('claimsRewritten')
  return { text: out, changed, findings }
}