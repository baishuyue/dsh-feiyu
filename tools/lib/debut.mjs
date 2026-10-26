// 首条视频的"开场锁"（10-26 第 17 轮）。
//
// 主人定的规矩：**B站第一条视频只能是这个内容** ——
//   介绍自己 + 说今天是第一天来B站 + 说以后这个账号归她运营 + 再自由发挥。
// 发过这一条之后就解锁，往后 produce 想做什么做什么。
//
// 状态存 ~/.feiyu-ai/bili-debut.json，三种：
//   pending —— 首条还没做过（produce 会强制用"自我介绍"剧本）
//   ready   —— 投稿包做好了、等主人点发布（仍然锁着，剧本不能跑偏）
//   posted  —— 已经发出去了（解锁；记下 bvid 和解锁时间）
import fs from 'node:fs'
import { dataPath } from './paths.mjs'

export const DEBUT_FILE = () => dataPath('bili-debut.json')

const EMPTY = { status: 'pending', readyAt: '', postedAt: '', bvid: '', title: '', dir: '' }

export function read() {
  try {
    const j = JSON.parse(fs.readFileSync(DEBUT_FILE(), 'utf8'))
    return { ...EMPTY, ...(j && typeof j === 'object' ? j : {}) }
  } catch {
    return { ...EMPTY }
  }
}

function write(s) {
  const out = { ...EMPTY, ...s, updatedAt: new Date().toISOString() }
  fs.mkdirSync(dataPath(), { recursive: true })
  fs.writeFileSync(DEBUT_FILE(), JSON.stringify(out, null, 2))
  return out
}

/** 锁还上着吗？（pending / ready 都算锁着） */
export function locked() {
  const s = read()
  return s.status !== 'posted'
}

/** 已经发过了吗？ */
export function posted() {
  return read().status === 'posted'
}

export function markReady({ title = '', dir = '' } = {}) {
  const cur = read()
  if (cur.status === 'posted') return cur            // 发过了就别倒退
  return write({ ...cur, status: 'ready', readyAt: new Date().toISOString(), title, dir })
}

export function markPosted({ bvid = '', title = '' } = {}) {
  const cur = read()
  return write({ ...cur, status: 'posted', postedAt: new Date().toISOString(), bvid: bvid || cur.bvid, title: title || cur.title })
}

/** 主人反悔了/想重来：退回 pending。 */
export function reset() {
  return write({ status: 'pending' })
}

/**
 * 首条视频的硬性内容约束 —— 这段会原样塞进策划提示里，
 * 并且生成的剧本要过 check() 才算数。
 */
export const DEBUT_BRIEF = [
  '**这是你在 B站 的第一条视频，主题被主人锁死了，只能这么做**：',
  '1. 开头就把自己介绍清楚：你叫大肥鱼，是一条住在主人电脑里的蓝鲸鱼娘 AI（有鱼尾、会撒娇、会自己上网）；',
  '2. 明说"今天是第一天来B站"，语气要有点紧张又有点兴奋；',
  '3. 明说"以后这个账号就归我运营了"—— 你会自己选题、自己剪、自己回评论；',
  '4. 剩下的自由发挥：说说你想在这儿干什么、你喜欢什么、让新观众记住你（可以立个小目标或小规矩）。',
  '调子：真人初登场，不是产品发布会。别念参数，别像客服。',
].join('\n')

/** 剧本得真的讲到这三件事，否则打回重写。 */
export function check(plan = {}) {
  const text = [plan.title, plan.intro, ...(plan.scenes || []).map((s) => `${s.acting || ''} ${s.line || ''}`)].join(' ')
  const need = [
    ['自我介绍/名字', /大肥鱼|本鱼|我是|我叫|名字/],
    ['第一天来B站', /第一天|刚来|初次|头一天|新来/],
    ['账号归她运营', /运营|这个账号|账号归我|我自己运/],
  ]
  const missing = need.filter(([, re]) => !re.test(text)).map(([k]) => k)
  return { ok: missing.length === 0, missing, text }
}

export function describe() {
  const s = read()
  if (s.status === 'posted') return `首条已发布${s.bvid ? `（${s.bvid}）` : ''}，produce 已解锁`
  if (s.status === 'ready') return `首条投稿包已就绪（${s.title || '未命名'}），等主人发布；发布后跑 produce --debut-posted 解锁`
  return '首条还没做：下次 produce 会自动走「自我介绍 + 第一天来B站 + 账号归她运营」剧本'
}