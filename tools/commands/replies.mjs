// replies —— B站社交引擎。
// ⓪ 自己投稿的评论区：别人的评论（**任何类型**：文字 / 只有表情 / 图片评论）→ LLM 接话（10-27 新增）
// ① 有人回我的评论 → LLM 接话（被动响应）
// ② 主动出击：去自己评论过的视频评论区，挑条有意思的评论搭话（主动交鱼友）
//    聊过的人记进 facts（鱼友名录），下次接得上。
// 默认干跑；真发要 bilibili.replies.enabled + 日额度（bili-write 把关）。
//
//   node feiyu.mjs replies [--go] [--max 3]      # ⓪①② 一次跑完
//   node feiyu.mjs replies --own-only            # 只回自己作品下面的评论
import fs from 'node:fs'
import { scanReplies, postReply, capOk, actStats, listOwnVideos, listCommentsOf } from '../lib/bili-write.mjs'
import { config } from '../lib/config.mjs'
import * as llm from '../lib/llm.mjs'
import * as memory from '../lib/memory.mjs'
import { classifyComment, replyable, stickerFallback } from '../lib/comment-kind.mjs'
import { chooseKind, decorateText, pickCommentImage, describeKind } from '../lib/reply-style.mjs'
import { apiGet, makeHeaders } from '../lib/bili-api.mjs'
import { loadCred } from '../lib/cred.mjs'
import { dataPath } from '../lib/paths.mjs'

const STATE = dataPath('replies-state.json')
const OWN_STATE = dataPath('bili-own-engage.json')
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return d } }
let lastPickedImage = ''   // 本轮挑中的表情包/图片（postReply 要用它当 pictures）

/** 把一句回复按配置概率"上色"：文字（可能加 emoji/颜文字）/ 表情包图 / 图片。返回最终文案与图。 */
function styleReply(text, { platform = 'bilibili' } = {}) {
  const styles = config().comment?.styles || {}
  const kind = styles.auto === false ? 'text' : chooseKind({ platform, styles })
  lastPickedImage = ''
  if (kind === 'sticker' || kind === 'image') {
    lastPickedImage = pickCommentImage({ platform })
    if (!lastPickedImage) return { kind: 'text', line: decorateText(text, styles) }   // 没素材就老实发文字
  }
  return {
    kind,
    line: decorateText(text, {
      emojiChance: Number(styles.emoji ?? 0.15),
      kaomojiChance: Number(styles.kaomoji ?? 0.15),
    }),
  }
}

function arg(argv, name, d) { const i = argv.indexOf(name); return i >= 0 ? (argv[i + 1] ?? d) : d }

/**
 * ⓪ 自己投稿下面别人发的评论 → 回。
 *
 * 10-27 主人报的：抖音那边她只回了他的文字评论，别人发的**表情包**一条没回（纯贴纸评论 text 是空串，
 * 被 `if (!c.text)` 丢了）；B站 这边压根没有"自己作品评论区"这条路。两边现在统一走
 * comment-kind 判类型：文字 / 只有表情 / 图片评论 都算评论，都要有反应。
 * 真好几句回不上（LLM 憋不出话）时用轮换的兜底话术，不让任何一条评论石沉大海。
 */
