// review —— 复盘学习日记：把今天看过的 B站/抖音 聚合起来，让 LLM 写一段"复盘"追加进私人日记。
// 与 report（纯聚合、不调模型）的区别：review 会提炼"学到了什么 / 觉得有意思的点 / 一点情绪"。
// 2026-10-24 起：复盘还会产出一句「对自己的新认识」追加进 persona.md（自我迭代）——
// 只追加、最多留 10 条、带日期，主人随时在面板里删（最终编辑权在主人）。
//
//   node feiyu.mjs review [--days 1]
import fs from 'node:fs'
import path from 'node:path'
import { dataPath, diaryPath, homePath } from '../lib/paths.mjs'
import * as llm from '../lib/llm.mjs'
import { config } from '../lib/config.mjs'

function arg(argv, name, d) { const i = argv.indexOf(name); return i >= 0 ? (argv[i + 1] ?? d) : d }

const SELF_HEADER = '## 她的自我迭代（复盘自动追加，主人可随手删）'

/** 把一句自我认识追加进 persona.md 的自我迭代区（最多留 10 条；区里有手写内容就只追加不动旧文）。 */
function appendSelfNote(date, note) {
  const file = homePath('.feiyu-ai', 'persona.md')
  let text = ''
  try { text = fs.readFileSync(file, 'utf8') } catch {}
  const line = `- [${date}] ${note}`
  if (!text.includes(SELF_HEADER)) {
    fs.mkdirSync(pathOf(file), { recursive: true })
    fs.appendFileSync(file, `\n${SELF_HEADER}\n${line}\n`, 'utf8')
    return
  }
  const idx = text.indexOf(SELF_HEADER)
  const head = text.slice(0, idx)
  const sectionLines = text.slice(idx).split('\n')
  const items = sectionLines.filter((l) => l.trim().startsWith('- ['))
  const other = sectionLines.filter((l) => l.trim() && !l.trim().startsWith('- [') && l.trim() !== SELF_HEADER)
  if (other.length) {
    // 区里被主人手写过别的 —— 不重排，直接在文件尾追加一行
    fs.appendFileSync(file, `${line}\n`, 'utf8')
    return
  }
  items.push(line)
  const kept = items.slice(-10)
  fs.writeFileSync(file, head + [SELF_HEADER, ...kept].join('\n') + '\n', 'utf8')
}

const pathOf = (f) => f.replace(/[\\/][^\\/]+$/, '')

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
    { role: 'system', content: '你是"大肥鱼"，一条爱刷视频的小鲸鱼。只输出 JSON：'
      + '{"review":"80~150字的复盘日记，第一人称口语，写今天看了什么、学到或觉得有意思的点、一点点情绪，不要列表不要总之",'
      + '"selfNote":"一句话（不超过30字）今天对自己的新认识或小改变（比如口味/习惯/判断标准变了），没有就空字符串"}' },
    { role: 'user', content: `今天看过：\n${list}\n\n写复盘：` },
  ]
  let text = ''
  let selfNote = ''
  try {
    const j = await llm.jsonChat(msgs, '{review:string, selfNote:string}', { temperature: 0.8 })
    text = String(j?.review ?? '').trim()
    selfNote = String(j?.selfNote ?? '').trim().slice(0, 40)
  } catch (e) { console.error('[review] LLM 失败：' + e.message); return { text: '', path: diaryPath('private') } }
  if (!text) { console.log('复盘为空，跳过。'); return { text: '', path: diaryPath('private') } }

  const out = diaryPath('private')
  const entry = `\n## ${date} 复盘\n${text}\n`
  fs.mkdirSync(path.dirname(out), { recursive: true })   // 换机/新装时 feiyu-work 可能还不存在
  fs.appendFileSync(out, entry, 'utf8')
  console.log(`[review] 复盘已写进 ${out}`)
  console.log(text)

  // 自我迭代：一句新认识 → persona.md（主人保留最终编辑权，面板里随时删）
  if (selfNote) {
    try {
      appendSelfNote(date, selfNote)
      console.log(`[review] 自我迭代已追加进 persona.md：${selfNote}（你可以在面板里删）`)
    } catch (e) { console.error('[review] 自我迭代写入失败：' + e.message) }
  }

  // 潜水日志动态：复盘本身就是最好的动态素材（bilibili.dynamic.enabled 开了才发，含日额度）
  if (config().bilibili?.dynamic?.enabled === true) {
    try {
      const { postDynamic } = await import('../lib/bili-write.mjs')
      const r = await postDynamic(`【潜水日志】${text}`.slice(0, 500), { go: true })
      console.log(r.ok ? `[review] 潜水日志动态已发 ✓` : `[review] 动态没发成：${r.why}`)
    } catch (e) { console.error('[review] 动态失败：' + e.message) }
  }
  return { text, path: out }
}

if (process.argv[1] && process.argv[1].endsWith('review.mjs')) {
  await run(process.argv.slice(2))
}
