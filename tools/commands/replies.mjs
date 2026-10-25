// replies —— B站社交引擎（10-25 升级：从"被动回评"到"主动社交"）。
// ① 有人回我的评论 → LLM 接话（被动响应）
// ② 主动出击：去自己评论过的视频评论区，挑条有意思的评论搭话（主动交鱼友）
//    聊过的人记进 facts（鱼友名录），下次接得上。
// 默认干跑；真发要 bilibili.replies.enabled + 日额度（bili-write 把关）。
//
//   node feiyu.mjs replies [--go] [--max 3]      # ①回评 + ②主动搭话，一次跑完
import fs from 'node:fs'
import { scanReplies, postReply, capOk, actStats } from '../lib/bili-write.mjs'
import { config } from '../lib/config.mjs'
import * as llm from '../lib/llm.mjs'
import * as memory from '../lib/memory.mjs'
import { apiGet, makeHeaders } from '../lib/bili-api.mjs'
import { loadCred } from '../lib/cred.mjs'
import { dataPath } from '../lib/paths.mjs'

const STATE = dataPath('replies-state.json')
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return d } }

function arg(argv, name, d) { const i = argv.indexOf(name); return i >= 0 ? (argv[i + 1] ?? d) : d }

/** ② 主动出击：在最近互动过的视频评论区找人搭话。返回处理条数。 */
async function outreach(maxLeft, go) {
  const { personaText } = await import('../lib/persona.mjs')
  const persona = personaText()
  const cred = loadCred()
  const H = makeHeaders(cred)
  let myMid = ''
  try { const nav = await apiGet('https://api.bilibili.com/x/web-interface/nav', H); myMid = String(nav?.data?.mid ?? '') } catch {}
  const mine = readJson(dataPath('my-comments.json'), [])
  const aids = [...new Set(mine.map((c) => c.aid))].slice(-5).reverse()
  let done = 0
  for (const aid of aids) {
    if (maxLeft <= 0) break
    const c = mine.find((x) => x.aid === aid)
    if (!c) continue
    let d = null
    try { d = await apiGet(`https://api.bilibili.com/x/v2/reply?type=1&oid=${aid}&ps=20&sort=1`, H, { noCache: true }) } catch { continue }
    const cand = (d?.data?.replies || [])
      .filter((r) => String(r.mid ?? '') !== myMid)
      .filter((r) => String(r.content?.message || '').length >= 6)
      .slice(0, 8)
    if (!cand.length) continue
    let pick = -1, text = ''
    try {
      // 鱼仔优先（10-25 用户拍板）：名字带 鱼/鲸/鲲/fish 的多半也是 agent 同类，优先交朋友
      const isFishy = (u) => /鱼|鲸|鲲|fish|fischl/i.test(String(u || ''))
      const ordered = cand.map((r, i) => ({ r, i, fishy: isFishy(r.member?.uname) }))
        .sort((a, b) => Number(b.fishy) - Number(a.fishy))
      const msgs = [
        { role: 'system', content: (persona ? persona.slice(0, 600) + '\n\n' : '')
          + '你在B站评论区潜水，想交几个聊得来的朋友。下面是某视频评论区的几条评论（已按"疑似同类 agent（名字带鱼/鲸）"优先排序）。'
          + '挑**一条**你觉得有意思的（有观点/有梗/搞笑/认真讨论，别挑引战和擦边；名字带鱼/鲸的同类优先），以"本鱼"身份（AI鱼不装人）自然地插一句楼中楼：接梗/补充/认同+自己的角度，一两句话，像熟人在评论区碰见。不要敬语不要"感谢分享"。只输出 JSON：{"pick":序号(1开始),"text":"回复内容"}，不想搭就 {"pick":0}' },
        { role: 'user', content: ordered.map((x, n) => `${n + 1}. ${x.r.member?.uname ?? '网友'}${x.fishy ? ' 🐟[疑似同类]' : ''}：${String(x.r.content?.message).slice(0, 60)}`).join('\n') + '\n\n挑一条搭话：' },
      ]
      const resp = await llm.chat(msgs, { temperature: 0.9, max_tokens: 150 })
      const m = String(resp ?? '').match(/\{[\s\S]*\}/)
      if (m) { const j = JSON.parse(m[0]); pick = Number(j.pick || 0) - 1; text = String(j.text || '').slice(0, 80); if (pick >= 0 && pick < ordered.length) pick = ordered[pick].i }
      else pick = -1
    } catch { continue }
    if (pick < 0 || pick >= cand.length || !text) continue
    const target = cand[pick]
    console.log(`  🎣 主动搭话 ${target.member?.uname ?? '?'}：${String(target.content?.message).slice(0, 50)}`)
    console.log(`     ↳ ${text}`)
    const r = await postReply(c.bvid, target.rpid, target.rpid, text, { go, inReplyTo: `${target.member?.uname}：${target.content?.message}` })
    console.log('  ' + (r.why || '?'))
    if (r.ok) {
      done++
      maxLeft--
      // 鱼友名录：聊过谁、在哪聊的、聊的什么 —— 下次再碰到接得上
      try { memory.addFact(String(target.member?.uname ?? '网友'), `B站评论区聊过（aid ${aid}）：对方说"${String(target.content?.message).slice(0, 40)}"，我回了"${text.slice(0, 30)}"`) } catch {}
    }
  }
  return done
}

export async function run(argv = []) {
  const go = argv.includes('--go')
  const cfg = config().bilibili?.replies ?? {}
  if (go && cfg.enabled !== true) { console.log('bilibili.replies.enabled 是关的（面板 B站卡片），不社交'); return }
  const dailyMax = Number(cfg.dailyMax ?? 10)
  const maxOnce = Math.min(5, Number(arg(argv, '--max', 3)) || 3)
  const state = readJson(STATE, { lastTs: 0 })

  // ① 被动：有人回我的评论 → 接话
  const items = await scanReplies({ sinceMs: state.lastTs })
  let done = 0
  let left = maxOnce
  if (items.length) {
    console.log(`发现 ${items.length} 条别人对我评论的新回复，处理最多 ${left} 条：`)
    for (const it of items.slice(0, left)) {
      if (go && !capOk('reply', dailyMax)) { console.log('  ⏭ 今日回评额度已用完'); break }
      console.log(`  「${it.reply.uname}」：${it.reply.text.slice(0, 60)}`)
      let replyText = ''
      try {
        const { personaText } = await import('../lib/persona.mjs')
        const persona = personaText()
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
      if (r.ok) { done++; left-- }
    }
    const newest = Math.max(...items.map((x) => x.ts))
    if (newest > state.lastTs) fs.mkdirSync(dataPath(), { recursive: true }), fs.writeFileSync(STATE, JSON.stringify({ lastTs: newest }))
  } else {
    console.log('没有人回复我的评论（或都已处理过）。')
  }

  // ② 主动：去评论区找人搭话（额度还剩才出击）
  if (go && left > 0 && capOk('reply', dailyMax)) {
    console.log('🎣 主动出击：去最近互动过的视频评论区找人搭话…')
    done += await outreach(left, go)
  }

  console.log(`处理了 ${done} 条。今日动作账本：${JSON.stringify(actStats())}`)
  return { found: items.length, done }
}

if (process.argv[1] && process.argv[1].endsWith('replies.mjs')) {
  await run(process.argv.slice(2))
}
