// QQ 专属的长期记忆：滚动摘要 + 主人画像。
//
// 为什么要单独一套：
//   · 微信是"顺手回两句"，QQ 是跟主人聊天 —— 需要记得更久、更懂他这个人；
//   · 光靠 recent(24 条) 还是会被截断，所以每聊几轮就用 LLM 把这段对话压成摘要，
//     再抽一份"关于主人的稳定事实"（称呼、作息、工作、最近在烦什么）滚雪球式更新；
//   · 这些都落在 ~/.feiyu-ai/qq/ 下，跟微信/B站记忆物理分开，以后做"自我迭代"也在这块地里长。
import fs from 'node:fs'
import path from 'node:path'
import { dataPath, diaryPath } from './paths.mjs'
import * as memory from './memory.mjs'

const DIR = dataPath('qq')
const PROFILE_FILE = path.join(DIR, 'owner-profile.md')

const safe = (chatId) => String(chatId).replace(/[^a-zA-Z0-9_-]/g, '_')
const summaryFile = (chatId) => path.join(DIR, `summary-${safe(chatId)}.json`)

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.' + process.pid + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n')
  fs.renameSync(tmp, file)
}

/**
 * 最近一段 B站/抖音 的见闻：她刷过什么、在评论里说过什么。
 * 用摘要不用全文，免得把 prompt 撑爆。
 */
export function recentOuter(limit = 4) {
  const rows = []
  for (const platform of ['bilibili', 'douyin']) {
    for (const line of readLines(memory.episodeFile(platform))) {
      try {
        const r = JSON.parse(line)
        if (r.platform !== platform) continue
        if (r.role !== 'assistant' && r.role !== 'event') continue
        const text = String(r.summary || r.text || '').trim()
        if (text) rows.push({ ts: Number(r.ts || 0), platform, text })
      } catch {}
    }
  }
  rows.sort((a, b) => a.ts - b.ts)
  return rows.slice(-limit).map(r => `· （${r.platform === 'bilibili' ? 'B站' : '抖音'}）${r.text.slice(0, 80)}`)
}

function readLines(file) {
  try { return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean) } catch { return [] }
}

/** 日记最后几行 —— 她夜里写下的念头。 */
function diaryTail(lines = 3) {
  for (const book of ['private', 'public']) {
    try {
      const raw = fs.readFileSync(diaryPath(book), 'utf8').trim()
      const tail = raw.split('\n').map(x => x.trim()).filter(x => x && !x.startsWith('#')).slice(-lines)
      if (tail.length) return tail.map(x => `· ${x.slice(0, 80)}`)
    } catch {}
  }
  return []
}

/**
 * 【你最近在外面看到的】—— QQ 人格跟她刷 B站/抖音的经历绑在一起。
 * 不额外调 LLM，纯本地拼装，每条消息都在。
 */
export function worldBlock() {
  const parts = []
  const lore = memory.lore().slice(-3)
  if (lore.length) parts.push('你记住的世界/观念：\n' + lore.map(x => `· ${String(x).slice(0, 80)}`).join('\n'))
  const outer = recentOuter(4)
  if (outer.length) parts.push('你这两天在外面看到的（B站/抖音）：\n' + outer.join('\n'))
  const diary = diaryTail(2)
  if (diary.length) parts.push('你夜里写下的：\n' + diary.join('\n'))
  if (!parts.length) return ''
  return '【你最近在外面看到的】这些是你自己经历来的，聊天时可以自然带出来（别生硬背）：\n' + parts.join('\n')
}

/** 这个会话的滚动摘要（没有就是空串）。 */
export function loadSummary(chatId) {
  return String(readJson(summaryFile(chatId), {})?.summary ?? '')
}

/** 主人画像（跨会话共用一份）。 */
export function loadProfile() {
  try { return fs.readFileSync(PROFILE_FILE, 'utf8').trim() } catch { return '' }
}

function saveProfile(text) {
  fs.mkdirSync(DIR, { recursive: true })
  fs.writeFileSync(PROFILE_FILE, String(text || '').trim() + '\n')
}

/** 记一次"该更新记忆了吗"——每 6 条回复压一次，别每句都花 token。 */
const DEFAULT_EVERY = 6
export function bump(chatId) {
  const file = summaryFile(chatId)
  const st = readJson(file, {})
  st.turns = Number(st.turns || 0) + 1
  writeJson(file, st)
  return st.turns
}

export function due(chatId, every = DEFAULT_EVERY) {
  const st = readJson(summaryFile(chatId), {})
  return Number(st.turns || 0) >= every
}

/**
 * 压缩记忆：把最近一段对话压成摘要，同时更新主人画像。
 * @param {{chatId:string, owner?:object, chat:Function}} o chat = (messages)=>Promise<string>
 */
export async function refresh({ chatId, owner = {}, chat }) {
  const old = readJson(summaryFile(chatId), {})
  const oldSummary = String(old.summary || '')
  const oldProfile = loadProfile()
  const turns = memory.recent(chatId, 24)
  if (turns.length < 4) return false

  const transcript = turns
    .map((m) => `${m.role === 'assistant' ? '她' : '主人'}：${String(m.content).slice(0, 200)}`)
    .join('\n')

  const name = owner.name || ''
  const msgs = [
    {
      role: 'system',
      content: '你在整理"大肥鱼"和主人的聊天记忆。只根据给出的对话写，不要编。输出严格 JSON，两个字段：\n'
        + '{"summary": "最近聊了什么、他的状态和情绪、你答应过什么（不超过 180 字）",'
        + '"profile": "关于主人的稳定事实：怎么称呼他、作息、工作、在意的人和事、最近在烦什么；'
        + '外加你在外面（B站/抖音）养成的一点偏好（不超过 300 字，只写有依据的，别把人设写成另一个人）"}',
    },
    {
      role: 'user',
      content: `【旧摘要】${oldSummary || '（无）'}\n【旧画像】${oldProfile || '（无）'}\n`
        + `【主人称呼】${name || '（未知）'}\n`
        + `【她最近在外面看到的】\n${worldBlock() || '（无）'}\n`
        + `【最近对话】\n${transcript}`,
    },
  ]

  let out = ''
  try {
    out = await chat(msgs)
  } catch {
    return false
  }
  const m = String(out).match(/\{[\s\S]*\}/)
  if (!m) return false
  let parsed
  try { parsed = JSON.parse(m[0]) } catch { return false }

  const summary = String(parsed.summary || '').trim()
  const profile = String(parsed.profile || '').trim()
  if (!summary && !profile) return false

  writeJson(summaryFile(chatId), {
    summary: summary || oldSummary,
    updatedAt: Date.now(),
    turns: 0,
  })
  if (profile) saveProfile(profile)
  return true
}
