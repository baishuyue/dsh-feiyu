// 万相 2.7 图生视频（10-27）：把"她的一张图"变成"真的在动的镜头"。
//
// 为什么是它（而不是即梦/LibTV 那些网页产品）：只有它有能编程调用的官方接口，
// 而且正好覆盖我们的三个硬需求 ——
//   ① 首帧图生视频：她的形象由 imggen 锁死，视频模型只负责让这一帧动起来；
//   ② base64 直传：图在本地，不用买 OSS、不用开图床；
//   ③ 竖屏 1080×1920 / 30fps 原生支持，抖音那条线不用二次裁切。
//
// 走的是主人 LLM 那条中转站的 DashScope 原生路径（同一个 key，不用另开账号）：
//   POST {host}/api/v1/services/aigc/video-generation/video-synthesis   （提交，异步）
//   GET  {host}/api/v1/tasks/{task_id}                                  （轮询，15s 一次够了）
//   {host} = llm.base_url 去掉 /compatible-mode/v1 —— 也可以 video.animate.baseUrl 直接指定。
//
// ⚠️ 三个坑（10-27 实测）：
//   1. 少 `X-DashScope-Async: enable` 会直接报 "current user api does not support asynchronous calls"；
//   2. `duration` 只收 2~15 的整数，`resolution` 是"像素档位"不是固定尺寸 ——
//      输出宽高比跟着首帧走（给方图 → 948×970，给 1080×1920 → 就是 1080×1920）；
//   3. `video_url` 只有 24 小时有效，出片必须立刻下载。
//
// 音轨：不传 driving_audio 时它会**自己生成 BGM/音效**。这条片子的人声是 SoVITS 的，
// 所以拿到片子第一件事就是掐掉模型音轨（mute），一秒都不许漏进去。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { config } from './config.mjs'
import { ff, ffmpegBin, probeDur, run, ffprobeBin } from './video.mjs'

export const DEFAULT_NEGATIVE = [
  '低分辨率', '模糊', '画面抖动', '面部崩坏', '五官扭曲', '肢体扭曲', '多余的手指',
  '水印', '字幕', '文字', 'logo', '画面闪烁',
  // 10-27 主人拍板：**别的二次元同类可以入镜**（Q版/动漫风），所以不再禁"多人/另一个人"；
  // 但仍然不许真人 —— 这条片子的世界只有动漫形象。
  '真人', '真人脸部', '写实照片', '3D写实',
].join(',')

const SUBMIT_PATH = '/api/v1/services/aigc/video-generation/video-synthesis'
const TASK_PATH = (id) => `/api/v1/tasks/${encodeURIComponent(id)}`

/** 中转站根地址：优先 video.animate.baseUrl，否则从 llm.base_url 剥出 host。 */
export function dashscopeBase(cfg = config()) {
  const raw = String(cfg.video?.animate?.baseUrl || cfg.llm?.base_url || '').trim()
  if (!raw) return ''
  return raw.replace(/\/+$/, '').replace(/\/(compatible-mode\/v1|compatible-mode|v1)$/i, '')
}

/** 合并后的视频生成设置（配置文件热读，改完即生效）。 */
export function settings(cfg = config()) {
  const a = cfg.video?.animate || {}
  return {
    enabled: a.enabled !== false,
    baseUrl: dashscopeBase(cfg),
    apiKey: String(a.apiKey || cfg.llm?.api_key || ''),
    model: a.model || 'wan2.7-i2v-2026-04-25',
    resolution: a.resolution || '1080P',
    maxSeconds: Math.min(15, Math.max(2, Number(a.maxSeconds) || 15)),
    negative: a.negative || DEFAULT_NEGATIVE,
    pricePerSecond: Number(a.pricePerSecond ?? 0.35),
    budgetPerRun: Number(a.budgetPerRun ?? 20),
    pollSec: Math.max(1, Number(a.pollSec) || 8),
    maxWaitSec: Number(a.maxWaitSec) || 420,
    keepRaw: a.keepRaw !== false,
    retries: Math.max(0, Number(a.retries ?? 1)),
  }
}

