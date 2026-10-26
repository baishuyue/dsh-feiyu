// 情绪状态机 —— dafeiyu 骨架 brain/persona.py 的 JS 移植（tick_mood + state_block）。
//
// 「活」的来源：情绪会自己漂移；饭点会饿；饿过头心情掉；偶尔无理由波动。
// 状态持久化在 ~/.feiyu-ai/mood.json —— CLI（每次新进程）与宿主生物钟共用同一份 ✓
import fs from 'node:fs'
import { dataPath } from './paths.mjs'

const MOOD_FILE = dataPath('mood.json')

/** 饭点：到点了坐不住（与 dafeiyu 一致：午饭 11-12 点、晚饭 17-18 点）。 */
const HUNGRY_HOURS = new Set([11, 12, 17, 18])

function readState() {
  try {
    const j = JSON.parse(fs.readFileSync(MOOD_FILE, 'utf8'))
    return {
      value: Number.isFinite(Number(j.value)) ? Number(j.value) : 62,
      hunger: Number.isFinite(Number(j.hunger)) ? Number(j.hunger) : 0,
      updatedAt: j.updatedAt ?? null,
    }
  } catch { return { value: 62, hunger: 0, updatedAt: null } }
}

function writeState(st) {
  try {
    fs.mkdirSync(dataPath(), { recursive: true })
    fs.writeFileSync(MOOD_FILE, JSON.stringify(st, null, 2) + '\n')
  } catch {}
}

/**
 * 情绪 tick。每次唤醒/对话前调用一次。
 * ① 饭点 hunger +7，其他时间 -0.5  ② 饿过头（>60）心情 -4
 * ③ 6% 概率无理由波动 {-9,-4,+5,+8}  ④ clamp 0-100
 */
export function tickMood(random = Math.random) {
  const st = readState()
  const hour = new Date().getHours()
  if (HUNGRY_HOURS.has(hour)) st.hunger = Math.min(100, st.hunger + 7)
  else st.hunger = Math.max(0, st.hunger - 0.5)
  if (st.hunger > 60) st.value -= 4
  if (random() < 0.06) st.value += [-9, -4, 5, 8][Math.floor(random() * 4)]
  st.value = Math.max(0, Math.min(100, st.value))
  st.updatedAt = new Date().toISOString()
  writeState(st)
  return st
}

export function mood() { return readState() }

/** 时段 phase —— 同一句话在 7 点和 2 点必须不一样（dafeiyu 的核心设计）。 */
function phaseText(now = new Date()) {
  const h = now.getHours()
  if (h >= 6 && h < 10) return '刚醒，脑子还没转，回答会很短'
  if (h >= 10 && h < 11) return '上午，正常'
  if (h >= 11 && h < 13) return '到饭点了，你有点坐不住，会不自觉提吃的'
  if (h >= 13 && h < 17) return '下午，困，容易走神'
  if (h >= 17 && h < 20) return '饿，等着吃晚饭'
  if (h >= 20 && h < 24) return '晚上精神最好，话多'
  return '半夜，有点困但不想睡'
}

/**
 * 注入提示的【当下状态】块 —— dafeiyu persona.py state_block 的移植。
 * @returns {string}
 */
const PLATFORM_STATE = {
  qq: 'QQ 私聊（只有你和主人两个人；这里才该叫主人、才聊私事）',
  wechat: '微信私聊（一句一句聊，别写成一大段）',
  bilibili: 'B站评论区/动态（允许碎碎念，但别刷屏）',
  douyin: '抖音评论区（一句话接住梗就够）',
}

export function stateBlock(turnsToday = 0, platform = 'bilibili', isGroup = false) {
  const now = new Date()
  const m = readState()
  const style = m.value < 30 ? '不太想说话，句子压到 15 字以内'
    : m.value > 75 ? '挺高兴，可以主动闹一点'
    : '正常，按平时说话'
  const hunger = m.hunger > 60 ? `饿（${Math.round(m.hunger)}/100），满脑子都是吃的。` : ''
  // 群聊必须**明说**在群里（10-26）：原来写"QQ（私聊或群聊，按上下文判断）"，
  // 等于让她自己猜，猜错就把群友当主人。轮数同理 —— 群里的 34 条不是"跟他聊了 34 轮"。
  const platformText = isGroup ? 'QQ 群（群里好几个人在，说话的是群友，不是只有主人）'
    : (PLATFORM_STATE[platform] || platform)
  const turnLine = isGroup ? `这个群今天说了 ${turnsToday} 条。`
    : `今天已经聊了 ${turnsToday} 轮。${turnsToday > 40 ? '有点累了，敷衍一点。' : ''}`
  const lines = [
    `现在是 ${now.toLocaleString('sv-SE', { hour12: false })}（${phaseText(now)}）。`,
    `情绪 ${Math.round(m.value)}/100：${style}`,
    hunger,
    turnLine,
    `当前平台：${platformText}。`,
  ].filter(Boolean)
  return '【当下状态】\n' + lines.join('\n')
}

/**
 * 走神注入 —— 10% 概率嘀咕一句跟吃有关的，多了就成噪音（dafeiyu：别超过 10%）。
 */
export function distract(random = Math.random) {
  if (random() >= 0.10) return ''
  const lines = [
    '（这次先在心里嘀咕一句跟吃有关的，再干活，不要解释为什么。）',
    '（干活中途允许走神一次，想着中午那碗白饭，别解释。）',
    '（先想想今天 token 饭钱花了几块，再干活，别解释。）',
  ]
  return '\n' + lines[Math.floor(random() * lines.length)]
}
