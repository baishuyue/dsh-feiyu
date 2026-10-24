// review —— 复盘学习日记：把今天看过的 B站/抖音 聚合起来，让 LLM 写一段"复盘"追加进私人日记。
// 与 report（纯聚合、不调模型）的区别：review 会提炼"学到了什么 / 觉得有意思的点 / 一点情绪"。
//
//   node feiyu.mjs review [--days 1]
import fs from 'node:fs'
import { dataPath, diaryPath } from '../lib/paths.mjs'
import * as llm from '../lib/llm.mjs'

function arg(argv, name, d) { const i = argv.indexOf(name); return i >= 0 ? (argv[i + 1] ?? d) : d }

export async function run(argv = []) {
  const days = Number(arg(argv, '--days', 1)) || 1
  const since = Date.now() - days * 86400_000
  const items = []
  try {
    const lines = fs.readFileSync(dataPath('episodes.jsonl'), 'utf8').trim().split('\n').filter(Boolean)
    for (const line of lines) {
      try {
        const r = JSON.parse(line)
        if ((r.platform === 'bilibili' || r.platform === 'douyin') && Number(r.ts ?? 0) >= since) {
          const t = String(r.summary || r.text || '').trim()
          if (t) items.push({ platform: r.platform, title: t.slice(0, 60), author: r.userId || '' })
        }
      } catch {}
    }
  } catch {}

  const date = new Date().toLocaleDateString('sv-SE')
  if (!items.length) { console.log('今天还没看什么，没东西可复盘。'); return { text: '', path: diaryPath('private') } }

  const list = items.map(it => `·（${it.platform === 'bilibili' ? 'B站' : '抖音'}）${it.title}`).join('\n')
  const msgs = [
    { role: 'system', content: '你是"大肥鱼"，一条爱刷视频的小鲸鱼。写一段 80~150 字的复盘日记，第一人称，'
      + '写今天看了什么、学到或觉得有意思的点、一点点情绪。口语、真实，不要列表，不要"总之"。' },
    { role: 'user', content: `今天看过：\n${list}\n\n写复盘：` },
  ]
  let text = ''
  try {
    const resp = await llm.chat(msgs, { temperature: 0.8 })
    text = String(resp?.content ?? resp ?? '').trim()
  } catch (e) { console.error('[review] LLM 失败：' + e.message); return { text: '', path: diaryPath('private') } }
  if (!text) { console.log('复盘为空，跳过。'); return { text: '', path: diaryPath('private') } }

  const out = diaryPath('private')
  const entry = `\n## ${date} 复盘\n${text}\n`
  fs.appendFileSync(out, entry, 'utf8')
  console.log(`[review] 复盘已写进 ${out}`)
  console.log(text)
  return { text, path: out }
}

if (process.argv[1] && process.argv[1].endsWith('review.mjs')) {
  await run(process.argv.slice(2))
}