/** 能不能用：开关 + key + 地址三样齐。缺一样就当没这功能（produce 自动走回静图）。 */
export function available(cfg = config()) {
  const s = settings(cfg)
  return Boolean(s.enabled && s.apiKey && s.baseUrl)
}

/** 钱：按秒估（真实单价去中转站后台核，把数字写进 video.animate.pricePerSecond 即可对齐）。 */
export function estimateCost(seconds, cfg = config()) {
  const s = settings(cfg)
  return +(Math.max(0, Number(seconds) || 0) * s.pricePerSecond).toFixed(2)
}

/**
 * 把一幕要用的总时长切成若干段，每段 ≤ maxSeconds 且是 ≥2 的整数。
 * 均分而不是"15+余数"：最后剩 2 秒的尾巴在成片里特别难看。
 */
export function planSegments(totalSec, maxSeconds = 15) {
  const total = Math.max(0, Number(totalSec) || 0)
  if (total <= 0) return []
  const max = Math.min(15, Math.max(2, Math.round(Number(maxSeconds) || 15)))
  const n = Math.max(1, Math.ceil(total / max))
  const base = total / n
  const out = []
  let left = total
  for (let i = 0; i < n; i++) {
    const remainSegs = n - i
    let d = i === n - 1 ? Math.round(left) : Math.round(base)
    d = Math.min(max, Math.max(2, d))
    // 最后一段兜底：不许出现 <2 的尾巴（不足的补到前一段里）
    if (remainSegs === 1 && left < 2 && out.length) { out[out.length - 1] += Math.round(left); return out }
    out.push(d)
    left -= d
  }
  return out.filter((d) => d >= 2)
}

const MIME = [
  [[0xff, 0xd8, 0xff], 'image/jpeg'],
  [[0x89, 0x50, 0x4e, 0x47], 'image/png'],
  [[0x52, 0x49, 0x46, 0x46], 'image/webp'],
]

function mimeOf(file) {
  const head = fs.readFileSync(file).subarray(0, 12)
  for (const [sig, mime] of MIME) {
    if (sig.every((b, i) => head[i] === b)) return mime
  }
  return 'image/jpeg'
}

/**
 * 首帧预处理：裁成平台规格（1080×1920 / 1920×1080）+ 压到合理体积。
 * 直接传 4K 原图（2160×3840）也能过，但 base64 会膨胀到几 MB、上传慢还更容易超时；
 * 裁成目标尺寸顺带把"输出宽高比跟着首帧走"这条规则钉死。
 */
export function prepareFirstFrame({ src, out, w = 0, h = 0, cfg = config() }) {
  if (!src || !fs.existsSync(src)) throw new Error(`首帧不存在：${src}`)
  const vf = (w && h)
    ? `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1`
    : 'scale=trunc(iw/2)*2:trunc(ih/2)*2'
  ff(['-i', src, '-vf', vf, '-q:v', '3', '-frames:v', '1', out], { cfg })
  return out
}

function assertNonEmpty(v, what) {
  if (!v) throw new Error(`${what} 缺失`)
  return v
}

