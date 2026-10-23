// douyin —— 抖音互动（刷视频 / 读评论 / 发评论@），Playwright 浏览器自动化。
// 个人号没有公开 API，只能靠 patchright + 本地 Chrome 模拟人操作 douyin.com。
// 底层脚本：D:\social-auto-upload\douyin_interact.py（login/feed/comments/comment 四个子命令）。
//
//   node feiyu.mjs douyin login                        # 扫码登录一次（cookie 存 ~/.feiyu-ai）
//   node feiyu.mjs douyin feed                         # 刷 feed 采集视频（JSON）
//   node feiyu.mjs douyin comments --vid <id>          # 读某视频热评
//   node feiyu.mjs douyin comment --vid <id> --message "…" [--go]   # 发评论（默认干跑）
//   node feiyu.mjs douyin interact                     # 全流程：feed→选题→LLM评论→发（DRY）
//
// 风控铁律：评论默认 DRY（只打印不真发），interact 全程 DRY；确认选题准了再手动 --go。
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { config } from '../lib/config.mjs'
import { toPlain } from '../lib/stickers.mjs'

function arg(argv, name) {
  const i = argv.indexOf(name)
  return i >= 0 ? String(argv[i + 1] ?? '') : ''
}

function pyPath(cfg) {
  return cfg.douyin?.python || 'D:/social-auto-upload/.venv/Scripts/python.exe'
}
function scriptPath(cfg) {
  return cfg.douyin?.script || 'D:/social-auto-upload/douyin_interact.py'
}
function cookiePath(cfg) {
  return cfg.douyin?.cookie || path.join(os.homedir(), '.feiyu-ai', 'douyin-cookies.json')
}

// 抖音独立 dryRun（默认开）：不跟随全局 guard.dryRun，抖音要单独确认后才真发
function douyinDry(cfg) {
  return cfg.douyin?.dryRun !== false
}

