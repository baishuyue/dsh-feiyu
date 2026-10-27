// owner-facts —— 「主人今天已经说过的事」硬账本（10-27 主人报的"连问十次吃没吃饭"）
//
// 病根：`facts.json` 里根本没有 owner 这个键 —— 她每一轮都没有任何"主人已经答过"的硬事实，
// 于是把"你吃了吗"当成永远没有答案的问题，靠 11 分钟一条的主动搭话反复问。
//
// 这里用**规则**抽（不额外调模型，不花 token）：
//   吃了什么 / 在干什么 / 要去干什么 / 心情 / 他提到的东西（番剧、作品…）
// 一条一个 key，同 key 覆盖（"吃了烧鸭" → 后来"吃了面"就换掉），存进 facts.json 的 owner 桶。
//
// 注入时渲染成【今天已经知道的事】，并明确"这些不用再问"。
import * as memory from './memory.mjs'

export const OWNER_KEY = 'owner'

/** 一条事实的形状：`key|内容|时间`。用 | 分隔，纯文本、好 grep 也好 debug。 */
const SEP = '|'

const RULES = [
  // 吃了什么（主人 12:47 说过"吃了烧鸭"，她 13:26 还在问）
  { key: 'food', re: /(?:我|俺)?(?:刚刚?|今天|中午|上午|晚上|早饭|午饭|晚饭)?(?:吃|喝)(?:了|过|的是|的)([^\n，。！？,.!?]{1,18})/ },
  { key: 'food', re: /(?:刚|正在|在)吃([^\n，。！？,.!?]{1,18})/ },
  // 在干什么
  { key: 'doing', re: /我(?:在|正在|这边在)([^\n，。！？,.!?]{1,24})/ },
  { key: 'doing', re: /我(?:今天|现在)?(?:忙|加班|写|做|学|改|修)([^\n，。！？,.!?]{0,20})/ },
  // 要去干什么（他答应/计划的事）—— "我明天要去看牙"：时间词在"要"前面，所以先吃时间再吃情态
  { key: 'plan', re: /我(?:明天|后天|等会|待会|下午|晚上|周末)?(?:要|准备|打算|得|需要)(?:去|做|看|见)([^\n，。！？,.!?]{1,24})/ },
  // 心情/状态
  { key: 'mood', re: /我(?:有点|很|好|特别|今天)?(累了|累|困|烦|难受|开心|不高兴|无聊|生病|感冒|加班累)/ },
  // 他点名的作品（番剧/电影/书）—— 她答应要看的那种
  { key: 'media', re: /《([^》]{1,24})》/ },
  { key: 'media', re: /(?:看|追)(?:一部|个)?(?:番|剧|电影|片)?(?:叫做|叫|名叫)?\s*([一-龥A-Za-z0-9・·]{1,12}(?:记忆|物语|故事|之|传|记|番|剧))/ },
]

/** 一句话里抽出来的事实（可能多条）。 */
export function extract(text) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!s) return []
  const out = []
  const seen = new Set()
  for (const r of RULES) {
    const m = r.re.exec(s)
    if (!m) continue
    const val = String(m[1] ?? '').trim()
    if (!val || val.length < 1) continue
    const k = r.key + ':' + val
    if (seen.has(k)) continue
    seen.add(k)
    out.push({ key: r.key, value: val, line: s.slice(0, 80) })
  }
  return out
}

function esc(s) { return String(s).replace(/[|\n]/g, ' ').slice(0, 60) }

/** 记一条（同 key 覆盖：以最新的为准 —— memory.addOwnerFact 内部按 key 去重）。 */
export function put(key, value, raw = '') {
  const at = new Date().toLocaleTimeString('zh-CN', { hour12: false }).slice(0, 5)
  const line = [String(key), esc(value), at, esc(raw)].join(SEP)
  memory.addOwnerFact(line)
  return line
}

/** 从主人一句话里学（自动抽取 + 落盘）。返回学到的条目。 */
export function learnFromOwner(text) {
  const got = extract(text)
  for (const g of got) put(g.key, g.value, g.line)
  return got
}

/** 读全部（新到旧里挑同 key 最新一条）。 */
export function list() {
  const arr = memory.facts(OWNER_KEY, 60)
  const byKey = new Map()
  for (const item of arr) {
    const parts = String(item).split(SEP)
    const key = parts[0]
    if (!key) continue
    byKey.set(key, { key, value: parts[1] ?? '', at: parts[2] ?? '', raw: parts[3] ?? '' })
  }
  return [...byKey.values()]
}

export function get(key) {
  return list().find((x) => x.key === key) || null
}

/** 今天已经知道的事 → 提示词块（没有就返回空串，绝不编）。 */
export function promptBlock() {
  const rows = list()
  if (!rows.length) return ''
  const label = { food: '他吃过的东西', doing: '他在做什么', plan: '他说要去做的', mood: '他的状态', media: '他提到的作品' }
  const lines = rows.map((r) => `· ${label[r.key] || r.key}：${r.value}${r.at ? '（' + r.at + ' 他说的）' : ''}`)
  return '【今天已经知道的事】（他自己说的，**不用再问一遍**；问第二遍他会觉得你根本没在听）\n' + lines.join('\n')
}

/** 草稿在问"吃了吗/在干嘛"这类已经有答案的问题吗 —— 推送前的事实闸用它。 */
const ASK_FOOD = /(吃(了|过)?(饭|东西)?(了)?(吗|没|么|嘛)|吃没吃|吃饭了没|你吃了|吃啥了|中午吃|晚饭吃|早饭吃)/
const ASK_DOING = /(在(干嘛|干什么|忙什么|做什么)|忙完了没|忙完了吗|在忙)/
export function asksKnown(draft) {
  const s = String(draft ?? '')
  const has = (k) => Boolean(get(k))
  if (ASK_FOOD.test(s) && has('food')) return { key: 'food', value: get('food').value }
  if (ASK_DOING.test(s) && has('doing')) return { key: 'doing', value: get('doing').value }
  return null
}

export const __internal = { RULES, SEP }