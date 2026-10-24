// 作息计划：窗口内随机时刻醒来，跨零点/最小间隔/重启不重抽。
// 复用 dsh-bili-whale 的 tools/lib/night-plan.mjs（MIT）——纯函数，无文件依赖。
// 这些坑它都替我们踩过了：相邻唤醒挤在一起（硬下限 minGapMin）、skip 拉黑整个窗口、
// 配置保存清掉历史、跨午夜绝对时间戳。别改逻辑，改了就是重踩一遍 ✗

export const dayOf = (value = Date.now()) => new Date(value).toLocaleDateString('sv-SE')
const stamp = (day, minutes) => {
  const d = new Date(`${day}T00:00:00`)
  d.setMinutes(minutes)
  return d.getTime()
}
const parse = (s) => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(s))
  if (!match) throw new Error(`无效作息时间：${s}`)
  const h = Number(match[1]), m = Number(match[2])
  if (h > 24 || m > 59 || (h === 24 && m !== 0)) throw new Error(`无效作息时间：${s}`)
  return h * 60 + m
}
export function windowsOf(cfg) {
  const list = Array.isArray(cfg.windows) ? cfg.windows : [{ start: cfg.windowStart ?? '20:00', end: cfg.windowEnd ?? '24:00', wakes: cfg.maxWakesPerDay ?? 1 }]
  return list.map(w => {
    const start = parse(w.start), rawEnd = parse(w.end)
    const end = rawEnd <= start ? rawEnd + 1440 : rawEnd
    return { start, end, wrap: end > 1440, label: `${w.start}–${w.end}`, wakes: Math.min(12, Math.max(0, Math.floor(Number(w.wakes ?? 1) || 0))) }
  })
}
export const maxWakes = cfg => Math.min(12, windowsOf(cfg).reduce((n, w) => n + w.wakes, 0))
export function occurrences(cfg, now = Date.now()) {
  const today = dayOf(now), yesterday = new Date(`${today}T00:00:00`)
  yesterday.setDate(yesterday.getDate() - 1)
  return windowsOf(cfg).flatMap(w => (w.wrap ? [dayOf(yesterday), today] : [today]).map(day => ({
    ...w, key: `${day}|${w.label}`, startsAt: stamp(day, w.start), endsAt: stamp(day, w.end),
  }))).filter(w => w.endsAt > now)
}
export const inWindow = (cfg, now = Date.now()) => occurrences(cfg, now).some(w => w.startsAt <= now)

// 按日期化的窗口保留历史：配置保存不清掉已用次数。
export function historyOf(state = {}, now = Date.now()) {
  const usedCount = { ...(state.usedCount ?? {}) }
  const skippedWindows = new Set(state.skippedWindows ?? [])
  if (state.schema !== 2 && state.date) {
    for (const [label, count] of Object.entries(usedCount)) {
      if (!label.includes('|')) {
        const reserved = state.action === 'wake' && !state.fired && !state.woke && label === state.window ? 1 : 0
        usedCount[`${state.date}|${label}`] = Math.max(0, Number(count) - reserved)
        delete usedCount[label]
      }
    }
    if (state.action === 'skip' && state.fired && state.window) skippedWindows.add(`${state.date}|${state.window}`)
  }
  const cutoff = new Date(now); cutoff.setDate(cutoff.getDate() - 3)
  for (const key of Object.keys(usedCount)) if (key.slice(0, 10) < dayOf(cutoff)) delete usedCount[key]
  return { schema: 2, date: dayOf(now), wakes: state.date === dayOf(now) ? Number(state.wakes ?? 0) : 0,
    wokeAt: state.wokeAt ?? null, usedCount, skippedWindows: [...skippedWindows].filter(key => key.slice(0, 10) >= dayOf(cutoff)) }
}
export function isPending(state, now = Date.now()) {
  return state?.schema === 2 && ['wake', 'skip'].includes(state.action) && !state.fired && !state.woke &&
    Number.isFinite(state.atMs) && Number.isFinite(state.endsAt) && state.endsAt > now
}
export function makePlan(cfg, state = {}, now = Date.now(), random = Math.random) {
  // 关键修复：isPending 只查"有没有未完成的计划"，不查"这个计划的窗口还是不是当前配置的窗口"。
  // 用户把作息从 20:00 改成 17:00 后，旧的 pending 计划（20:00–24:00）会被直接复用，导致新窗口不生效。
  // 这里补一条：pending 计划的 windowKey 必须仍在当前配置的 occurrences 里，否则作废重算。
  if (isPending(state, now) && occurrences(cfg, now).some(w => w.key === state.windowKey)) return state
  const history = historyOf(state, now)
  const done = reason => ({ ...history, action: 'done', done: true, reason })
  if (history.wakes >= maxWakes(cfg)) return done('今天醒来次数已用完（或所有窗口为零次）')
  const pool = occurrences(cfg, now).filter(w => w.wakes > (history.usedCount[w.key] ?? 0))
    .sort((a, b) => a.endsAt - b.endsAt || a.startsAt - b.startsAt)
  if (!pool.length) return done('今天可用窗口已结束或已经处理')

  const lastWoke = Number.isFinite(Date.parse(state.wokeAt ?? '')) ? Date.parse(state.wokeAt) : 0
  const minGapMs = Math.max(
    60_000,
    Math.floor((Number.isFinite(Number(cfg.minGapMin)) ? Number(cfg.minGapMin) : 10) * 60_000),
  )
  let picked = null
  for (const cand of pool) {
    const gap = minGapMs
    const earliest = Math.max(now, cand.startsAt, lastWoke + gap)
    if (earliest >= cand.endsAt - 30_000) continue   // 这个窗口放不下了
    picked = { cand, earliest }
    break
  }
  if (!picked) return done('今天可用窗口里已经排不下下一次（间隔不够）')
  const w = picked.cand
  const from = picked.earliest
  const atMs = from + Math.floor(random() * Math.max(1, w.endsAt - from))
  const atDate = new Date(atMs), at = atDate.getHours() * 60 + atDate.getMinutes()
  const skip = random() < Math.min(1, Math.max(0, Number(cfg.skipChance ?? 0.3)))
  return { ...history, action: skip ? 'skip' : 'wake', fired: false, atMs, at,
    atText: `${dayOf(atMs)} ${String(atDate.getHours()).padStart(2, '0')}:${String(atDate.getMinutes()).padStart(2, '0')}`,
    window: w.label, windowKey: w.key, startsAt: w.startsAt, endsAt: w.endsAt,
    withinWindow: `${w.label} 第 ${(history.usedCount[w.key] ?? 0) + 1}/${w.wakes} 次`,
    maxVideos: cfg.maxVideos ?? 5, createdAt: new Date(now).toISOString(),
    ...(skip ? { reason: '本次计划跳过看视频，仍写日记' } : { roll: 'watch' }) }
}
export function completePlan(state, now = Date.now()) {
  if (state.fired) return state
  const h = historyOf(state, now)
  if (!state.windowKey) throw new Error('计划缺少窗口标识，请重新 plan')
  if (state.action === 'skip' || state.action === 'wake') {
    h.usedCount[state.windowKey] = (h.usedCount[state.windowKey] ?? 0) + 1
    h.wakes += 1
  }
  return { ...state, ...h, fired: true, woke: state.action === 'wake', wokeAt: new Date(now).toISOString() }
}
