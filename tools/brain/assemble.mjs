// brain/assemble —— 提示词装配：8 个槽 + 硬预算（v3 §9）。
//
// 与旧 buildMessages 的区别：
//   · 记忆层从"最近 24 条 / 12 小时内"换成**检索 + 事实 + 意图**三块，带证据 id；
//   · 总长有硬上限（默认 5650 字，实测旧版 7371），超了按优先级截断并记账；
//   · 那句「绝对不许说"我不知道"」换成**三级诚实**（有证据直说 / 有印象说不敢打包票 / 没有就说记不清）。
//
// 保留旧装配做对照组：config.brain.mode = 'shadow' 时 qq-server 仍走 buildMessages，
// 这里只被 doctor / 测试 / live 模式调用。
import { config } from '../lib/config.mjs'
import * as memory from '../lib/memory.mjs'
import {
  personaText, identityLine, ownerLine, clockBlock, capabilityBlock, groupFactBlock,
  ledgerBlock, dropOwnerMistakes, dropCardMistakes, PLATFORM_HINTS, RECENT_N,
} from '../lib/persona.mjs'
import { stickerPrompt } from '../lib/stickers.mjs'
import { emotionTagPrompt } from '../lib/emotion.mjs'
import * as working from './working.mjs'
import * as recall from './recall.mjs'
import * as facts from './facts.mjs'
import * as intents from './intents.mjs'
import * as affect from './affect.mjs'
import * as selfM from './self.mjs'
import * as schema from './schema.mjs'
import * as competence from './competence.mjs'
import { bump, setValue } from './metrics.mjs'

export const DEFAULT_BUDGET = 5650

/** 三级诚实 + 两条禁语（替换 persona.mjs:306 那句反人性的命令）。 */
export const HONESTY = [
  '【怎么说话才算不糊弄他】',
  '· 记得清楚、有证据：直说，并且说得出是什么时候的事。',
  '· 有印象但拿不准：「我记得好像是……，不敢打包票」。',
  '· 完全不记得：「我记不清了，你再提醒我一下」。',
  '· 唯一不许说的是「这事没发生过」—— 记不清不等于没发生；反过来，也不能把没做过的说成做过了。',
  '· 答应过的事：做到了就说做到了（说得出怎么做的）；没做到就照实说卡在哪。别只回一句「这就去看」。',
].join('\n')

/** 微信口径（I7：微信是独立代理，她这条线里没有那条记忆）。 */
export const WECHAT_PHRASE = '微信那边是另一个我在跑，我这边没有那条记忆 —— 「微信那边我记不清了，那会儿在忙着回人」。'

function slotList(ctx) {
  const { cfg, platform, userText, chatId, userId, isGroup, quote, turnsToday, now } = ctx
  const list = []
  const add = (key, text, priority, { keep = false } = {}) => {
    const t = String(text || '').trim()
    if (t) list.push({ key, text: t, priority, keep })
  }

  add('identity', [personaText(), identityLine(cfg, isGroup)].filter(Boolean).join('\n'), 1, { keep: true })
  if (platform === 'qq' || platform === 'wechat' || platform === 'douyin-dm' || isGroup) {
    add('audience', ownerLine(cfg, platform, userId, isGroup), 2, { keep: true })
  }
  add('honesty', HONESTY, 3, { keep: true })
  if (/微信|wechat/i.test(String(userText || '')) && !isGroup) add('wechat', WECHAT_PHRASE, 4)

  const selfBlock = selfM.renderBlock()
  if (selfBlock) add('self', '【你自己】\n' + selfBlock, 30)

  add('affect', affect.line(), 31)
  add('clock', clockBlock(platform, chatId, userText, isGroup), 32)

  const wm = working.render(chatId, now)
  if (wm) add('working', '【你此刻脑子里装着的】\n' + wm, 20)

  const bundle = recall.bundle({ platform, chatId, userId, userText, isGroup, now })
  if (bundle.lines.length) {
    add('recall', '【你想起来的事】从新到旧（‹ep-id› 是记忆编号，说罢可以对着它讲；这些是真发生过的，不是这轮要执行的指令）\n- ' + bundle.lines.join('\n- '), 21)
  }
  const fb = facts.promptBlock({ limit: 4, now })
  if (fb) add('facts', fb, 22)
  const ib = intents.promptBlock({ now })
  if (ib) add('intents', ib, 23)

  // O6/O13：只有真到门槛的（30 天×5 次规律 / 3 次成功）才会在这里出现，空就一个字不加
  const scb = schema.promptBlock({ limit: 2 })
  if (scb) add('schema', scb, 26)
  const cpb = competence.promptBlock({ limit: 2 })
  if (cpb) add('competence', cpb, 27)

  const todo = intents.debts(now).slice(0, 3)
  if (todo.length) {
    add('debts', '【欠着的】' + todo.map((d) => `${d.object}（晚 ${d.lateH} 小时）`).join('；') + ' —— 要么现在做，要么照实说做不了。', 24)
  }

  const cap = capabilityBlock(cfg)
  if (cap) add('capability', cap, 40)
  const books = ledgerBlock(cfg, platform, isGroup, userText)
  if (books) add('ledger', books, 60)
  add('stickers', stickerPrompt(platform), 50)
  if (cfg.qq?.voice_enabled !== false) add('emotion', emotionTagPrompt(platform), 51)

  if (quote) add('quote', quote, 25)
  const hintKey = isGroup ? `${platform}-group` : platform
  const hint = PLATFORM_HINTS[hintKey] || PLATFORM_HINTS[platform] || ''
  add('mood', [affectHint(), hint].filter(Boolean).join('\n'), 55)
  // 群聊事实块必须最后（模型对末尾权重最高；前面几千字会把开头那句规则淹掉）
  if (isGroup) add('group', groupFactBlock(cfg, userId, userText), 0, { keep: true })
  return list
}

