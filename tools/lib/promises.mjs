// promises —— 她的「承诺账本」（10-27 主人报的"说去看可塑性记忆，一直没看"）
//
// 病根不是记忆差：**根本没有任何东西记得她答应过什么**。
// "这就去看"只活在对话文本和滚动摘要里，没有执行者、没有截止时间、没有完成/失败状态。
// 于是一天被催 7 次、答应 5 次、执行 0 次，只能用"走神了"圆场。
//
// 这份账本就是补上"执行者"：
//   ① 她回话里出现承诺句式 → 自动落账（带 due 时间）
//   ② 每次被唤醒 / 主动搭话前先查到期项 → **真的去执行**（binge 看番、web 查资料…）
//   ③ 做成了写 done（并进记忆，之后能讲）；做不成写 fail（下次必须照实说"我做不到"，不许再答应）
import fs from 'node:fs'
import path from 'node:path'
import { dataPath } from './paths.mjs'
import * as brainIntents from '../brain/intents.mjs'

const FILE = dataPath('promises.json')

function read() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'))
    if (Array.isArray(j?.items)) return j
    return { items: [] }
  } catch { return { items: [] } }
}

function write(obj) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true })
    const tmp = FILE + '.' + process.pid + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 1) + '\n')
    fs.renameSync(tmp, FILE)
  } catch {}
}

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()

/** 承诺句式：她自己说出去的话，才叫承诺。 */
const PROMISE_RES = [
  { re: /(这就|马上|立刻|待会|一会|等下|晚上|明天|今天)(?:就)?(?:去)?(看|追|读|听|学|做|写|查)([^\n。！？!?，,]{0,24})/, dueMin: 90 },
  { re: /(我)?(答应|保证|一定)(?:你)?([^\n。！？!?，,]{0,24})/, dueMin: 120 },
  { re: /看完(?:了)?(?:再|就)?(?:回来)?(?:讲|说|告诉)/, dueMin: 180 },
]

/** 从她的一句回复里抽承诺（obj 尽量取具体的书名/番名）。 */
export function extract(reply, { userText = '' } = {}) {
  const s = norm(reply)
  if (!s) return []
  // 作品名优先：《书名》 → 以"记忆/物语/故事/x之/x传"结尾的短名 → 她自己那句话的宾语
  const NAME_RES = [
    /《([^》]{1,24})》/,
    /([一-龥A-Za-z0-9・·]{1,8}(?:记忆|物语|故事|之|传|记))/,
  ]
  const nameIn = (txt) => {
    for (const re of NAME_RES) {
      const m = re.exec(norm(txt))
      if (m) {
        // 掐掉"一部/个/番/叫做/那部"这类量词与引导词（"一部番叫做可塑性记忆" → "可塑性记忆"）
        let v = String(m[1]).trim()
        for (let i = 0; i < 4; i++) v = v.replace(/^(?:一部|一个|个|部|番|剧|叫做|叫|名叫|那部|那|的|看|追)/, '')
        return v.trim()
      }
    }
    return ''
  }
  const out = []
  for (const r of PROMISE_RES) {
    const m = r.re.exec(s)
    if (!m) continue
    const verb = m[2] || m[1] || ''
    const tail = norm(m[3] || '')
    // 具体对象：她这句话里的名字 > 主人那句话里的名字 > 她自己的尾巴（太长就不当对象）
    const obj = nameIn(s) || nameIn(userText) || (tail && tail.length <= 10 ? tail : '') || ''
    out.push({ kind: verb || 'todo', what: obj, dueMin: r.dueMin })
  }
  return out
}

/** 落账。同 what 未完成的只留一条（不重复记账）。 */
export function add(text, { what = '', kind = 'todo', dueMin = 120, id = '' } = {}) {
  const st = read()
  const w = norm(what || text).slice(0, 60)
  if (!w) return null
  const dup = st.items.find((x) => x.state === 'open' && norm(x.what) === w)
  if (dup) return dup
  const item = {
    id: id || ('p' + Date.now().toString(36) + Math.floor(Math.random() * 100).toString(36)),
    what: w, kind, text: norm(text).slice(0, 160),
    createdAt: Date.now(),
    dueAt: Date.now() + Math.max(5, Number(dueMin) || 120) * 60_000,
    state: 'open', tries: 0, doneAt: 0, why: '',
  }
  st.items.push(item)
  if (st.items.length > 80) st.items = st.items.slice(-80)
  write(st)
  // 镜像进脑的意图账本（v3 O7）：旧账本仍是执行者，这边只观察 —— S4 再换它当主人。
  try {
    if (process.env.FEIYU_BRAIN_MIRROR !== '0') {
      brainIntents.create({
        kind: 'intent',
        object: item.what,
        text: item.text,
        verify: /看|追|番|剧|片|集/.test(item.what) ? 'ledger' : 'delivery',
        cue: { type: 'at', at: item.dueAt, label: '旧账本' },
        origin: `promise:${item.id}`,
        priority: 0.6,
      })
    }
  } catch {}
  return item
}

