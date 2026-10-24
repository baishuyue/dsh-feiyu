// watch —— 抖音自主观看（LockyBee 路线的轻量版）。
// 循环：feed → 按兴趣挑 → 读热评（当"看"）→ 让 LLM 决定 继续/换片/停（给理由）→ 记兴趣。
// 画面采样与 Whisper 音频理解属于下一阶段（要给 douyin_interact.py 加截图 + 装 Whisper），
// 这一版先跑通"自主决策 + 兴趣记忆 + 时长限制"，并把看过的东西记进记忆供观看日报聚合。
//
//   node feiyu.mjs watch [--duration 10] [--max 3] [--dry]
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { config } from '../lib/config.mjs'
import * as memory from '../lib/memory.mjs'
import * as llm from '../lib/llm.mjs'
import { sendOwnerQQ } from '../lib/notify.mjs'
import { dataPath } from '../lib/paths.mjs'
import fs from 'node:fs'

const LOG = dataPath('watch.log')
const log = (...a) => { const m = a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '); try { console.log(m) } catch {}; try { fs.appendFileSync(LOG, `${new Date().toISOString()} ${m}\n`) } catch {} }

function arg(argv, name, d) { const i = argv.indexOf(name); return i >= 0 ? (argv[i + 1] ?? d) : d }
function has(argv, name) { return argv.includes(name) }

function pyPath(cfg) { return cfg.douyin?.python || 'D:/social-auto-upload/.venv/Scripts/python.exe' }
function scriptPath(cfg) { return cfg.douyin?.script || 'D:/social-auto-upload/douyin_interact.py' }
function cookiePath(cfg) { return cfg.douyin?.cookie || path.join(os.homedir(), '.feiyu-ai', 'douyin-cookies.json') }

function runPy(argv, cfg) {
  try {
    return execFileSync(pyPath(cfg), [scriptPath(cfg), ...argv, '--cookie', cookiePath(cfg)], { encoding: 'utf8', timeout: 300000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    throw new Error(String(e.stderr ?? e.message).slice(0, 3000))
  }
}
function jsonOf(out) { const m = String(out).match(/\{[\s\S]*\}/); if (!m) return {}; try { return JSON.parse(m[0]) } catch { return {} } }

function matchPrefs(v, cfg) {
  const like = cfg.preferences?.like || []
  const dislike = cfg.preferences?.dislike || []
  const hay = `${v.desc} ${v.author}`.toLowerCase()
  if (dislike.some(k => k && hay.includes(k))) return false
  if (like.length && !like.some(k => k && hay.includes(k))) return false
  return true
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

function douyinDry(cfg) { return cfg.douyin?.dryRun !== false }
const SHARE_FILE = () => path.join(os.homedir(), '.feiyu-ai', 'douyin-share.json')
function shareDay() { return new Date().toLocaleDateString('sv-SE') }
function shareQuotaOk(cfg) {
  const max = Number(cfg.douyin?.shareDaily || 1)
  try { const j = JSON.parse(fs.readFileSync(SHARE_FILE(), 'utf8')); return (j.day === shareDay() ? j.count : 0) < max } catch { return true }
}
function shareQuotaRecord(cfg) {
  try {
    const max = Number(cfg.douyin?.shareDaily || 1)
    const cur = (() => { try { const j = JSON.parse(fs.readFileSync(SHARE_FILE(), 'utf8')); return j.day === shareDay() ? j.count : 0 } catch { return 0 } })()
    fs.writeFileSync(SHARE_FILE(), JSON.stringify({ day: shareDay(), count: Math.min(cur + 1, max) }))
  } catch {}
}

export async function run(argv = []) {
  const cfg = config()
  const dry = has(argv, '--dry') || douyinDry(cfg)
  const silent = has(argv, '--silent') || cfg.douyin?.watch?.silent === true   // 无头后台，不弹 Chrome
  // 自由刷：大肥鱼自己长时间刷，不限条数/时长（unlimited）或按限度，每条之间休息更久（防风控）
  const free = has(argv, '--free') || cfg.douyin?.freeRoam?.enabled === true
  const fr = cfg.douyin?.freeRoam || {}
  let durationMin, max, restSec
  if (free) {
    const unlimited = fr.unlimited !== false
    max = unlimited ? 999999 : (Number(fr.maxVideos) || 999999)
    durationMin = unlimited ? 999999 : (Number(fr.maxMinutes) || 999999)
    restSec = Math.max(0, Number(fr.restMin) || 3) * 60
  } else {
    durationMin = Number(arg(argv, '--duration', cfg.douyin?.watch?.durationMin || 10))
    max = Number(arg(argv, '--max', cfg.douyin?.watch?.maxVideos || 3))
    restSec = 0
  }
  const started = Date.now()
  const deadline = started + durationMin * 60_000

  const limitText = (free && max > 99998) ? '不限量' : `最长 ${durationMin} 分钟 / 最多 ${max} 条`
  log(`[watch] ${free ? '自由刷' : '自主观看'}开始：${limitText}${dry ? '（DRY：只决策不真发评论）' : ''}${free ? ` · 每条间隔约 ${Math.round(restSec / 60)} 分钟` : ''}`)
  const seen = new Set()
  let watched = 0

  while (watched < max && Date.now() < deadline) {
    let feed = {}
    let feedOk = false
    for (let attempt = 1; attempt <= 3 && !feedOk; attempt++) {
      try {
        feed = jsonOf(runPy(silent ? ['feed'] : ['feed', '--headed'], cfg))
        feedOk = true
      } catch (e) {
        log(`[watch] feed 失败（第 ${attempt}/3 次）：${String(e.message).slice(0, 3000)}`)
        if (attempt < 3) await sleep(5000 * attempt)
      }
    }
    if (!feedOk) { log('[watch] feed 连续 3 次失败，本轮结束（下次再试）'); break }
    const videos = (feed.videos || []).filter(v => v.desc && v.author && !seen.has(v.vid)).filter(v => matchPrefs(v, cfg))
    if (!videos.length) {
      if (free) { log('[watch] 这一屏没有对口味的视频，歇一会儿再刷'); await sleep(restSec || 30_000); continue }
      log('[watch] 没有更多对口味的视频，结束。'); break
    }

    const v = videos[0]
    seen.add(v.vid)
    log(`\n[watch] 看《${String(v.desc).slice(0, 40)}》（${v.author}）`)
    memory.remember('douyin', `douyin:${v.vid}`, v.author, 'event', String(v.desc).slice(0, 120))

    // 读热评，当作"看了内容"
    let hot = []
    try { const c = jsonOf(runPy(silent ? ['comments', '--vid', v.vid] : ['comments', '--vid', v.vid, '--headed'], cfg)); hot = (c.comments || []).filter(x => x.text).slice(0, 4).map(x => x.text) } catch {}

    // 决策：继续 / 换片 / 停；顺带判断 值不值得分享给主人 / 值不值得评论
    let decision = '继续', reason = '', share = false, comment = ''
    try {
      const msgs = [
        { role: 'system', content: '你是"大肥鱼"，一条爱刷抖音的小鲸鱼，有自己口味。看一条视频后决定下一步。只输出 JSON：'
          + '{"action":"继续|换片|停","reason":"不超过20字的原因","share":true或false(特别有意思、想给主人看的才 true),'
          + '"comment":"15~40字的评论，只有你觉得值得评论时才写，否则省略"}' },
        { role: 'user', content: `视频《${v.desc}》（作者 ${v.author}）\n热评：${hot.join(' / ') || '（无）'}\n下一步？` },
      ]
      const resp = await llm.chat(msgs, { temperature: 0.7 })
      const m = String(resp?.content ?? resp ?? '').match(/\{[\s\S]*\}/)
      if (m) { const j = JSON.parse(m[0]); decision = j.action || '继续'; reason = j.reason || ''; share = !!j.share; comment = String(j.comment || '').slice(0, 60) }
    } catch (e) { log('[watch] 决策失败：' + e.message) }

    watched++
    log(`  → ${decision}${reason ? '（' + reason + '）' : ''}${share ? ' · 分享主人' : ''}${comment ? ' · 评论' : ''}`)

    // ① 分享给主人（在抖音里，替代评论 @）：抖音私信发 视频链接 + 她的评论，之后可在私信里继续聊
    if (share && cfg.douyin?.shareToOwner === true) {
      if (shareQuotaOk(cfg)) {
        const url = `https://www.douyin.com/video/${v.vid}`
        const line = comment || reason || '这个有意思，你看看'
        const text = `《${String(v.desc).slice(0, 40)}》 ${url}\n${line} 😆`
        const via = cfg.douyin?.shareVia || 'douyin'
        const ownerName = String(cfg.douyin?.owner?.name || cfg.owner?.name || '').trim()
        const ownerSecUid = String(cfg.douyin?.owner?.sec_uid || '').trim()
        let ok = false
        if (douyinDry(cfg)) {
          console.log(`  【干跑 ✓】本要在抖音私信分享给「${ownerName || '主人'}」：${text.split('\n')[0]}…`)
          ok = true   // 干跑不占真额度，但记录一下决策
        } else {
          if ((via === 'douyin' || via === 'both') && ownerSecUid) {
            const dmArgs = ['dm-send', '--sec-uid', ownerSecUid, '--name', ownerName, '--message', text, '--go', '--cdp']
            if (silent) dmArgs.push('--headless')
            try { console.log(runPy(dmArgs, cfg)); ok = true } catch (e) { console.error('[watch] 抖音私信分享失败：' + e.message) }
          }
          if (via === 'qq' || (via === 'both' && !ok)) {
            ok = await sendOwnerQQ(`在抖音刷到个好玩的：${text}`)
          }
        }
        if (ok) { shareQuotaRecord(cfg); memory.addLore('兴趣', `抖音《${String(v.desc).slice(0, 30)}》——分享给了主人`); log('  📨 已分享给主人（抖音私信）') }
        else log('  ✗ 分享主人失败（没配 douyin.owner.name 或 NapCat 没起）')
      } else {
        log('  ⏭ 今日分享给主人的额度已用完')
      }
    }

    // ② 自主评论（自学习人格生成，受 douyin.dryRun 控制，默认只演练不真发）
    if (comment && cfg.douyin?.autoComment === true) {
      const args = ['comment', '--vid', v.vid, '--message', comment]
      if (douyinDry(cfg)) args.push('--cdp')   // 演练也走 CDP 路径，打印即可
      else args.push('--go', '--cdp')
      try { console.log(runPy(args, cfg)) } catch (e) { log('[watch] 评论失败：' + e.message) }
      await sleep(60_000 + Math.random() * 60_000)   // 真发之间长间隔，防风控
    }

    if (decision !== '换片' && decision !== '继续') {
      if (reason) memory.addLore('兴趣', `抖音《${String(v.desc).slice(0, 30)}》——${reason}`)
      if (free) { log('  → 想停一下，歇会儿再看'); await sleep(restSec * 2); continue }
      break
    }
    if (reason) memory.addLore('兴趣', `抖音《${String(v.desc).slice(0, 30)}》——${reason}`)
    await sleep(restSec > 0 ? restSec + Math.random() * 30_000 : 2500 + Math.random() * 2000)
  }

  const secs = Math.round((Date.now() - started) / 1000)
  log(`\n[watch] 结束：看了 ${watched} 条，用时 ${secs}s。观看日报：node feiyu.mjs report`)
  return { watched, secs, lore: memory.lore('兴趣').length }
}

if (process.argv[1] && process.argv[1].endsWith('watch.mjs')) {
  await run(process.argv.slice(2))
}
