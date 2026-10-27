// focus —— 她「此刻在做的那一件事」（10-26 主人拍板）
//
// 背景：完全自由原本的设计是"给她很高权限，让她自己决定干什么"。
// 我第一版把它做成了三条常驻循环一起开 —— 那不是自主，那是三条流水线并行；
// 活人不会一边刷抖音一边刷B站一边上网。**一个人一次只能干一件事，干完歇一会儿再挑下一件。**
//
// 所以现在的模型：
//   · 完全自由（freedom）= 只负责"按时摇她起来"，不定她干什么
//   · 她醒了，自己挑一件，用 `feiyu focus <活动> --min <分钟>` 定下来（这就是"自主"）
//   · 宿主半边（lib/index.js）每 60 秒按这份状态**只放行一个**常驻循环，其余一律停掉
//   · 到点自动收工 → 回到"自由时间"（什么都不跑），下次醒了她再挑
//   · 歇着（rest）也是正经选项：人不可能一刻不停地刷
//
// 这份状态就是"她当下在做的那件事"，全项目唯一真相。
import fs from 'node:fs'
import path from 'node:path'
import { dshPath } from './paths.mjs'

export const FOCUS_PATH = dshPath('feiyu-focus.json')

/** 可以"占住一段时间"的常驻活动（各自对应一个循环进程）。 */
export const LOOP_ACTIVITIES = {
  web: { label: '自由上网', sw: ['web', 'roam'], hint: '逛网页/搜索/读文章/写小说' },
  bilibili: { label: '刷B站', sw: ['bilibili', 'freeRoam'], hint: '看视频/深读/评论/发动态' },
  douyin: { label: '刷抖音', sw: ['douyin', 'freeRoam'], hint: '刷视频/看评论/回私信' },
  // 看番（10-27 新增）：她说"这就去看"必须真有个动作。binge 是一次性命令，
  // 不需要自己的循环；这里让它占住时间（其余循环全关），她会调 `feiyu binge --show … --go`。
  binge: { label: '看番/看剧', sw: ['bilibili', 'bingeLoop'], hint: '用 binge 真的看完一集，看完写感受' },
}

/** 别名 → 规范名（她可能写 bili / B站 / douyin） */
export function normActivity(a) {
  const s = String(a ?? '').trim().toLowerCase()
  if (!s) return ''
  if (['web', '上网', 'browse', 'net'].includes(s)) return 'web'
  if (['bili', 'bilibili', 'b站', 'b站刷', 'bl'].includes(s)) return 'bilibili'
  if (['douyin', 'dy', '抖音'].includes(s)) return 'douyin'
  if (['binge', '看番', '看剧', '追番', 'anime'].includes(s)) return 'binge'
  if (['rest', '歇', '歇着', '休息', 'idle', '躺'].includes(s)) return 'rest'
  if (['off', 'stop', '收工', '结束', 'none', '空'].includes(s)) return 'off'
  return s
}

export const isLoopActivity = (a) => Object.prototype.hasOwnProperty.call(LOOP_ACTIVITIES, String(a ?? ''))

export function labelOf(a) {
  const k = String(a ?? '')
  if (isLoopActivity(k)) return LOOP_ACTIVITIES[k].label
  if (k === 'rest') return '歇着'
  if (k === 'off') return '自由时间（没在做具体的）'
  return k || '没记录'
}

/** 读当下状态。文件不在 / 坏了都返回 null —— 不干预。 */
export function readFocus() {
  try {
    const j = JSON.parse(fs.readFileSync(FOCUS_PATH, 'utf8'))
    if (!j || typeof j !== 'object') return null
    return j
  } catch { return null }
}

/**
 * 写下"我现在在干什么"。
 * @param {string} activity web|bilibili|douyin|rest|off
 * @param {number} min 打算干多久（分钟，0 = 不设时限，靠她自己收工）
 * @param {string} note 一句话（写给自己/给主人看的由头）
 */
export function writeFocus(activity, min = 0, note = '') {
  const now = Date.now()
  const mins = Math.max(0, Math.round(Number(min) || 0))
  const obj = {
    activity: String(activity),
    until: mins > 0 ? now + mins * 60_000 : 0,
    setAt: now,
    min: mins,
    note: String(note || '').slice(0, 200),
  }
  try {
    fs.mkdirSync(path.dirname(FOCUS_PATH), { recursive: true })
    fs.writeFileSync(FOCUS_PATH, JSON.stringify(obj, null, 2))
  } catch {}
  return obj
}

export function clearFocus() {
  try { fs.rmSync(FOCUS_PATH, { force: true }) } catch {}
}

/** 组装一份好用的快照（提示语里直接念给人听）。 */
export function focusSnapshot(now = Date.now()) {
  const f = readFocus()
  if (!f || !f.activity) return { activity: '', label: '', remainMin: 0, expired: false, note: '', setAgoMin: 0 }
  const until = Number(f.until || 0)
  const remainMin = until ? Math.max(0, Math.round((until - now) / 60_000)) : 0
  return {
    activity: String(f.activity),
    label: labelOf(f.activity),
    remainMin,
    expired: !!until && until <= now,
    note: String(f.note || ''),
    setAgoMin: Math.round((now - Number(f.setAt || now)) / 60_000),
    min: Number(f.min || 0),
  }
}

/** 把配置里的三个循环开关对齐到"当下只开一个"（其余关掉）。 */
export function syncSwitches(cfg, activity) {
  let changed = false
  for (const [key, meta] of Object.entries(LOOP_ACTIVITIES)) {
    const [sec, sub] = meta.sw
    const want = key === activity
    if (!cfg[sec] || typeof cfg[sec] !== 'object') cfg[sec] = {}
    const had = cfg[sec][sub] && typeof cfg[sec][sub] === 'object'
    const cur = had ? cfg[sec][sub] : {}
    // 缺的开关也要**建出来**（10-27）：以前只在"值与期望不同"时才写，
    // 新增活动（binge）的开关永远不存在 → 事后查状态时读 undefined 就炸。
    if (!had || (cur.enabled === true) !== want) { cfg[sec][sub] = { ...cur, enabled: want }; changed = true }
  }
  return changed
}