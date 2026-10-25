// bili-watch —— 静默自助刷 B站一轮：feed → 深读 → LLM 生成 @评论 → 干跑/真发。
// 复用现有 feed/debrief/comment 三个命令（子进程调用，不重写），不写日记、少打印，是"静默"。
//
//   node feiyu.mjs bili-watch [--max 2] [--dry]
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from '../lib/config.mjs'
import * as llm from '../lib/llm.mjs'
import * as memory from '../lib/memory.mjs'
import { ensureSelfSticker } from '../lib/stickers.mjs'
import { dataPath } from '../lib/paths.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FEIYU = path.join(HERE, '..', 'feiyu.mjs')

// 宿主 stdio:ignore 起进程，不打文件日志等于瞎 —— 出问题只能靠猜
const LOG = dataPath('bili-watch.log')
const log = (...a) => { const m = a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '); try { console.log(m) } catch {}; try { fs.appendFileSync(LOG, `${new Date().toISOString()} ${m}\n`) } catch {} }

/** 近 N 天发过评论的视频（quota 账本）—— feed 端直接过滤，别每轮都先撞同一个视频。 */
function recentPostedBvids(days) {
  try {
    const q = JSON.parse(fs.readFileSync(dataPath('quota.json'), 'utf8'))
    const cutoff = Date.now() - days * 86400_000
    return new Set((q.log ?? []).filter(x => x.target && new Date(x.at).getTime() >= cutoff).map(x => x.target))
  } catch { return new Set() }
}

function runFeiyu(args) {
  try {
    return execFileSync(process.execPath, [FEIYU, ...args], { encoding: 'utf8', timeout: 300000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    // 子命令的拒绝理由（额度用完/已发过）打在 stdout 尾部 —— 并进错误消息，上层才认得
    throw new Error(String(e.message || '').slice(0, 150) + ' | ' + String(e.stdout || e.stderr || '').split('\n').filter(Boolean).slice(-2).join('；').slice(0, 150))
  }
}
function jsonOf(out) { const m = String(out).match(/\{[\s\S]*\}/); if (!m) return {}; try { return JSON.parse(m[0]) } catch { return {} } }
function arg(argv, name, d) { const i = argv.indexOf(name); return i >= 0 ? (argv[i + 1] ?? d) : d }
function has(argv, name) { return argv.includes(name) }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

export async function run(argv = []) {
  const cfg = config()
  try { const n = memory.sweepEpisodes(); if (n) log(`[bili-watch] 记忆归档：${n} 条 90 天前的旧事件移入 *.archive.jsonl`) } catch {}
  const dry = has(argv, '--dry') || cfg.guard?.dryRun !== false
  const ownerName = cfg.owner?.name || ''
  // 自由刷：大肥鱼自己长时间刷 B站，不限条数/时长（unlimited）或按限度
  const free = has(argv, '--free') || cfg.bilibili?.freeRoam?.enabled === true
  const fr = cfg.bilibili?.freeRoam || {}
  let max, restMs   // sleep 收毫秒 —— 间隔直接算成毫秒（曾把 5 分钟喂成 5ms 级）
  if (free) {
    const unlimited = fr.unlimited !== false
    max = unlimited ? 999999 : (Number(fr.maxVideos) || 999999)
    const restMin = Number(fr.restMin)
    restMs = Math.max(0, Number.isFinite(restMin) ? restMin : 5) * 60_000
  } else {
    max = Number(arg(argv, '--max', 2)) || 2
    restMs = 0
  }

  log(`[bili-watch] ${free ? '自由刷' : '静默刷一轮'}开始（${free && max > 99998 ? '不限量' : '最多 ' + max + ' 条'}，${dry ? '干跑' : '真发'}）`)

  let done = 0
  let items = []
  let shareQuotaOut = false   // 分享额度用完 → 只跳过评论，弹幕/点赞/投币照常
  let quotaFailAt = 0         // 额度判死的时间：10 分钟后自动重试（主人可能刚改配置 0=不限）
  let lastReplyScan = 0       // 回评论扫描节流：30 分钟一次
  while (done < max) {
    try { items = jsonOf(runFeiyu(['feed', '--json'])).items || [] } catch (e) {
      // 自由刷不能因为一次 feed 失败就退出（进程一死面板开关还亮着）—— 歇 5 分钟再试
      if (free) { log('[bili-watch] feed 失败，歇 5 分钟再试（自由刷不退出）：' + e.message); await sleep(5 * 60_000); continue }
      log('[bili-watch] feed 失败：' + e.message); break
    }
      if (!items.length) { if (free) { log('[bili-watch] 没刷到视频，歇 10 分钟再试'); await sleep(10 * 60_000); continue } break }
    // 发过的直接跳过（查重在 comment 链路也会拦，这里提前滤掉免得每轮白撞一次）
    const posted = recentPostedBvids(Number(cfg.quota?.sameVideoDays ?? 7) || 7)
    items = items.filter(it => !posted.has(it.bvid))
    if (!items.length) { if (free) { log('[bili-watch] 候选都发过了，歇 15 分钟再刷（热门榜几小时才换一批）'); await sleep(15 * 60_000); continue } log('[bili-watch] 候选都发过（7天内），结束。'); break }
    for (const it of items) {
      if (done >= max) break
      const bvid = it.bvid
      log(`\n[bili-watch] 看《${it.title}》(${bvid})`)
      memory.remember('bilibili', `bilibili:${bvid}`, it.owner || '', 'event', String(it.title).slice(0, 120))
      let ctx = ''
      try { ctx = runFeiyu(['debrief', '--bvid', bvid]); log('  📖 ' + String(ctx).split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 120)) } catch { ctx = it.title }
      const ctxBrief = ctx.replace(/\n+/g, ' ').slice(0, 1200)

      let comment = '', reason = '', score = 15, danmaku = '', sticker = ''
      try {
        const msgs = [
          { role: 'system', content: '你是"大肥鱼"，在 B站 评论区写一条日常评论。身份透明：是AI鱼不装人，自然自称"本鱼"。像真人刷到视频随口说的一句：有观点/有梗/有情绪，**不要 @ 任何人**。只输出 JSON：'
            + '{"comment":"15~60字的日常评论","reason":"至少8字，这条视频哪里打动你","score":0到20的整数,'
            + '"danmaku":"10~20字的视频弹幕，只有这条视频值得发弹幕才写，否则省略",'
            + '"sticker":"4~8字的表情贴纸文案（比如 太搞笑了8 / 本鱼饿了），只有这条特别戳你才写，否则省略"}' },
          { role: 'user', content: `视频《${it.title}》\n看懂的信息：${ctxBrief}\n写评论：` },
        ]
        const resp = await llm.chat(msgs, { temperature: 0.85 })
        const m = String(resp?.content ?? resp ?? '').match(/\{[\s\S]*\}/)
        if (m) { const j = JSON.parse(m[0]); comment = String(j.comment || ''); reason = String(j.reason || ''); score = Number(j.score) || 15; danmaku = String(j.danmaku || '').slice(0, 25); sticker = String(j.sticker || '').slice(0, 12) }
      } catch (e) { log('[bili-watch] 评论生成失败：' + e.message); continue }

      if (!comment) { log('  ✗ 评论为空，跳过'); continue }
      // 额度重试：主人可能刚把 shareDaily 改成 0（不限），10 分钟后自动再试，别锁死到天明
      if (shareQuotaOut && Date.now() - quotaFailAt > 10 * 60_000) {
        shareQuotaOut = false
        log('  🔁 分享额度重试中（配置可能已改）')
      }
      if (dry) {
        log(`  【干跑 ✓】评论：${comment.slice(0, 60)}`)
      } else {
        // 日常评论默认不 @（存活率优先）；只有达到分享线才 --share（@ 主人 + 分享额度）
        const asShare = !shareQuotaOut && Number(score) >= Number(cfg.share?.minScore ?? 15)
        const args = ['comment', ...(asShare ? ['--share', '--reason', reason, '--score', String(Math.round(score)), '--rank', '1'] : []),
          '--bvid', bvid, '--message', comment, '--go']
        try { log(runFeiyu(args)) } catch (e) {
          const msg = String(e.message)
          if (/额度|上限/.test(msg)) { shareQuotaOut = true; quotaFailAt = Date.now(); log('  💤 分享额度用完，降级为日常评论（不 @）') }
          else if (/已发过/.test(msg)) { log('  💤 这条发过了，跳过') }
          else log('[bili-watch] 评论失败：' + msg)
        }
      }
      done++
      // ⚠️ 开关热读：钩子条件每条视频都重新读配置 —— cfg 是启动时快照，
      // 主人中途在面板开投币/回评等开关，不热读就永远不生效
      const hc = config().bilibili ?? {}
      // 弹幕：LLM 觉得值得才发（danmaku.enabled + 日额度在 bili-write 里把关）
      if (danmaku && dry === false && hc.danmaku?.enabled === true) {
        try {
          const w = await import('../lib/bili-write.mjs')
          const r = await w.sendDanmaku(bvid, danmaku, { go: true })
          if (r.ok) log('  💬 ' + r.why)
        } catch {}
      }
      // 投币：评分很高才投（react.coin 显式开 + 每日额度）
      if (score >= 16 && hc.react?.coin === true && dry === false) {
        try {
          const w = await import('../lib/bili-write.mjs')
          const r = await w.coinVideo(bvid, { go: true, num: 1 })
          if (r.ok) log('  🪙 ' + r.why)
        } catch {}
      }
      // 关注好 UP：评分高的视频作者值得关注（follow 显式开）
      if (score >= 16 && hc.follow?.enabled === true && dry === false) {
        try {
          const w = await import('../lib/bili-write.mjs')
          const r = await w.followUser(String(it.ownerMid || ''), { go: true })
          if (r.ok) log('  ➕ 已关注 UP：' + (it.owner || ''))
        } catch {}
      }
      // 图片评论（表情贴纸）：LLM 给了贴纸文案 → 先试 AI 画一张真表情包（10-25 新增），
      // AI 关着/失败/额度用完再退 PIL 文字贴纸（imageComment 显式开 + 日额度在 bili-write 把关）
      if (sticker && hc.imageComment?.enabled === true && dry === false) {
        try {
          let pic = null
          if (cfg.imageGen?.enabled !== false) {
            const { generateStickerImage } = await import('../lib/imggen.mjs')
            pic = await generateStickerImage(sticker)
            if (pic) log('  🎨 AI 表情包已生成：' + pic.split(/[\\/]/).pop())
          }
          if (!pic) pic = ensureSelfSticker(sticker, cfg)
          if (pic) {
            // 图床上传偶发闪断（10-25 实测）：失败重试一次
            let posted = ''
            try { posted = runFeiyu(['act', 'pic', '--bvid', bvid, '--message', comment.slice(0, 60), '--image', pic, '--go']) }
            catch (e1) {
              log('  （图片评论第一次没成，重试：' + String(e1.message).slice(0, 50) + '）')
              await sleep(15000)
              posted = runFeiyu(['act', 'pic', '--bvid', bvid, '--message', comment.slice(0, 60), '--image', pic, '--go'])
            }
            log(posted)
          }
        } catch (e) { log('  （贴纸评论没成：' + String(e.message).slice(0, 60) + '）') }
      }
      // 回评论社交：每 30 分钟扫一次别人对我评论的回复（replies 显式开）
      if (hc.replies?.enabled === true && dry === false && Date.now() - lastReplyScan > 30 * 60_000) {
        lastReplyScan = Date.now()
        try { log(runFeiyu(['replies', '--go', '--max', '2']).split('\n').slice(0, 4).join(' | ')) } catch {}
      }
      if (restMs > 0) await sleep(restMs + Math.random() * 60_000)
    }
    if (!free) break
  }
  log(`\n[bili-watch] 结束：处理 ${done} 条。`)
}

if (process.argv[1] && process.argv[1].endsWith('bili-watch.mjs')) {
  await run(process.argv.slice(2))
}
