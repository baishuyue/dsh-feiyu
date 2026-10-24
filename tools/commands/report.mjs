// report —— 观看日报：把今天（或 N 天）真实看过的 B站/抖音 汇总成 Markdown。
// 纯数据聚合，不调模型（参考 dsh-douyin-agent 的"日报不调用模型"做法）。
//
//   node feiyu.mjs report [--days 1] [--out <path>]
import fs from 'node:fs'
import path from 'node:path'
import { dataPath } from '../lib/paths.mjs'

const EP = dataPath('episodes.jsonl')

export async function run(argv = []) {
  const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] ?? d) : d }
  const days = Number(arg('--days', 1)) || 1
  const since = Date.now() - days * 86400_000

  const rows = []
  try {
    const lines = fs.readFileSync(EP, 'utf8').trim().split('\n').filter(Boolean)
    for (const line of lines) {
      try {
        const r = JSON.parse(line)
        if ((r.platform === 'bilibili' || r.platform === 'douyin') && Number(r.ts ?? 0) >= since) rows.push(r)
      } catch {}
    }
  } catch {}

  const by = { bilibili: [], douyin: [] }
  for (const r of rows) {
    const id = String(r.chatId || '').split(':').pop() || ''
    const title = String(r.summary || r.text || '').trim()
    if (!title) continue
    by[r.platform].push({ id, title, author: String(r.userId || ''), ts: r.ts })
  }

  const date = new Date().toLocaleDateString('sv-SE')
  const sec = (id) => String(id).replace(/[^\w-]/g, '')
  const out = []
  out.push(`# 大肥鱼 · 观看日报 ${date}`)
  out.push('')

  if (!rows.length) {
    out.push('今天还没刷 B站/抖音，或者还没记下来。')
  }

  for (const [platform, label, urlOf] of [
    ['douyin', '抖音', (id) => `https://www.douyin.com/video/${sec(id)}`],
    ['bilibili', 'B站', (id) => `https://www.bilibili.com/video/${sec(id)}`],
  ]) {
    const list = by[platform]
    if (!list.length) continue
    out.push(`## ${label}（${list.length}）`)
    for (const it of list) {
      const time = new Date(it.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
      out.push(`- ${time} · ${it.title}${it.author ? ' · ' + it.author : ''} · [链接](${urlOf(it.id)})`)
    }
    out.push('')
  }

  const md = out.join('\n')
  const outPath = arg('--out', dataPath('reports', `观看日报-${date}.md`))
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, md + '\n', 'utf8')
  console.log(outPath)
  return { path: outPath, markdown: md, count: rows.length }
}

if (process.argv[1] && process.argv[1].endsWith('report.mjs')) {
  await run(process.argv.slice(2))
}