/** 从回复里自动记账（qq-server 每条发出的消息都会过一遍）。 */
export function catchFromReply(reply, opts = {}) {
  const got = extract(reply, opts)
  const saved = []
  const seen = new Set()
  for (const g of got) {
    const it = add(reply, g)
    if (it && it.state === 'open' && !seen.has(it.id)) { seen.add(it.id); saved.push(it) }
  }
  return saved
}

export function list(state = '') {
  const st = read()
  return state ? st.items.filter((x) => x.state === state) : st.items
}

/** 到期待办（唤醒 / 主动搭话前查这个）。 */
export function dueNow(now = Date.now()) {
  return read().items.filter((x) => x.state === 'open' && Number(x.dueAt) <= now)
}

export function openCount() {
  return list('open').length
}

export function done(id, note = '') {
  const st = read()
  const it = st.items.find((x) => x.id === id)
  if (!it) return null
  it.state = 'done'
  it.doneAt = Date.now()
  it.why = norm(note).slice(0, 120)
  write(st)
  // 脑的意图账本同步结算（旧账本先结算，脑跟着走 —— 两边都记，交叉核对）
  try {
    const mirror = brainIntents.all().find((x) => x.origin === `promise:${id}`)
    if (mirror) brainIntents.settle(mirror.id, { ok: true, evidence: [`promise:${id}${note ? ':' + note.slice(0, 40) : ''}`], force: true })
  } catch {}
  return it
}

/** 做不成：标记失败并写明原因 —— 之后她再答应这类事，提示词会拦。 */
export function fail(id, why = '') {
  const st = read()
  const it = st.items.find((x) => x.id === id)
  if (!it) return null
  it.state = 'failed'
  it.tries = Number(it.tries || 0) + 1
  it.why = norm(why).slice(0, 200)
  // 失败 2 次后推到 6 小时后再试（别每 10 分钟撞一次）
  if (it.tries >= 2) it.dueAt = Date.now() + 6 * 3600_000
  write(st)
  // 做不成 → 脑里标 blocked（不是"没发生过"，是"现在做不了"，带重试时间）
  try {
    const mirror = brainIntents.all().find((x) => x.origin === `promise:${id}`)
    if (mirror) brainIntents.settle(mirror.id, { ok: false, reason: why || 'failed' })
  } catch {}
  return it
}

/** 做不成（但还值得再试）：只把截止时间往后推，不记"失败"。
 *  用途：机器睡了一夜、binge 这次没材料 —— 不该算她失信，也不该每 60 秒重撞一次。 */
export function defer(id, min = 360, note = '') {
  const st = read()
  const it = st.items.find((x) => x.id === id)
  if (!it) return null
  it.tries = Number(it.tries || 0) + 1
  it.dueAt = Date.now() + Math.max(10, Number(min) || 360) * 60_000
  if (note) it.why = norm(note).slice(0, 200)
  write(st)
  return it
}

/** 提示词块：到期项 + 最近失败项（教她"做不到就照实说"）。 */
export function promptBlock(now = Date.now()) {
  const st = read()
  const due = st.items.filter((x) => x.state === 'open' && Number(x.dueAt) <= now)
  const failed = st.items.filter((x) => x.state === 'failed').slice(-2)
  const open = st.items.filter((x) => x.state === 'open' && Number(x.dueAt) > now).slice(-3)
  // 最近 12 小时真做成的事 —— 让她能照实说"我今天看完了第一集"，而不是又许同样的愿
  // 并账进来的（"并到「X」那条"）不算独立成就，否则同一件事在提示词里出现两遍
  const justDone = st.items.filter((x) => x.state === 'done' && now - Number(x.doneAt || 0) < 12 * 3600_000
    && !/^并到/.test(String(x.why || ''))).slice(-2)
  const parts = []
  if (justDone.length) {
    parts.push('【你最近真做成的事】（可以拿出来说，别再许同一个愿）\n'
      + justDone.map((x) => `· ${x.what}${x.why ? '：' + x.why : ''}`).join('\n'))
  }
  if (due.length) {
    parts.push('【你欠着的事 · 现在就该做】（做完再聊别的，别又只回一句"这就去看"）\n'
      + due.map((x) => `· ${x.what}（${x.id}，${x.tries ? '已经拖了 ' + x.tries + ' 次' : '到点了'}）`).join('\n'))
  }
  if (open.length) {
    parts.push('【你答应过、还没做的】\n' + open.map((x) => `· ${x.what}`).join('\n'))
  }
  if (failed.length) {
    parts.push('【这些你真没做成】（再被问起就照实说做不到，不许再空口答应）\n'
      + failed.map((x) => `· ${x.what}${x.why ? '：' + x.why : ''}`).join('\n'))
  }
  // 节奏归她自己（10-28 主人拍板："不做限制，给她自主性"）：
  // 不给她设"一天只能看一集"的规矩，但把她现在的位置告诉她，让她自己安排几集、什么时候看。
  if (justDone.length || due.length || open.length) {
    parts.push('【你自己安排】（看番/看剧没有次数限制，也不占搭话额度：'
      + '你可以一晚只看一集、也可以一口气连着看好几集，到点执行器会照你自己的话说去做；'
      + '想连看几集就直说"连看三集"，想一次看完就说"这部我今晚看完"）')
  }
  return parts.join('\n\n')
}

export const __internal = { PROMISE_RES, FILE }