function runPy(argv, cfg) {
  const cmd = [scriptPath(cfg), ...argv, '--cookie', cookiePath(cfg)]
  try {
    return execFileSync(pyPath(cfg), cmd, { encoding: 'utf8', timeout: 300000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    const err = String(e.stderr ?? e.message).slice(0, 500)
    console.error(`✗ 抖音脚本失败：${err}`)
    process.exit(1)
  }
}

function parseFeedJson(out) {
  // feed 输出里混着日志行，抽最后一个 { ... } JSON
  const m = out.match(/\{[\s\S]*\}/)
  if (!m) return { videos: [] }
  try { return JSON.parse(m[0]) } catch { return { videos: [] } }
}

// 口味过滤（仿 B站 feed：标题/文案命中偏好）
function matchPrefs(v, cfg) {
  const like = cfg.preferences?.like || []
  const dislike = cfg.preferences?.dislike || []
  const hay = (v.desc + ' ' + v.author).toLowerCase()
  for (const w of dislike) if (w && hay.includes(String(w).toLowerCase())) return false
  if (!like.length) return true
  return like.some(w => w && hay.includes(String(w).toLowerCase()))
}

export function run(argv = []) {
  const cmd = argv[0] || 'help'
  const cfg = config()

  if (cmd === 'login') {
    console.log('打开抖音网页版扫码登录（会弹 Chrome 窗口，扫码后点「确认登录」）...')
    console.log(runPy(['login'], cfg))
    return
  }
  if (cmd === 'feed') {
    const headed = argv.includes('--headed') ? '--headed' : ''
    const out = runPy(['feed', '--scrolls', '8', ...(headed ? ['--headed'] : [])], cfg)
    const data = parseFeedJson(out)
    console.log(`采集到 ${data.videos?.length ?? 0} 个视频：`)
    for (const v of (data.videos || []).slice(0, 15)) {
      console.log(`  ${v.vid}  ${v.author}：${(v.desc || '').slice(0, 50)}  [评论${v.comment_count}/赞${v.digg_count}]`)
    }
    return
  }
  if (cmd === 'comments') {
    const vid = arg(argv, '--vid')
    if (!vid) { console.error('用法：node feiyu.mjs douyin comments --vid <视频id>'); process.exit(2) }
    console.log(runPy(['comments', '--vid', vid, '--headed'], cfg))
    return
  }
  if (cmd === 'cdp-start') {
    console.log(runPy(['cdp-start'], cfg))
    return
  }
  if (cmd === 'comment') {
    const vid = arg(argv, '--vid')
    const message = arg(argv, '--message')
    if (!vid || !message) { console.error('用法：node feiyu.mjs douyin comment --vid <id> --message "…" [--go] [--cdp]'); process.exit(2) }
    const go = argv.includes('--go')
    const cdp = argv.includes('--cdp')
    const atUser = cfg.douyin?.owner?.name || ''   // 真 @ 目标（弹通知）
    const dry = douyinDry(cfg) || !go   // 抖音独立 DRY，或未显式 --go 都拦
    if (dry) {
      console.log(`【干跑 ✓】不真发评论 → ${vid}\n  内容：${atUser ? '@' + atUser + ' ' : ''}${message}`)
      return
    }
    const args = ['comment', '--vid', vid, '--message', message]
    if (atUser) args.push('--at', atUser)
    args.push('--go', ...(cdp ? ['--cdp'] : []))
    console.log(runPy(args, cfg))
    return
  }
  if (cmd === 'reply') {
    const vid = arg(argv, '--vid')
    const cid = arg(argv, '--cid')
    const message = arg(argv, '--message')
    if (!vid || !cid || !message) { console.error('用法：node feiyu.mjs douyin reply --vid <id> --cid <评论cid> --message "…" [--go] [--cdp]'); process.exit(2) }
    const go = argv.includes('--go')
    const cdp = argv.includes('--cdp')
    const atUser = cfg.douyin?.owner?.name || ''
    const dry = douyinDry(cfg) || !go
    if (dry) {
      console.log(`【干跑 ✓】不真回复 cid=${cid} → ${atUser ? '@' + atUser + ' ' : ''}${message}`)
      return
    }
    const args = ['reply', '--vid', vid, '--cid', cid, '--message', message]
    if (atUser) args.push('--at', atUser)
    args.push('--go', ...(cdp ? ['--cdp'] : []))
    console.log(runPy(args, cfg))
    return
  }
  if (cmd === 'interact') {
    return runInteract(cfg)
  }
  console.log('用法：login | cdp-start | feed [--headed] | comments --vid | comment --vid --message [--go --cdp] | reply --vid --cid --message [--go --cdp] | interact')
}

// 全流程：feed → 口味过滤 → 读热评 → LLM 生成评论 → 干跑发评论
async function runInteract(cfg) {
  const { chat } = await import('../lib/llm.mjs')
  const persona = await import('../lib/persona.mjs')

  console.log('[interact] ① 刷 feed 采集视频...')
  const feedOut = runPy(['feed', '--scrolls', '8', '--headed'], cfg)
  const feed = parseFeedJson(feedOut)
  let videos = (feed.videos || []).filter(v => v.desc && v.author).filter(v => matchPrefs(v, cfg))
  if (!videos.length) videos = (feed.videos || []).filter(v => v.desc && v.author)
  const perRun = Math.max(1, Math.min(5, Number(cfg.douyin?.maxPerRun) || 2))
  console.log(`[interact] 口味过滤后剩 ${videos.length} 个候选，取前 ${perRun} 个（抖音风控严，控量）`)

  const top = videos.slice(0, perRun)
  for (const v of top) {
    console.log(`\n[interact] ② 看视频《${v.desc.slice(0, 40)}》（${v.author}）`)
    const commentsOut = runPy(['comments', '--vid', v.vid, '--headed'], cfg)
    let hot = []
    try {
      const m = commentsOut.match(/\{[\s\S]*\}/)
      if (m) hot = (JSON.parse(m[0]).comments || []).filter(c => c.text).slice(0, 5).map(c => c.text)
    } catch { hot = [] }

    console.log('[interact] ③ LLM 生成评论...')
    const msgs = []
    const base = persona.buildMessages({ platform: 'douyin', userText: '', chatId: `douyin:${v.vid}`, turnsToday: 0 })
    msgs.push(...base.slice(0, -1)) // system + 记忆（去掉末尾空的 user 消息）
    msgs.push({
      role: 'user',
      content: `你要给下面这条抖音视频写一条评论（要像真人，简短自然，可以带点你这个角色的语气，不要长篇大论，15~40字）。\n\n视频作者：${v.author}\n视频文案：${v.desc}\n热评参考：${hot.join(' / ') || '（无）'}\n\n直接输出评论正文，不要引号、不要解释。`,
    })
    let comment = ''
    try {
      const resp = await chat(msgs, { temperature: 0.9 })
      comment = (resp?.content ?? resp ?? '').trim().replace(/^["“]|["”]$/g, '').slice(0, 60)
    } catch (e) {
      console.error('[interact] LLM 失败：' + e.message)
      continue
    }
    if (!comment) { console.log('  ✗ 评论为空，跳过'); continue }
    comment = toPlain(comment)   // 评论区发不了图片表情，剥掉 [表情:x]
    if (!comment) { console.log('  ✗ 评论只剩表情标记，跳过'); continue }
    const atUser = cfg.douyin?.owner?.name || ''   // 真 @ 目标
    const dry = douyinDry(cfg)
    if (dry) {
      console.log(`  【干跑 ✓】${v.vid} → ${atUser ? '@' + atUser + ' ' : ''}${comment}`)
    } else {
      console.log(`  【真发 CDP】${v.vid} → ${atUser ? '@' + atUser + ' ' : ''}${comment}`)
      const args = ['comment', '--vid', v.vid, '--message', comment]
      if (atUser) args.push('--at', atUser)
      args.push('--go', '--cdp')
      console.log(runPy(args, cfg))
      // 风控：每条真发之间随机间隔 60~150 秒，避免连发被 shadowban
      const wait = 60 + Math.floor(Math.random() * 90)
      console.log(`  ⏳ 停 ${wait} 秒再发下一条（拟人节奏，躲风控）...`)
      await new Promise(r => setTimeout(r, wait * 1000))
    }
  }
  console.log('\n[interact] 完成。抖音独立 dryRun（douyin.dryRun）控制是否真发；真发前请确认 CDP Chrome(9222) 已开。')
}
