// brain/backfill —— 把旧的 episodes.jsonl 导进脑的情景库（一次性，可重复跑）。
//
// 为什么需要：新脑从今天开始记，评测台/召回在头几天全是空的 —— 而她已经有 1174 条历史。
// 导入只**读**旧文件、只**写** brain/ep 新文件：旧记忆一个字节都不动（回滚就是删 brain/ep）。
// 去重靠 sem/backfilled.json 的行指纹，重复跑不会翻倍。
//
// 微信永远不进（I7）：文件名带 wechat 的直接跳过，platform=wechat 的行也跳过。
import fs from 'node:fs'
import path from 'node:path'
import { dataPath } from '../lib/paths.mjs'
import { appendJsonl, readJsonl, readJson, mutateJson, shortHash, ensureDir } from './json.mjs'
import { epFile, semDir } from './paths.mjs'
import { normalize } from './event.mjs'
import { makeEpisode } from './episode.mjs'
import { bump } from './metrics.mjs'

const SKIP_DIR = /(^|[\\/])(wechat|wx)([\\/]|$)/i
const EP_FILE = /^episodes.*\.jsonl$/i

function collectFiles(root, depth = 0, out = []) {
  let ents = []
  try { ents = fs.readdirSync(root, { withFileTypes: true }) } catch { return out }
  for (const e of ents) {
    const p = path.join(root, e.name)
    if (e.isDirectory()) {
      if (depth >= 2) continue
      if (SKIP_DIR.test(p)) continue
      collectFiles(p, depth + 1, out)
    } else if (EP_FILE.test(e.name) && !SKIP_DIR.test(p)) {
      out.push(p)
    }
  }
  return out
}

const statePath = () => path.join(semDir(), 'backfilled.json')

/** 群聊行的"昵称：正文"前缀拆回 name（旧 memory 把昵称拼进了正文）。 */
function splitGroupPrefix(text) {
  const m = /^([^\s：:]{1,12})[：:]\s*([\s\S]+)$/.exec(String(text || ''))
  return m ? { name: m[1], body: m[2] } : { name: '', body: String(text || '') }
}

/**
 * @returns {{files:number, rows:number, imported:number, skipped:number, wechatSkipped:number}}
 */
export function importLegacy({ limit = 20000, root = null } = {}) {
  const base = root || dataPath('.')
  const files = collectFiles(base)
  const done = new Set((readJson(statePath(), { hashes: [] }).hashes) || [])
  let rows = 0, imported = 0, skipped = 0, wechatSkipped = 0
  ensureDir(semDir())
  for (const f of files) {
    for (const row of readJsonl(f)) {
      if (imported >= limit) break
      rows++
      const plat = String(row?.platform || '').toLowerCase()
      if (plat === 'wechat' || plat === 'wx' || /微信/.test(String(row?.chatId || ''))) { wechatSkipped++; continue }
      const ts = Number(row?.ts || 0)
      const text0 = String(row?.text || row?.summary || '').trim()
      if (!ts || !text0) { skipped++; continue }
      const hash = shortHash(`${ts}|${plat}|${row?.chatId || ''}|${row?.role || ''}|${text0.slice(0, 80)}`, 16)
      if (done.has(hash)) { skipped++; continue }
      const g = row?.isGroup ? splitGroupPrefix(text0) : { name: '', body: text0 }
      const ev = normalize({
        proc: 'backfill', platform: plat || 'qq', chatId: row?.chatId || '', userId: row?.userId || '',
        role: row?.role === 'assistant' ? 'assistant' : 'user',
        text: g.body, isGroup: Boolean(row?.isGroup), name: g.name || undefined, at: ts,
        msgId: `legacy:${hash}`,
      })
      if (!ev.ok) { if (ev.reason === 'wechat-isolated') wechatSkipped++; else skipped++; continue }
      const ep = makeEpisode(ev.event, { recentGists: [], knownNames: [] })
      // 历史行的证据就是它自己的指纹（便于和旧行对齐）
      ep.srcEv = `legacy:${hash}`
      ep.meta = { ...(ep.meta || {}), msgId: `legacy:${hash}`, backfill: true, legacyFile: path.basename(f) }
      if (!appendJsonl(epFile(new Date(ep.at)), ep)) { skipped++; continue }
      done.add(hash)
      imported++
    }
  }
  mutateJson(statePath(), { hashes: [] }, () => ({ hashes: [...done].slice(-40000), at: Date.now() }))
  if (imported) bump('episodesImported', imported)
  return { files: files.length, rows, imported, skipped, wechatSkipped }
}