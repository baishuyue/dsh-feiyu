// 参考段清洗 —— 把"音声剪出来"的参考音频里的大段死空气挤掉，只留说话和自然气口。
//
// 为什么必须做（10-27 实测，同一句话、同一参数，只换参考段）：
//   bingjiao2.wav 原样 6.19s，实际说话只有 2.03s，中间还夹着 **2.88 秒死空气**。
//   GPT-SoVITS 拿它当条件 → 合成语音的长时谱和参考的相似度只有 0.703（听感就是"不是她"）。
//   把死空气挤掉、完整句拼成 3.53s 再合成 → 相似度 0.998、HNR 4.0→5.2dB、抖动 0.267→0.233。
//   所以"参考段必须先洗干净"和"文本必须盖住音频"一样，是硬前置。
//
// 做法（不改音高、不改语速、只重排时间轴）：
//   10ms 包络 → 阈值取峰值的 6% → 有声段之间的间隔 ≤0.35s 视为句内停顿（原样保留）；
//   更长的间隔挤成 0.12s 气口；首尾静音剪掉，尾部留 0.25s。
//   GPT-SoVITS 的 api_v2 要求参考音频 ≥3 秒，不够就补尾部静音（补静音比夹死空气安全得多）。
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { config } from './config.mjs'
import { ffmpegBin } from './video.mjs'

const WIN = 0.01
const TH = 0.06
const MERGE = 0.35     // ≤0.35s 的间隔算句内停顿，保留
const KEEP = 0.12      // 长间隔挤成这么长的气口
const TAIL = 0.25
const MIN_REF = 3.0

function env(file) {
  const buf = execFileSync(ffmpegBin(), ['-v', 'quiet', '-i', file, '-ac', '1', '-ar', '32000', '-f', 's16le', '-'],
    { maxBuffer: 256 * 1024 * 1024, windowsHide: true })
  const pcm = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2))
  const n = 320
  const out = []
  for (let i = 0; i + n <= pcm.length; i += n) {
    let s = 0
    for (let j = i; j < i + n; j++) s += pcm[j] * pcm[j]
    out.push(Math.sqrt(s / n) / 32768)
  }
  return { env: out, dur: pcm.length / 32000 }
}

/** 算出要保留的时间片 [[start,end], …]（秒）。 */
export function planPieces(file, { merge = MERGE, keep = KEEP, tail = TAIL } = {}) {
  const { env: e, dur } = env(file)
  const peak = e.reduce((a, b) => Math.max(a, b), 0)
  if (!(peak > 0)) return { pieces: [[0, dur]], dur, speech: 0, removed: 0 }
  const th = peak * TH
  const runs = []
  let cur = null
  for (let i = 0; i < e.length; i++) {
    if (e[i] > th) {
      if (!cur) cur = { start: i, end: i }
      else cur.end = i
    } else if (cur && (i - cur.end) * WIN > merge) {
      runs.push(cur)
      cur = null
    }
  }
  if (cur) runs.push(cur)
  if (!runs.length) return { pieces: [[0, dur]], dur, speech: 0, removed: 0 }
  // 相邻 run 的间隔 ≤merge 的直接当一个整体（保留原停顿）；否则挤成 keep
  const pieces = []
  let start = Math.max(0, runs[0].start * WIN - 0.03)
  let prevEnd = runs[0].end * WIN
  let speech = (runs[0].end - runs[0].start + 1) * WIN
  for (const r of runs.slice(1)) {
    speech += (r.end - r.start + 1) * WIN
    const gap = r.start * WIN - prevEnd
    if (gap <= merge) { prevEnd = r.end * WIN; continue }
    pieces.push([start, Math.min(dur, prevEnd + 0.05)])
    start = Math.max(0, r.start * WIN - keep / 2)
    prevEnd = r.end * WIN
  }
  pieces.push([start, Math.min(dur, prevEnd + 0.06 + tail)])
  const kept = pieces.reduce((a, [s, t]) => a + (t - s), 0)
  return { pieces, dur, speech: +speech.toFixed(2), removed: +(dur - kept).toFixed(2) }
}

/**
 * 清洗参考段：写 <base>-clean.wav，返回 {file, text, dur, speech, removed, padded}。
 * @param {string} src 原参考音频
 * @param {{text?:string, out?:string}} [opt]
 */
export function compactRef(src, opt = {}) {
  const dir = path.dirname(src)
  const base = path.basename(src).replace(/\.[^.]+$/, '')
  const out = opt.out || path.join(dir, `${base}-clean.wav`)
  const textFile = src.replace(/\.[^.]+$/, '.txt')
  const text = opt.text || (fs.existsSync(textFile) ? fs.readFileSync(textFile, 'utf8').trim() : '')
  const plan = planPieces(src)
  const tmp = []
  fs.mkdirSync(path.dirname(out), { recursive: true })
  try {
    plan.pieces.forEach(([s, t], i) => {
      const f = out.replace(/\.wav$/, `.piece${i}.wav`)
      execFileSync(ffmpegBin(), ['-v', 'error', '-y', '-ss', s.toFixed(3), '-t', (t - s).toFixed(3), '-i', src,
        '-ac', '1', '-ar', '32000', f], { windowsHide: true })
      tmp.push(f)
    })
    const list = out.replace(/\.wav$/, '.concat.txt')
    fs.writeFileSync(list, tmp.map((f) => `file '${f.replace(/\\/g, '/')}'`).join('\n'), 'utf8')
    execFileSync(ffmpegBin(), ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-ac', '1', '-ar', '32000', out],
      { windowsHide: true })
    fs.rmSync(list, { force: true })
    let dur = probeDur(out)
    let padded = false
    if (dur < MIN_REF) {
      const f2 = out.replace(/\.wav$/, '.pad.wav')
      execFileSync(ffmpegBin(), ['-v', 'error', '-y', '-i', out, '-af', `apad=pad_dur=${(MIN_REF - dur + 0.1).toFixed(2)}`,
        '-ac', '1', '-ar', '32000', f2], { windowsHide: true })
      fs.renameSync(f2, out)
      dur = probeDur(out)
      padded = true
    }
    if (text) fs.writeFileSync(out.replace(/\.wav$/, '.txt'), text, 'utf8')
    return { file: out, text, dur, speech: plan.speech, removed: plan.removed, pieces: plan.pieces.length, padded }
  } finally {
    for (const f of tmp) { try { fs.rmSync(f, { force: true }) } catch {} }
  }
}

function probeDur(file) {
  const cfg = config()
  for (const bin of [cfg.video?.ffprobe, 'D:/rvc/bin/ffprobe.exe']) {
    if (!bin) continue
    try {
      const out = execFileSync(bin, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
        { encoding: 'utf8', windowsHide: true })
      const d = parseFloat(String(out).trim())
      if (d > 0) return d
    } catch {}
  }
  try {
    const e = execFileSync(ffmpegBin(cfg), ['-v', 'info', '-i', file, '-f', 'null', '-'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const m = String(e).match(/Duration: (\d+):(\d+):([\d.]+)/)
    if (m) return (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3])
  } catch {}
  return 0
}