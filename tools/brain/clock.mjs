// brain/clock —— 绝对时间存取 + 相对时间换算（v3 §7/§8）。
//
// 两条硬规矩（都是 10-27~10-29 踩出来的）：
//   1. 存的一定是绝对时间（带时区的 ISO）；只显示相对时间（"昨天下午"）。
//   2. 说话时的"今天/明早/周末"必须在**写入那一刻**换算成绝对区间，
//      否则一周后的"今天吃了烧鸭"还会被当成今天的（audit M6 的第一号实锤）。

const pad = (n) => String(n).padStart(2, '0')

/** 本地 ISO（带 +08:00 这类偏移，不存 UTC 裸串）。 */
export function isoOf(ts = Date.now()) {
  const d = new Date(Number(ts))
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const abs = Math.abs(off)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

export function dayKey(ts = Date.now()) {
  const d = new Date(Number(ts))
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
}

export function hms(ts = Date.now()) {
  const d = new Date(Number(ts))
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export const WEEK_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** 一天里的相位。 */
export function phaseOf(ts = Date.now()) {
  const h = new Date(Number(ts)).getHours()
  if (h < 5) return '深夜'
  if (h < 8) return '清晨'
  if (h < 11) return '上午'
  if (h < 13) return '中午'
  if (h < 17) return '下午'
  if (h < 19) return '傍晚'
  if (h < 23) return '晚上'
  return '深夜'
}

/** 相对时间文本："刚刚 / 12 分钟前 / 3 小时前 / 昨天下午 / 3 天前"。 */
export function relTime(ts, now = Date.now()) {
  const t = Number(ts) || 0
  if (!t) return ''
  const dt = Math.max(0, Number(now) - t)
  const min = dt / 60000
  if (min < 1) return '刚刚'
  if (min < 60) return `${Math.round(min)} 分钟前`
  const hr = min / 60
  const a = new Date(t), b = new Date(Number(now))
  const dayDiff = Math.round((new Date(b.getFullYear(), b.getMonth(), b.getDate()) - new Date(a.getFullYear(), a.getMonth(), a.getDate())) / 86400000)
  if (dayDiff === 0) return `${Math.round(hr)} 小时前`
  if (dayDiff === 1) return `昨天${phaseOf(t)}`
  if (dayDiff === 2) return `前天${phaseOf(t)}`
  if (dayDiff < 7) return `${dayDiff} 天前`
  return `${Math.floor(dayDiff / 7)} 周前`
}

/** 短时标："10-29 17:18"（渲染记忆行用）。 */
export function stamp(ts) {
  const d = new Date(Number(ts))
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hms(ts)}`
}

const dayStart = (base) => new Date(base.getFullYear(), base.getMonth(), base.getDate(), 0, 0, 0, 0)
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes(), d.getSeconds())
const at = (d, h, m = 0) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m, 0, 0)

/** 下一个周 X（0=周日）。 */
function nextWeekday(now, targetDow, includeToday = false) {
  const d = dayStart(now)
  const cur = d.getDay()
  let delta = (targetDow - cur + 7) % 7
  if (delta === 0 && !includeToday) delta = 7
  return addDays(d, delta)
}

const ZH_DOW = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 }

/**
 * 把"今天/明早/周末/周三 19:30"这类说法换算成绝对区间。
 * @returns {{from:number,to:number,label:string}|null}
 */
export function resolveRelative(text, now = Date.now()) {
  const s = String(text || '')
  if (!s.trim()) return null
  const base = new Date(Number(now))

  // 19:30 / 9点半 / 9 点 40
  const clock = (() => {
    let m = s.match(/(\d{1,2})[:：](\d{2})/)
    if (m) return { h: Number(m[1]), m: Number(m[2]) }
    m = s.match(/(\d{1,2})\s*点\s*(半|(\d{1,2})\s*分?)?/)
    if (m) return { h: Number(m[1]), m: m[2] === '半' ? 30 : Number(m[3] || 0) }
    return null
  })()

  const dayOf = () => {
    if (/后天/.test(s)) return addDays(dayStart(base), 2)
    if (/明天|明早|明晚|明儿/.test(s)) return addDays(dayStart(base), 1)
    if (/昨天|昨晚/.test(s)) return addDays(dayStart(base), -1)
    if (/今天|今晚|今儿|待会|稍后/.test(s)) return dayStart(base)
    const w = s.match(/周([一二三四五六日天])|星期([一二三四五六日天])/)
    if (w) return nextWeekday(base, ZH_DOW[w[1] || w[2]])
    if (/周末/.test(s)) return nextWeekday(base, 6)
    return null
  }

  let d = dayOf()
  if (clock) {
    const anchor = d || dayStart(base)
    let from = at(anchor, clock.h, clock.m)
    // 没写日期又说"9 点"：过了点就算明天（selfwake 同款口径）
    if (!d && from.getTime() <= now) from = at(addDays(dayStart(base), 1), clock.h, clock.m)
    return { from: from.getTime(), to: from.getTime() + 60 * 60 * 1000, label: s.trim().slice(0, 24) }
  }
  if (!d) return null
  // 没写具体时刻：按"这个词覆盖的那一段"给区间
  let from, to
  if (/明早|清晨|早上|上午/.test(s)) { from = at(d, 6); to = at(d, 11, 59) }
  else if (/中午/.test(s)) { from = at(d, 11); to = at(d, 13, 59) }
  else if (/下午/.test(s)) { from = at(d, 13); to = at(d, 17, 59) }
  else if (/傍晚/.test(s)) { from = at(d, 17); to = at(d, 19, 59) }
  else if (/今晚|晚上|明晚|夜里|深夜/.test(s)) { from = at(d, 18); to = at(d, 23, 59) }
  else if (/周末/.test(s)) { from = at(d, 0); to = at(addDays(d, 1), 23, 59) }
  else { from = at(d, 0); to = at(d, 23, 59) }
  // "明天"整体：给整天
  if (!/早|午|晚|夜|周末|点/.test(s) && /明天|今天|后天|昨天/.test(s)) { from = at(d, 0); to = at(d, 23, 59) }
  return { from: from.getTime(), to: to.getTime(), label: s.trim().slice(0, 24) }
}

/** 意图的时间线索："20 分钟后 / 2 小时后 / 9:40 / 明早九点四十"。 */
export function parseCue(text, now = Date.now()) {
  const s = String(text || '')
  let m = s.match(/(\d+)\s*(分钟|分|小时|钟头|天)\s*(后|以后|之后)/)
  if (m) {
    const n = Number(m[1])
    const unit = /分钟|分/.test(m[2]) ? 60000 : /小时|钟头/.test(m[2]) ? 3600000 : 86400000
    return { type: 'after', at: now + n * unit, label: m[0] }
  }
  const r = resolveRelative(s, now)
  if (r) return { type: 'at', at: r.from, label: r.label, to: r.to }
  return null
}

/** 今天 23:59:59（"今天吃了什么"这类事实的有效期）。 */
export function endOfDay(ts = Date.now()) {
  const d = new Date(Number(ts))
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999).getTime()
}