/** 提交一条 i2v 任务，返回 task_id。 */
export async function submit({ firstFrame, prompt = '', negative, seconds = 5, seed, s = settings(), log = () => {} }) {
  assertNonEmpty(firstFrame, '首帧')
  const dur = Math.min(15, Math.max(2, Math.round(Number(seconds) || 5)))
  const media = `data:${mimeOf(firstFrame)};base64,${fs.readFileSync(firstFrame).toString('base64')}`
  const body = {
    model: s.model,
    input: {
      prompt: String(prompt || '').slice(0, 1500),
      negative_prompt: String(negative || s.negative).slice(0, 500),
      media: [{ type: 'first_frame', url: media }],
    },
    parameters: {
      resolution: s.resolution,
      duration: dur,
      prompt_extend: false,
      watermark: false,
      ...(Number.isFinite(seed) ? { seed: Math.trunc(seed) } : {}),
    },
  }
  const res = await fetch(s.baseUrl + SUBMIT_PATH, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${s.apiKey}`,
      'Content-Type': 'application/json',
      'X-DashScope-Async': 'enable',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  })
  const txt = await res.text()
  let json = {}
  try { json = JSON.parse(txt) } catch { /* 非 JSON，下面按状态码抛 */ }
  const taskId = json?.output?.task_id
  if (!res.ok || !taskId) {
    const msg = json?.message || json?.output?.message || txt.slice(0, 200) || `HTTP ${res.status}`
    const code = json?.code || json?.output?.code || `HTTP${res.status}`
    throw new Error(`万相提交失败（${code}）：${String(msg).slice(0, 160)}`)
  }
  log(`    提交 ✓ task=${taskId.slice(0, 8)} · ${dur}s · ${s.resolution}`)
  return { taskId, seconds: dur }
}

/** 轮询到出片；返回 { status, videoUrl, code, message }。 */
export async function waitTask({ taskId, s = settings(), log = () => {} }) {
  const t0 = Date.now()
  let last = ''
  for (;;) {
    await new Promise((r) => setTimeout(r, s.pollSec * 1000))
    const res = await fetch(s.baseUrl + TASK_PATH(taskId), {
      headers: { Authorization: `Bearer ${s.apiKey}` },
      signal: AbortSignal.timeout(60_000),
    })
    const txt = await res.text()
    let json = {}
    try { json = JSON.parse(txt) } catch { /* ignore */ }
    const o = json?.output || {}
    const st = String(o.task_status || '').toUpperCase()
    if (st && st !== last) { last = st; log(`    状态 ${st}（+${Math.round((Date.now() - t0) / 1000)}s）`) }
    if (st === 'SUCCEEDED') return { status: st, videoUrl: o.video_url || '', output: o }
    if (st === 'FAILED' || st === 'CANCELED' || st === 'UNKNOWN') {
      throw new Error(`万相生成失败（${o.code || st}）：${String(o.message || '').slice(0, 160)}`)
    }
    if (!st) throw new Error(`万相轮询返回异常：${txt.slice(0, 160)}`)
    if ((Date.now() - t0) / 1000 > s.maxWaitSec) throw new Error(`万相超时（${s.maxWaitSec}s 还没出片）`)
  }
}

async function download(url, out) {
  const res = await fetch(url, { signal: AbortSignal.timeout(300_000) })
  if (!res.ok) throw new Error(`下载成片失败 HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length < 20_000) throw new Error(`下载到的成片太小（${buf.length}B），八成是错误页`)
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, buf)
  return out
}

/** 掐掉模型音轨（它自己生成的 BGM/音效一律不要，人声只走 SoVITS）。 */
export function mute(src, out, cfg = config()) {
  ff(['-i', src, '-map', '0:v:0', '-c:v', 'copy', '-an', '-movflags', '+faststart', out], { cfg })
  return out
}

/** 取最后一帧（下一段的"首帧"用它，段落之间才不会跳）。 */
export function lastFrame(video, out, cfg = config()) {
  try {
    ff(['-sseof', '-0.25', '-i', video, '-update', '1', '-q:v', '2', '-frames:v', '1', out], { cfg })
  } catch {
    ff(['-i', video, '-vf', 'select=eq(n\\,0)', '-frames:v', '1', '-q:v', '2', out], { cfg })
  }
  if (!fs.existsSync(out) || fs.statSync(out).size < 1024) throw new Error('抽最后一帧失败')
  return out
}

/**
 * 生成一条 i2v 片段：提交 → 轮询 → 下载 → 掐音轨。
 * @returns {Promise<{file:string, seconds:number, taskId:string, raw:string}>}
 */
