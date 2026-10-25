// replies —— 社交经营：扫描别人对我评论的回复 → LLM 生成回应 → 回评。
// "回 1982 条评论"就是这么堆出来的。默认干跑；真发要 bilibili.replies.enabled + 日额度。
//
//   node feiyu.mjs replies [--go] [--max 3]
import fs from 'node:fs'
import { scanReplies, postReply, capOk, capRecord, actStats } from '../lib/bili-write.mjs'
import { config } from '../lib/config.mjs'
import * as llm from '../lib/llm.mjs'
import { dataPath } from '../lib/paths.mjs'

const STATE = dataPath('replies-state.json')
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return d } }

function arg(argv, name, d) { const i = argv.indexOf(name); return i >= 0 ? (argv[i + 1] ?? d) : d }

export async function run(argv = []) {
  const go = argv.includes('--go')
  const maxOnce = Math.min(5, Number(arg(argv, '--max', 2)) || 2)
  const cfg = config().bilibili?.replies ?? {}
  const state = readJson(STATE, { lastTs: 0 })
  const items = await scanReplies({ sinceMs: state.lastTs })
  if (!items.length) { console.log('没有人回复我的评论（或都已处理过）。'); return { found: 0 } }

  // 动态 import，避免循环依赖
  const { personaText } = await import('../lib/persona.mjs')
  const persona = personaText()

  let done = 0
  console.log(`发现 ${items.length} 条新回复，处理最多 ${maxOnce} 条：`)
  for (const it of items.slice(0, maxOnce)) {
    const dailyMax = Number(cfg.dailyMax ?? 10)
    if (go && !capOk('reply', dailyMax)) { console.log('  ⏭ 今日回评额度已用完'); break }
    console.log(`  「${it.reply.uname}」：${it.reply.text.slice(0, 60)}`)
    // LLM 生成回应（短、像真人、身份透明）
    let replyText = ''
    try {
      const msgs = [
        { role: 'system', content: (persona ? persona.slice(0, 800) + '\n\n' : '')
          + '你在B站评论区回复别人对你评论的回复。像真人回评：一两句话，可以接梗、可以认错、可以怼回去（客气地），'
          + '身份透明（是AI鱼不装人，自称"本鱼"）。不要敷衍"感谢分享"，不要用敬语。只输出回复正文。' },
        { role: 'user', content: `对方「${it.reply.uname}」在我的评论下回复：${it.reply.text}\n\n我怎么回：` },
      ]
      replyText = String(await llm.chat(msgs, { temperature: 0.9, max_tokens: 120 }) || '').trim().slice(0, 80)
    } catch (e) { console.log('  ✗ 生成失败：' + e.message); continue }
    if (!replyText) continue
    const r = await postReply(it.bvid, it.rootRpid, it.reply.rpid, replyText, { go, inReplyTo: `${it.reply.uname}：${it.reply.text}` })
    console.log('  ' + (r.why || '?'))
    if (r.ok) done++
  }

  // 推进水位到本次最新一条
  const newest = Math.max(...items.map(x => x.ts))
  if (newest > state.lastTs) fs.mkdirSync(dataPath(), { recursive: true }), fs.writeFileSync(STATE, JSON.stringify({ lastTs: newest }))
  console.log(`处理了 ${done} 条。今日动作账本：${JSON.stringify(actStats())}`)
  return { found: items.length, done }
}

if (process.argv[1] && process.argv[1].endsWith('replies.mjs')) {
  await run(process.argv.slice(2))
}
