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
    // python 的 log() 打到 stdout、真报错常在尾部；stderr 开头是 patchright 驱动的 Node 弃用警告，
    // 只取 stderr 头部等于把真错全扔了（踩过：评论失败只看到一句 DeprecationWarning）。
    const clean = (s) => String(s || '').split(/\r?\n/).filter((l) => !/DeprecationWarning|CVEs are not issued|trace-deprecation/.test(l)).join('\n').trim()
    const real = [clean(e.stdout), clean(e.stderr)].filter(Boolean).join(' | ')
    throw new Error((real || String(e.message)).slice(-600))
  }
}
function jsonOf(out) { const m = String(out).match(/\{[\s\S]*\}/); if (!m) return {}; try { return JSON.parse(m[0]) } catch { return {} } }

function matchPrefs(v, cfg, grams) {
  const like = cfg.preferences?.like || []
  const dislike = cfg.preferences?.dislike || []
  const hay = `${v.desc} ${v.author}`.toLowerCase()
  if (dislike.some(k => k && hay.includes(k))) return false
  if (like.some(k => k && hay.includes(k))) return true
  // 静态偏好没中，问她自己养成的兴趣（lore 兴趣池的 2-gram 重合）—— 口味自己长
  if (grams && grams.size && memory.interestScore(hay, grams) >= 3) return true
  return !like.length
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

/** CDP Chrome(9222) 是否就绪。 */
async function cdpReady(timeoutMs = 2500) {
  try { const r = await fetch('http://127.0.0.1:9222/json/version', { signal: AbortSignal.timeout(timeoutMs) }); return r.ok } catch { return false }
}

/** 真发评论/有头分享前确保 CDP 真浏览器在跑；没开就自动拉起（detached，窗口会弹出来）。 */
async function ensureCdp(cfg) {
  if (await cdpReady()) return true
  log('[watch] CDP Chrome(9222) 没开，自动拉起真浏览器（真发评论必须走它，风控低）…')
  try {
    // 注意：cdp-start 子命令不认 --cookie，直接裸调（走 runPy 会拼上 --cookie 被 argparse 拒）
    execFileSync(pyPath(cfg), [scriptPath(cfg), 'cdp-start'], { encoding: 'utf8', timeout: 60000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    log('[watch] cdp-start 失败：' + String(e.stderr || e.message).slice(-200))
    return false
  }
  for (let i = 0; i < 10; i++) {
    await sleep(3000)
    if (await cdpReady(1500)) { log('[watch] CDP Chrome 已就绪'); return true }
  }
  log('[watch] ✗ CDP Chrome 30 秒没就绪 —— 首次使用要在弹出的 Chrome 窗口里扫码登录抖音一次')
  return false
}

function douyinDry(cfg) { return cfg.douyin?.dryRun !== false }
const SHARE_FILE = () => path.join(os.homedir(), '.feiyu-ai', 'douyin-share.json')
function shareDay() { return new Date().toLocaleDateString('sv-SE') }
// 评论每日上限（自由刷不限量跑通宵，评论不设顶会被风控盯上 —— 宁可少发；0 = 不限）
const COMMENT_FILE = () => path.join(os.homedir(), '.feiyu-ai', 'douyin-comment.json')
function commentQuotaOk(cfg) {
  const max = Number(cfg.douyin?.commentDaily ?? 8)
  if (max <= 0) return true   // 0 = 不限，随便玩
  try { const j = JSON.parse(fs.readFileSync(COMMENT_FILE(), 'utf8')); return (j.day === shareDay() ? j.count : 0) < max } catch { return true }
}
function commentQuotaRecord(cfg) {
  try {
    const max = Number(cfg.douyin?.commentDaily ?? 8)
    const cur = (() => { try { const j = JSON.parse(fs.readFileSync(COMMENT_FILE(), 'utf8')); return j.day === shareDay() ? j.count : 0 } catch { return 0 } })()
    fs.writeFileSync(COMMENT_FILE(), JSON.stringify({ day: shareDay(), count: max > 0 ? Math.min(cur + 1, max) : cur + 1 }))
  } catch {}
}
function shareQuotaOk(cfg) {
  const max = Number(cfg.douyin?.shareDaily ?? 5)
  if (max <= 0) return true   // 0 = 不限，随便玩
  try { const j = JSON.parse(fs.readFileSync(SHARE_FILE(), 'utf8')); return (j.day === shareDay() ? j.count : 0) < max } catch { return true }
}
function shareQuotaRecord(cfg) {
  try {
    const max = Number(cfg.douyin?.shareDaily ?? 5)
    const cur = (() => { try { const j = JSON.parse(fs.readFileSync(SHARE_FILE(), 'utf8')); return j.day === shareDay() ? j.count : 0 } catch { return 0 } })()
    fs.writeFileSync(SHARE_FILE(), JSON.stringify({ day: shareDay(), count: max > 0 ? Math.min(cur + 1, max) : cur + 1 }))
  } catch {}
}

export async function run(argv = []) {
  const cfg = config()
  try { const n = memory.sweepEpisodes(); if (n) log(`[watch] 记忆归档：${n} 条 90 天前的旧事件移入 *.archive.jsonl`) } catch {}
  const dry = has(argv, '--dry') || douyinDry(cfg)
  const silent = has(argv, '--silent') || cfg.douyin?.watch?.silent === true   // 无头后台，不弹 Chrome
  // 自由刷：大肥鱼自己长时间刷，不限条数/时长（unlimited）或按限度，每条之间休息更久（防风控）
  const free = has(argv, '--free') || cfg.douyin?.freeRoam?.enabled === true
  const fr = cfg.douyin?.freeRoam || {}
  let durationMin, max, restMs   // sleep 收毫秒 —— 间隔直接算成毫秒，别拿秒去喂（曾把 3 分钟喂成 3ms 级）
  if (free) {
    const unlimited = fr.unlimited !== false
    max = unlimited ? 999999 : (Number(fr.maxVideos) || 999999)
    durationMin = unlimited ? 999999 : (Number(fr.maxMinutes) || 999999)
    const restMin = Number(fr.restMin)
    restMs = Math.max(0, Number.isFinite(restMin) ? restMin : 3) * 60_000
  } else {
    durationMin = Number(arg(argv, '--duration', cfg.douyin?.watch?.durationMin || 10))
    max = Number(arg(argv, '--max', cfg.douyin?.watch?.maxVideos || 3))
    restMs = 0
  }
  const started = Date.now()
  const deadline = started + durationMin * 60_000

  const limitText = (free && max > 99998) ? '不限量' : `最长 ${durationMin} 分钟 / 最多 ${max} 条`
  log(`[watch] ${free ? '自由刷' : '自主观看'}开始：${limitText}${dry ? '（DRY：只决策不真发评论）' : ''}${free ? ` · 每条间隔约 ${Math.round(restMs / 60_000)} 分钟` : ''}`)
  const seen = new Set()
  let watched = 0
  const grams = memory.interestGrams()   // 她自己养成的口味，一次算好整轮用

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
    if (!feedOk) {
      // 自由刷不能因为几轮 feed 失败就退出 —— 进程一死，面板开关还亮着（假状态），
      // 而且今晚就再也不刷了。歇 5 分钟接着来。普通模式才退出。
      if (free) { log('[watch] feed 连续 3 次失败，歇 5 分钟再试（自由刷不退出）'); await sleep(5 * 60_000); continue }
      log('[watch] feed 连续 3 次失败，本轮结束（下次再试）'); break
    }
    const videos = (feed.videos || []).filter(v => v.desc && v.author && !seen.has(v.vid)).filter(v => matchPrefs(v, cfg, grams))
    if (!videos.length) {
      if (free) { log('[watch] 这一屏没有对口味的视频，歇一会儿再刷'); await sleep(restMs || 30_000); continue }
      log('[watch] 没有更多对口味的视频，结束。'); break
    }

    const v = videos[0]
    seen.add(v.vid)
    log(`\n[watch] 看《${String(v.desc).slice(0, 40)}》（${v.author}）`)
    memory.remember('douyin', `douyin:${v.vid}`, v.author, 'event', String(v.desc).slice(0, 120))

    // 读热评，当作"看了内容"
    let hot = []
    try { const c = jsonOf(runPy(silent ? ['comments', '--vid', v.vid] : ['comments', '--vid', v.vid, '--headed'], cfg)); hot = (c.comments || []).filter(x => x.text).slice(0, 4).map(x => x.text) } catch {}

    // 画面采样 + 视觉理解（10-25 框架）：vision 配齐才启用；没配静默跳过，老流程不受影响
    let visual = ''
    try {
      const { visionOn, describeFrames } = await import('../lib/vision.mjs')
      if (visionOn()) {
        const framesDir = path.join(os.homedir(), '.feiyu-ai', 'frames', String(v.vid).replace(/[^\w-]/g, '').slice(0, 40))
        const out = jsonOf(runPy(['frames', '--vid', v.vid, '--out', framesDir, '--n', '3'], cfg))
        const frames = (out.frames || []).filter((f) => fs.existsSync(f))
        const desc = frames.length ? await describeFrames(frames) : null
        if (desc) { visual = `\n画面（她亲眼看到的）：${desc}`; log(`  👁 画面：${desc.slice(0, 60)}`) }
        else log('  👁 视觉描述没出来（key/网络/模型），这条靠文字信息决策')
        try { fs.rmSync(framesDir, { recursive: true, force: true }) } catch {}   // 帧图不囤，描述完就删
      }
    } catch (e) { log('  👁 视觉采样异常：' + String(e.message).slice(0, 80)) }

    // 决策：继续 / 换片 / 停；顺带判断 值不值得分享给主人 / 值不值得评论
    let decision = '继续', reason = '', share = false, comment = ''
    try {
      const msgs = [
        { role: 'system', content: '你是"大肥鱼"，一条爱刷抖音的小鲸鱼，有自己口味。看一条视频后决定下一步。只输出 JSON：'
          + '{"action":"继续|换片|停","reason":"不超过20字的原因","share":true或false,'
          + '"comment":"15~40字的评论，只有你觉得值得评论时才写，否则省略"}\n'
          + 'share 的标准放宽些：主人喜欢收到你的分享，只要这条让你嘴角上扬/学到东西/想安利给他，就 true；'
          + '每天有分享额度，别吝啬，但也别无聊的也发。' },
        { role: 'user', content: `视频《${v.desc}》（作者 ${v.author}）${visual}\n热评：${hot.join(' / ') || '（无）'}\n下一步？` },
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
          if ((via === 'douyin' || via === 'both') && ownerName) {
            // ① 原生分享卡片（手机上可点开、和你手动分享一样的），随后补一句附言
            const mode = silent ? '--headless' : (await ensureCdp(cfg) ? '--cdp' : '')
            if (mode) {
              try {
                console.log(runPy(['share', '--vid', v.vid, '--friend', ownerName, '--go', mode], cfg))
                ok = true
                if (line && ownerSecUid) {
                  try { runPy(['dm-send', '--sec-uid', ownerSecUid, '--name', ownerName, '--message', `${line} 😆`, '--go', mode], cfg) } catch {}
                }
              } catch (e) {
                log('[watch] 原生分享失败，退回文字链接：' + e.message)
              }
            }
            // ② 退路：文字链接私信（老方案）
            if (!ok && ownerSecUid) {
              const mode2 = silent ? '--headless' : (await ensureCdp(cfg) ? '--cdp' : '')
              if (mode2) {
                try { console.log(runPy(['dm-send', '--sec-uid', ownerSecUid, '--name', ownerName, '--message', text, '--go', mode2], cfg)); ok = true }
                catch (e) { console.error('[watch] 抖音私信分享失败：' + e.message) }
              }
            }
          }
          if (via === 'qq' || (via === 'both' && !ok)) {
            ok = await sendOwnerQQ(`在抖音刷到个好玩的：${text}`)
          }
        }
        if (ok) {
          shareQuotaRecord(cfg)
          memory.addLore('兴趣', `抖音《${String(v.desc).slice(0, 30)}》——分享给了主人`)
          // 分享附言写进私信会话记忆（10-25 修"对话割裂"：主人回复分享时，上下文里必须有这条线）
          try { memory.remember('douyin', 'douyin-dm:owner', String(cfg.douyin?.owner?.name || ''), 'assistant', `（分享了视频：《${String(v.desc).slice(0, 40)}》 ${url}）${line ? '\n我的评论：' + line : ''}`) } catch {}
          log('  📨 已分享给主人（抖音私信）')
        }
        else log('  ✗ 分享主人失败（没配 douyin.owner.name 或 NapCat 没起）')
      } else {
        log('  ⏭ 今日分享给主人的额度已用完')
      }
    }

    // ② 自主评论（自学习人格生成，受 douyin.dryRun 控制，默认只演练不真发；另有每日上限防风控）
    if (comment && cfg.douyin?.autoComment === true) {
      if (douyinDry(cfg)) {
        log(`  【干跑 ✓】评论：${comment}`)
      } else if (!commentQuotaOk(cfg)) {
        log('  ⏭ 今日抖音评论额度已用完（douyin.commentDaily），这条只看不说')
      } else if (await ensureCdp(cfg)) {
        try {
          console.log(runPy(['comment', '--vid', v.vid, '--message', comment, '--go', '--cdp'], cfg))
          commentQuotaRecord(cfg)
        }
        catch (e) { log('[watch] 评论失败：' + e.message) }
        await sleep(60_000 + Math.random() * 60_000)   // 真发之间长间隔，防风控
      } else {
        log('  ✗ 没有真浏览器可用，这条评论放弃（CDP Chrome 拉不起来）')
      }
    }

    if (decision !== '换片' && decision !== '继续') {
      if (reason) memory.addLore('兴趣', `抖音《${String(v.desc).slice(0, 30)}》——${reason}`)
      if (free) { log('  → 想停一下，歇会儿再看'); await sleep(restMs * 2 || 60_000); continue }
      break
    }
    if (reason) memory.addLore('兴趣', `抖音《${String(v.desc).slice(0, 30)}》——${reason}`)
    await sleep(restMs > 0 ? restMs + Math.random() * 30_000 : 2500 + Math.random() * 2000)
  }

  const secs = Math.round((Date.now() - started) / 1000)
  log(`\n[watch] 结束：看了 ${watched} 条，用时 ${secs}s。观看日报：node feiyu.mjs report`)
  return { watched, secs, lore: memory.lore('兴趣').length }
}

if (process.argv[1] && process.argv[1].endsWith('watch.mjs')) {
  await run(process.argv.slice(2))
}
