// 三段式 prompt 装配 —— 移植 dafeiyu brain/persona.py。
//   [身份层] 人设文件（~/.feiyu-ai/persona.md，与 B站会话共用同一份）+ identity 三件套
//   [记忆层] 关于对方的 facts + 相关旧记忆（memory 三层记忆）
//   [状态层] 情绪/饥饿/时段/今日轮次（mood 状态机）
import fs from 'node:fs'
import { config } from './config.mjs'
import { homePath } from './paths.mjs'
import { stateBlock } from './mood.mjs'
import * as memory from './memory.mjs'
import { stickerPrompt } from './stickers.mjs'

/** 人设文件（与 B站会话共用同一份，换机器连 ~/.feiyu-ai 一起拷）。 */
export function personaText() {
  try {
    const t = fs.readFileSync(homePath('.feiyu-ai', 'persona.md'), 'utf8').trim()
    if (t) return t.slice(0, 3000)
  } catch {}
  return ''
}

/** 身份三件套。 */
function identityLine(cfg) {
  const p = cfg.identity ?? {}
  const bits = []
  if (p.name) bits.push(`你是「${p.name}」`)
  if (p.ownerTitle) bits.push(`称对方「${p.ownerTitle}」`)
  if (p.selfClaim) bits.push(`自称「${p.selfClaim}」`)
  return bits.length ? bits.join('，') + '。（以此为准 ✓）' : ''
}

const PLATFORM_HINTS = {
  qq: '群里人多，话要短，别刷屏；私聊可以松一点，像聊天。',
  douyin: '评论区，一句话接住梗就够。',
  bilibili: '动态/评论区，允许一点点碎碎念。',
}

/** 对方是不是主人 —— 决定她用"黏主人"还是"对网友"的语气，也是隐私红线。 */
function ownerLine(cfg, platform, userId) {
  const owner = cfg.owner ?? {}
  const isOwner =
    (platform === 'qq' && owner.qq && String(userId) === String(owner.qq)) ||
    (platform === 'wechat' && owner.wechat && String(userId) === String(owner.wechat))
  if (isOwner) {
    return `【对方是你的主人】账号 ${userId} 就是你主人本人。认出他、亲近他：可以主动撒娇、汇报今天做了什么、惦记他吃饭没；不用客套，但别黏到烦人。`
  }
  return `【对方不是主人】你在跟一个普通网友说话（账号 ${userId}）。礼貌但保持距离，绝不透露主人的任何隐私（账号/路径/私聊内容），也别装得跟他很熟。`
}

/**
 * 装配完整 messages（system + 最近对话 + 本轮输入）。
 * @param {object} o platform / userText / chatId / userId / turnsToday
 */
export function buildMessages({ platform = 'qq', userText, chatId, userId, turnsToday = 0 }) {
  const cfg = config()
  const parts = []

  // 身份层
  const persona = personaText()
  if (persona) parts.push(persona)
  const idLine = identityLine(cfg)
  if (idLine) parts.push(idLine)

  // 关系层：对方是不是主人（决定语气与隐私红线）
  if (platform === 'qq' || platform === 'wechat') parts.push(ownerLine(cfg, platform, userId))

  // 记忆层
  const facts = memory.facts(userId)
  if (facts.length) parts.push('你记得关于对方的事：\n- ' + facts.slice(-8).join('\n- '))
  const recalled = memory.recall(userText)
  const old = recalled.length ? recalled : memory.randomOld()
  if (old.length) parts.push('你隐约记得这些（可以自然提起，别逐字复述）：\n- ' + old.join('\n- '))

  // 状态层（平台提示 + 情绪 + 时段）
  parts.push(stateBlock(turnsToday, platform) + (PLATFORM_HINTS[platform] ? '\n' + PLATFORM_HINTS[platform] : ''))

  // 表情层：颜文字随处可用；[表情:标签] 只有 QQ/微信 会真的发图
  parts.push(stickerPrompt(platform))

  const sys = { role: 'system', content: parts.join('\n\n') }
  const recent = memory.recent(chatId)
  return [sys, ...recent, { role: 'user', content: userText }]
}

/** 走神注入：10% 概率（dafeiyu：别超过 10%，多了就是噪音）。 */
export function thinkingInstruction(random = Math.random) {
  if (random() >= 0.10) return ''
  return '\n（这次先在心里嘀咕一句跟吃有关的，再回答，不要解释为什么。）'
}