async function ownWorks(maxLeft, go, log = console.log) {
  const wm = readJson(OWN_STATE, { seen: [] })
  if (!Array.isArray(wm.seen)) wm.seen = []
  if (!wm.repliedTo || typeof wm.repliedTo !== 'object') wm.repliedTo = {}
  const save = () => { try { fs.mkdirSync(dataPath(), { recursive: true }); fs.writeFileSync(OWN_STATE, JSON.stringify(wm)) } catch {} }
  let videos = []
  try { videos = await listOwnVideos({ ps: 10 }) } catch (e) { log('  ✗ 读不到自己的投稿：' + String(e.message).slice(0, 90)); return 0 }
  if (!videos.length) { log('  自己还没有投稿，评论区空着（投稿之后这条路径才有意义）'); return 0 }
  log(`  自己的投稿 ${videos.length} 个：${videos.slice(0, 3).map((v) => String(v.title).slice(0, 10)).join(' / ')}`)
  const cred = loadCred()
  let myMid = ''
  try { const nav = await apiGet('https://api.bilibili.com/x/web-interface/nav', makeHeaders(cred)); myMid = String(nav?.data?.mid ?? '') } catch {}
  const news = []
  for (const v of videos.slice(0, 5)) {
    let rows = []
    try { rows = await listCommentsOf(v.aid, { ps: 20, bvid: v.bvid, upMid: myMid }) } catch { continue }
    const mineReplied = new Set(rows.filter((r) => r.isUp || (myMid && r.mid === myMid)).map((r) => String(r.rootRpid)))
    for (const r of rows) {
      if (myMid && r.mid === myMid) continue                    // 我自己说的话不是待办
      if (!replyable(r.kind)) continue                          // 真空评论（只剩贴纸/被折叠）
      if (!r.parentRpid || r.parentRpid === '0') {              // 一级评论：这串我已经答过就别重复答
        if (mineReplied.has(String(r.rpid))) continue
      }
      const key = `${v.bvid}:${r.rpid}`
      if (wm.seen.includes(key)) continue
      if (!r.parentRpid || r.parentRpid === '0') {
        // 自己记的台账：这条我回过了（B站 的楼中楼结构清楚，但失败回滚时靠它兜）
        if (wm.repliedTo[r.rpid]) continue
      }
      news.push({ ...r, vtitle: v.title, key, vid: v.bvid })
      wm.seen.push(key)
    }
  }
  wm.seen = wm.seen.slice(-800)
  if (!news.length) { log('  自己作品下面没有新评论。'); return 0 }
  log(`  自己作品下的新评论 ${news.length} 条：`)
  for (const n of news.slice(0, 12)) {
    const tag = n.kind === 'text' ? '' : ` 〔${n.kind === 'image' ? '图片评论' : n.kind === 'emote' ? '只有表情' : n.kind}〕`
    log(`    · ${n.uname}：${String(n.label || n.text).slice(0, 40)}${tag}`)
  }
  const { personaText } = await import('../lib/persona.mjs')
  const persona = personaText()
  let planned = new Map()
  try {
    const msgs = [
      { role: 'system', content: (persona ? persona.slice(0, 800) + '\n\n' : '')
        + '这是**你自己投稿**的B站视频评论区。以 UP 主 + "本鱼"的身份回评论：短、自然、有态度，别客服腔、别用敬语、别说"感谢支持"。'
        + '\n**评论不只有文字**：写着「（发了 N 张图…）」「（只有 [大笑] 这种表情）」的，是对方用图/表情跟你说话 —— '
        + '这种照样要回，顺着表情或图接一句就好，别问"你想说什么"。杠精和广告可以不接。'
        + `\n最多挑 ${maxLeft} 条。只输出 JSON：{"replies":[{"index":序号,"text":"回复内容"}]}，都不想接就 {"replies":[]}` },
      { role: 'user', content: news.slice(0, 12).map((n, i) => `${i + 1}. [${String(n.vtitle).slice(0, 12)}] ${n.uname}：${String(n.label || n.text).slice(0, 50)}`).join('\n') },
    ]
    const resp = await llm.chat(msgs, { temperature: 0.9, max_tokens: 400 })
    const m = String(resp ?? '').match(/\{[\s\S]*\}/)
    if (m) for (const r of (JSON.parse(m[0]).replies || [])) {
      const n = news[Number(r.index) - 1]
      const t = String(r.text || '').trim().slice(0, 90)
      if (n && t) planned.set(Number(r.index) - 1, t)
    }
  } catch (e) { log('  LLM 决策失败：' + String(e.message).slice(0, 80)) }
  // 表情/图片评论 LLM 没挑也要回（兜底话术），文字评论交给她自己判断
  for (const [i, n] of news.entries()) {
    if (planned.has(i) || n.kind === 'text') continue
    planned.set(i, stickerFallback(n.label, i))
  }
  let done = 0
  for (const idx of [...planned.keys()].sort((a, b) => a - b).slice(0, maxLeft)) {
    const n = news[idx]
    let text = planned.get(idx)
    if (!text) continue
    // 10-27：回复类型不止文字 —— 按配置概率挑「文字（可带 emoji/颜文字）/ 表情包图 / 图片」。
    // 带图回复要 `bilibili.replies.image: true`（图片先传图床，再走 pictures 参数）。
    const { kind, line } = styleReply(text, { platform: 'bilibili' })
    text = line
    log(`  ↩ 回 ${n.uname}（${n.kind}）：${text}${kind !== 'text' ? ` 〔${kind}〕` : ''}`)
    const r = await postReply(n.bvid, n.rootRpid, n.rpid, text, { go, inReplyTo: `${n.uname}：${n.label || n.text}`, aid: n.aid, title: n.vtitle, image: kind === 'image' || kind === 'sticker' ? lastPickedImage : '' })
    log('  ' + (r.why || '?'))
    if (r.ok) {
      done++
      wm.repliedTo[n.rpid] = Date.now()
      if (go) save()
      try { memory.addFact(n.uname || '网友', `B站 我自己的作品《${String(n.vtitle).slice(0, 20)}》评论区：对方说"${String(n.label || n.text).slice(0, 40)}"，我回了"${text.slice(0, 30)}"`) } catch {}
    } else if (go) {
      // 失败必须把水位退回去：不然这条评论永远不再尝试（人家就一直等不到回复）
      wm.seen = wm.seen.filter((k) => k !== n.key)
      save()
    }
  }
  if (!go) { log('  （干跑：水位不写，真跑时才落盘）'); return done }
  save()
  return done
}

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
    // 10-27：主动搭话也能带表情包/图片（同样按配置概率），不再只有文字
    const styled = styleReply(String(text), { platform: 'bilibili' })
    const outText = styled.line
    console.log(`  🎣 主动搭话 ${target.member?.uname ?? '?'}：${String(target.content?.message).slice(0, 50)}`)
    console.log(`     ↳ ${outText}${styled.kind !== 'text' ? ` 〔${describeKind(styled.kind)}〕` : ''}`)
    const r = await postReply(c.bvid, target.rpid, target.rpid, outText, { go, inReplyTo: `${target.member?.uname}：${target.content?.message}`, image: styled.kind === 'sticker' || styled.kind === 'image' ? lastPickedImage : '' })
    console.log('  ' + (r.why || '?'))
    if (r.ok) {
      done++
      maxLeft--
      // 鱼友名录：聊过谁、在哪聊的、聊的什么 —— 下次再碰到接得上
      try { memory.addFact(String(target.member?.uname ?? '网友'), `B站评论区聊过（aid ${aid}）：对方说"${String(target.content?.message).slice(0, 40)}"，我回了"${outText.slice(0, 30)}"`) } catch {}
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
  const ownOnly = argv.includes('--own-only')
  let done = 0

  // ⓪ 自己投稿的评论区（10-27 新增）：别人的评论，任何类型都回
  if (cfg.ownWorks !== false) {
    console.log('🐟 自己作品评论区：')
    // --max 是这个"轮次"的总预算：先回自己作品下面的，剩下的留给 ①②
    const ownBudget = Math.max(1, Math.min(maxOnce, Number(cfg.ownMax ?? 5) || 5))
    done += await ownWorks(ownBudget, go)
    if (ownOnly) { console.log(`处理了 ${done} 条。今日动作账本：${JSON.stringify(actStats())}`); return { own: done, done } }
  }

  // ① 被动：有人回我的评论 → 接话。排序：主人的回复永远最优先，疑似同类 agent 其次（10-25 用户拍板）
  const items = await scanReplies({ sinceMs: state.lastTs })
  let left = maxOnce
  if (items.length) {
    const isFishy = (u) => /鱼|鲸|鲲|fish/i.test(String(u || ''))
    items.sort((a, b) => {
      const rank = (x) => (String(x.reply.uname) && x.reply.uname === config().owner?.name ? 0 : isFishy(x.reply.uname) ? 1 : 2)
      return rank(a) - rank(b)
    })
    console.log(`发现 ${items.length} 条别人对我评论的新回复（主人优先），处理最多 ${left} 条：`)
    for (const it of items.slice(0, left)) {
      const ownerReply = String(it.reply.uname) === String(config().owner?.name || '')
      if (go && !ownerReply && !capOk('reply', dailyMax)) { console.log('  ⏭ 今日回评额度已用完（主人的回复不受限）'); break }
      if (ownerReply) console.log('  👑 主人的回复——优先处理、免额度')
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
      // 10-27：被动回评也能换成表情包/图片（同一套概率）
      const styled = styleReply(replyText, { platform: 'bilibili' })
      replyText = styled.line
      const r = await postReply(it.bvid, it.rootRpid, it.reply.rpid, replyText, { go, inReplyTo: `${it.reply.uname}：${it.reply.text}`, image: styled.kind === 'sticker' || styled.kind === 'image' ? lastPickedImage : '' })
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
