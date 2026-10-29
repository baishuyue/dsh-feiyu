// brain/paths —— 脑的目录布局（v3 设计 §3）。
//
// 一个原则：**旧文件一个都不动**（episodes.jsonl / facts.json / lore.json / promises.json
// 一律只读冻结），新结构在 brain/ 下并行长；迁移靠脚本单向搬运，随时能对着旧文件核对。
import path from 'node:path'
import { dataPath } from '../lib/paths.mjs'

/** 脑根目录：~/.feiyu-ai/brain */
export const BRAIN = () => dataPath('brain')

export const epDir = () => path.join(BRAIN(), 'ep')
export const inboxDir = () => path.join(BRAIN(), 'inbox')
export const semDir = () => path.join(BRAIN(), 'sem')
export const intentDir = () => path.join(BRAIN(), 'intent')
export const selfDir = () => path.join(BRAIN(), 'self')
export const affectDir = () => path.join(BRAIN(), 'affect')
export const logDir = () => path.join(BRAIN(), 'log')
export const workDir = () => path.join(BRAIN(), 'working')
// 身体/工具协议单独一个目录：别和 working/<chat>.json 混在一起（tasks.json 会被当成一个"chat"）
export const taskDir = () => path.join(BRAIN(), 'task')
export const metaDir = () => path.join(BRAIN(), 'meta')
export const consDir = () => path.join(BRAIN(), 'consolidation')
export const indexPath = () => path.join(BRAIN(), 'index')

/** 情景分片：brain/ep/2026-10.jsonl（按月，只追加）。 */
export const epFile = (date = new Date()) => {
  const d = date instanceof Date ? date : new Date(date)
  const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  return path.join(epDir(), `${ym}.jsonl`)
}

/** 事件分片：每个写者一个文件（单写者 = 每个文件只有一个进程写）。 */
export const inboxFile = (proc, date = new Date()) => {
  const d = date instanceof Date ? date : new Date(date)
  const day = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
  return path.join(inboxDir(), `${String(proc || 'misc').replace(/[^\w.-]/g, '_')}-${day}.jsonl`)
}

export const inboxCursor = (file) => {
  const base = path.basename(String(file)).replace(/\.jsonl$/i, "")
  return path.join(inboxDir(), `.cursor-${base}.json`)
}

export const factsPath = () => path.join(semDir(), 'facts.json')
export const loreClassPath = () => path.join(semDir(), 'lore-classified.json')
export const entitiesPath = () => path.join(semDir(), 'entities.json')
export const intentsPath = () => path.join(intentDir(), 'intents.json')
export const journalPath = () => path.join(intentDir(), 'journal.jsonl')
export const selfPath = () => path.join(selfDir(), 'me.md')
export const selfMetaPath = () => path.join(selfDir(), 'meta.json')
export const selfHistoryDir = () => path.join(selfDir(), 'history')
export const debtsPath = () => path.join(selfDir(), 'debts.json')
export const winsPath = () => path.join(selfDir(), 'wins.json')
export const affectPath = () => path.join(affectDir(), 'mood.json')
export const deliveryPath = () => path.join(logDir(), 'delivery.jsonl')
export const claimsPath = () => path.join(logDir(), 'claims.jsonl')
export const recallsPath = () => path.join(logDir(), 'recalls.jsonl')
export const attentionPath = () => path.join(metaDir(), 'attention.json')
export const genPath = () => path.join(metaDir(), 'gen.json')
export const lockPath = (name) => path.join(metaDir(), 'lock-' + String(name).replace(/[^\w.-]/g, '_') + '.lock')
export const metricsPath = () => path.join(metaDir(), 'metrics.json')
export const consolidateCursorPath = () => path.join(consDir(), 'cursor.json')
export const diaryPath = (date = new Date()) => {
  const d = date instanceof Date ? date : new Date(date)
  return path.join(consDir(), `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.md`)
}
export const workingPath = (chatId) => path.join(workDir(), String(chatId || 'misc').replace(/[^\w.-]/g, '_') + '.json')