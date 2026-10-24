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

function arg(argv, name, d) { const i = argv.indexOf(name); return i >= 0 ? (argv[i + 1] ?? d) : d }
function has(argv, name) { return argv.includes(name) }

function pyPath(cfg) { return cfg.douyin?.python || 'D:/social-auto-upload/.venv/Scripts/python.exe' }
function scriptPath(cfg) { return cfg.douyin?.script || 'D:/social-auto-upload/douyin_interact.py' }
function cookiePath(cfg) { return cfg.douyin?.cookie || path.join(os.homedir(), '.feiyu-ai', 'douyin-cookies.json') }

function runPy(argv, cfg) {
  try {
    return execFileSync(pyPath(cfg), [scriptPath(cfg), ...argv, '--cookie', cookiePath(cfg)], { encoding: 'utf8', timeout: 300000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    throw new Error(String(e.stderr ?? e.message).slice(0, 400))
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

export async function run(argv = []) {
  const cfg = config()
  const dry = has(argv, '--dry') || cfg.douyin?.watch?.dry === true
  const durationMin = Number(arg(argv, '--duration', cfg.douyin?.watch?.durationMin || 10))
  const max = Number(arg(argv, '--max', cfg.douyin?.watch?.maxVideos || 3))
  const started = Date.now()
  const deadline = started + durationMin * 60_000

  console.log(`[watch] 自主观看开始：最长 ${durationMin} 分钟 / 最多 ${max} 条${dry ? '（DRY：只决策不真发评论）' : ''}`)
  const seen = new Set()
  let watched = 0

  while (watched < max && Date.now() < deadline) {
    let feed = {}
    try { feed = jsonOf(runPy(['feed', '--headed'], cfg)) } catch (e) { console.error('[watch] feed 失败：' + e.message); break }
    const videos = (feed.videos || []).filter(v => v.desc && v.author && !seen.has(v.vid)).filter(v => matchPrefs(v, cfg))
    if (!videos.length) { console.log('[watch] 没有更多对口味的视频，结束。'); break }

    const v = videos[0]
    seen.add(v.vid)
    console.log(`\n[watch] 看《${String(v.desc).slice(0, 40)}》（${v.author}）`)
    memory.remember('douyin', `douyin:${v.vid}`, v.author, 'event', String(v.desc).slice(0, 120))

    // 读热评，当作"看了内容"
    let hot = []
    try { const c = jsonOf(runPy(['comments', '--vid', v.vid, '--headed'], cfg)); hot = (c.comments || []).filter(x => x.text).slice(0, 4).map(x => x.text) } catch {}

    // 决策：继续 / 换片 / 停
    let decision = '继续', reason = ''
    try {
      const msgs = [
        { role: 'system', content: '你是"大肥鱼"，一条爱刷抖音的小鲸鱼，有自己口味。看一条视频后决定下一步。只输出 JSON：{"action":"继续|换片|停","reason":"不超过20字的原因"}' },
        { role: 'user', content: `视频《${v.desc}》（作者 ${v.author}）\n热评：${hot.join(' / ') || '（无）'}\n下一步？` },
      ]
      const resp = await llm.chat(msgs, { temperature: 0.7 })
      const m = String(resp?.content ?? resp ?? '').match(/\{[\s\S]*\}/)
      if (m) { const j = JSON.parse(m[0]); decision = j.action || '继续'; reason = j.reason || '' }
    } catch (e) { console.error('[watch] 决策失败：' + e.message) }

    watched++
    console.log(`  → ${decision}${reason ? '（' + reason + '）' : ''}`)

    if (decision !== '换片' && decision !== '继续') {
      // 停之前把"为什么停"也记一笔兴趣
      if (reason) memory.addLore('兴趣', `抖音《${String(v.desc).slice(0, 30)}》——${reason}`)
      break
    }
    if (reason) memory.addLore('兴趣', `抖音《${String(v.desc).slice(0, 30)}》——${reason}`)
    await sleep(2500 + Math.random() * 2000)   // 拟人节奏
  }

  const secs = Math.round((Date.now() - started) / 1000)
  console.log(`\n[watch] 结束：看了 ${watched} 条，用时 ${secs}s。观看日报：node feiyu.mjs report`)
  return { watched, secs, lore: memory.lore('兴趣').length }
}

if (process.argv[1] && process.argv[1].endsWith('watch.mjs')) {
  await run(process.argv.slice(2))
}