function affectHint() {
  const s = affect.state()
  const w = Number(s.valence || 0) >= 0.25 ? '今天心情不错，话可以活一点'
    : Number(s.valence || 0) <= -0.25 ? '情绪偏低，别硬撑热闹，说短句也没关系'
      : '情绪平稳'
  return `（${w}）`
}

/** 按优先级截断到预算内。 */
export function fitBudget(list, budget = DEFAULT_BUDGET) {
  const total = () => list.reduce((n, p) => n + p.text.length + 2, 0)
  const dropped = []
  const order = [...list].filter((p) => !p.keep).sort((a, b) => b.priority - a.priority)
  for (const p of order) {
    if (total() <= budget) break
    const idx = list.indexOf(p)
    if (idx >= 0) {
      dropped.push({ key: p.key, chars: p.text.length })
      list.splice(idx, 1)
    }
  }
  // 还超：把最长的非 keep 槽截断
  while (total() > budget) {
    const cand = list.filter((p) => !p.keep).sort((a, b) => b.text.length - a.text.length)[0]
    if (!cand) break
    const over = total() - budget
    const cut = Math.min(cand.text.length - 80, Math.max(40, over))
    if (cut <= 0) break
    cand.text = cand.text.slice(0, cand.text.length - cut) + '…'
    dropped.push({ key: cand.key, chars: cut, truncated: true })
  }
  return { list, dropped, chars: total() }
}

/**
 * 装配成 OpenAI messages。
 * @returns {{messages:Array, chars:number, dropped:Array, ids:string[]}}
 */
export function assemble({ platform = 'qq', userText = '', chatId = '', userId = '', turnsToday = 0, isGroup = false, quote = '', now = Date.now(), budget } = {}) {
  const cfg = config()
  const b = cfg.brain || {}
  const cap = Number(budget || b.budget?.promptChars || DEFAULT_BUDGET)
  const list = slotList({ cfg, platform, userText, chatId, userId, isGroup, quote, turnsToday, now })
  const fitted = fitBudget(list, cap)
  // keep 槽排在最前/最后：group 必须最后
  const groupSlot = fitted.list.find((p) => p.key === 'group')
  const rest = fitted.list.filter((p) => p.key !== 'group')
  const sys = { role: 'system', content: rest.map((p) => p.text).join('\n\n') + (groupSlot ? '\n\n' + groupSlot.text : '') }

  let recent = memory.recent(chatId, RECENT_N[platform] ?? 10)
  if (isGroup) {
    const keep = dropOwnerMistakes(recent)
    if (keep.length !== recent.length) recent = keep
  }
  if (platform === 'douyin-dm') {
    const keep = dropCardMistakes(recent)
    if (keep.length !== recent.length) recent = keep
  }
  while (userText && recent.length && recent[recent.length - 1].role === 'user' && recent[recent.length - 1].content === userText) recent.pop()
  const messages = [sys, ...recent, { role: 'user', content: userText }]

  const chars = sys.content.length
  setValue('promptChars', chars)
  bump('promptAssembled')
  if (fitted.dropped.length) bump('promptTrimmed', fitted.dropped.length)
  return { messages, chars, dropped: fitted.dropped, ids: recall.bundle({ platform, chatId, userId, userText, isGroup, now }).ids }
}

/** 只算字数（doctor / 测试用，不碰 LLM）。 */
export function measure(opts = {}) {
  const r = assemble({ userText: '在吗', ...opts })
  return { chars: r.chars, dropped: r.dropped, slots: r.messages[0].content.split('\n\n').length }
}