export async function animate({
  firstFrame, prompt, negative, seconds = 5, out, seed, keepRaw = true,
  cfg = config(), s = settings(cfg), log = () => {},
}) {
  const tmp = path.join(os.tmpdir(), `wan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`)
  const { taskId, seconds: dur } = await submit({ firstFrame, prompt, negative, seconds, seed, s, log })
  const done = await waitTask({ taskId, s, log })
  await download(done.videoUrl, tmp)
  const raw = keepRaw ? out.replace(/\.mp4$/, '.raw.mp4') : tmp
  if (keepRaw) { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.copyFileSync(tmp, raw) }
  mute(tmp, out, cfg)
  if (!keepRaw) { try { fs.rmSync(tmp, { force: true }) } catch {} }
  const d = probeDur(out, cfg)
  if (!(d > 0.5)) throw new Error('掐完音轨的片段读不出时长')
  return { file: out, seconds: dur, taskId, raw: keepRaw ? raw : '', dur: d }
}

/** 多段拼一条（chunk 之间用 concat 滤镜，不解码两次）。 */
function concatClips(files, out, cfg = config()) {
  if (files.length === 1) { fs.copyFileSync(files[0], out); return out }
  const args = []
  for (const f of files) args.push('-i', f)
  const chains = files.map((_, i) => `[${i}:v]`).join('')
  ff([...args, '-filter_complex', `${chains}concat=n=${files.length}:v=1:a=0[v]`,
    '-map', '[v]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-an', out], { cfg })
  return out
}

/**
 * 一幕 → 一条覆盖这一幕总时长的动作片段（内部按 15 秒上限切段 + 用上一段末帧续首帧）。
 * @param {object} o {still, seconds, prompt, dir, index, seed, budget, cfg, log}
 * @returns {Promise<{file:string, segments:number[], spent:number, tasks:string[]}>}
 */
export async function animateScene({
  still, seconds, prompt, negative, dir, index = 0, seed, cfg = config(), s = settings(cfg), log = () => {},
}) {
  const segs = planSegments(seconds, s.maxSeconds)
  if (!segs.length) throw new Error('这一幕时长为 0，没法生成')
  fs.mkdirSync(dir, { recursive: true })
  const parts = []
  const tasks = []
  let frame = still
  for (const [k, sec] of segs.entries()) {
    const out = path.join(dir, `anim-${index}-${k}.mp4`)
    const r = await animate({ firstFrame: frame, prompt, negative, seconds: sec, out, seed, cfg, s, log })
    parts.push(r.file)
    tasks.push(r.taskId)
    if (k < segs.length - 1) {
      frame = path.join(dir, `anim-${index}-${k}.last.jpg`)
      lastFrame(r.file, frame, cfg)
    }
    log(`    片段 ${k + 1}/${segs.length} ✓ ${sec}s（${r.dur.toFixed(1)}s 实际）`)
  }
  const file = path.join(dir, `anim-${index}.mp4`)
  concatClips(parts, file, cfg)
  const spent = segs.reduce((a, b) => a + b, 0)
  return { file, segments: segs, spent, tasks }
}

/** 一段片子到底是不是真片（给 produce 做自检用）。 */
export function inspectClip(file, cfg = config()) {
  try {
    const out = run(ffprobeBin(cfg), ['-v', 'error', '-show_entries',
      'stream=codec_type,width,height,r_frame_rate:format=duration', '-of', 'json', file])
    const j = JSON.parse(out)
    const v = (j.streams || []).find((x) => x.codec_type === 'video') || {}
    const audio = (j.streams || []).some((x) => x.codec_type === 'audio')
    return { width: v.width, height: v.height, fps: v.r_frame_rate, dur: Number(j.format?.duration) || 0, hasAudio: audio }
  } catch { return null }
}

export { ffmpegBin }