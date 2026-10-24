// sing —— 唱歌引擎（说唱/念唱版）：LLM 写词 → 她的音色逐句合成 → 配节拍混音 → 一条完整"歌"。
// 诚实说明：GPT-SoVITS 是说话引擎不是歌声合成（SVC 引擎本机没装），所以这里的"唱"
// 是节拍念唱（rap/读唱）—— beat 是纯 JS 合成的鼓机，人声是她本嗓按小节排布。
// 效果类似轻说唱，比干念歌词有"歌感"得多。
import fs from 'node:fs'
import path from 'node:path'
import * as llm from './llm.mjs'
import { synth } from './tts.mjs'
import { dataPath } from './paths.mjs'

// ── WAV 读写（RIFF / PCM16，GPT-SoVITS 输出格式）──────────────────────────
export function readWav(file) {
  const buf = fs.readFileSync(file)
  if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error('不是 WAV：' + file)
  let pos = 12, sampleRate = 32000, channels = 1, bits = 16, dataStart = -1, dataLen = 0
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4)
    const size = buf.readUInt32LE(pos + 4)
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(pos + 10)
      sampleRate = buf.readUInt32LE(pos + 12)
      bits = buf.readUInt16LE(pos + 22)
    } else if (id === 'data') { dataStart = pos + 8; dataLen = Math.min(size, buf.length - dataStart); break }
    pos += 8 + size + (size % 2)
  }
  if (dataStart < 0) throw new Error('WAV 没有 data 块')
  if (bits !== 16) throw new Error('只支持 16bit PCM（实际 ' + bits + '）')
  const n = Math.floor(dataLen / 2 / channels)
  const data = new Float32Array(n)
  for (let i = 0; i < n; i++) data[i] = buf.readInt16LE(dataStart + i * 2 * channels) / 32768
  return { sampleRate, data }
}

export function writeWav(file, sampleRate, data) {
  const n = data.length
  const buf = Buffer.alloc(44 + n * 2)
  buf.write('RIFF', 0, 'ascii'); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8, 'ascii')
  buf.write('fmt ', 12, 'ascii'); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * 2, 28)
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34)
  buf.write('data', 36, 'ascii'); buf.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, data[i]))
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2)
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, buf)
  return file
}

// ── 鼓机：kick / hihat / snare（纯波形合成，无采样文件）────────────────────
function kick(sr, at, out, gain = 0.9) {
  const len = Math.floor(sr * 0.22)
  let phase = 0
  for (let i = 0; i < len; i++) {
    const t = i / sr
    const f = 110 * Math.exp(-t * 18) + 45
    phase += (2 * Math.PI * f) / sr
    const env = Math.exp(-t * 12)
    const idx = at + i
    if (idx < out.length) out[idx] += Math.sin(phase) * env * gain
  }
}
function hihat(sr, at, out, gain = 0.16) {
  const len = Math.floor(sr * 0.05)
  let seed = 12345
  for (let i = 0; i < len; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    const noise = (seed / 0x3fffffff - 1)
    const env = Math.exp(-(i / sr) * 90)
    const idx = at + i
    if (idx < out.length) out[idx] += noise * env * gain
  }
}
function snare(sr, at, out, gain = 0.35) {
  const len = Math.floor(sr * 0.16)
  let seed = 6789
  for (let i = 0; i < len; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    const noise = (seed / 0x3fffffff - 1)
    const t = i / sr
    const env = Math.exp(-t * 22)
    const tone = Math.sin(2 * Math.PI * 185 * t) * 0.5
    const idx = at + i
    if (idx < out.length) out[idx] += (noise * 0.6 + tone) * env * gain
  }
}

/** 合成 N 小节 4/4 beat。返回 Float32Array。 */
export function synthBeat(bpm, bars, sr) {
  const beatLen = 60 / bpm
  const total = Math.ceil(bars * 4 * beatLen * sr)
  const out = new Float32Array(total)
  for (let bar = 0; bar < bars; bar++) {
    for (let b = 0; b < 4; b++) {
      const at = Math.floor((bar * 4 + b) * beatLen * sr)
      if (b === 0 || b === 2) kick(sr, at, out)
      if (b === 1 || b === 3) { snare(sr, at, out); kick(sr, Math.floor(at + beatLen * 0.5 * sr), out, 0.4) }
      hihat(sr, at, out)
      hihat(sr, Math.floor(at + beatLen * 0.5 * sr), out, 0.5)
    }
  }
  return out
}

// ── 唱歌管线 ────────────────────────────────────────────────────────────────
/**
 * 让她"唱"一段：LLM 写词（鱼味歌词）→ 逐句用她的音色合成 → 按小节排布配 beat 混音。
 * @param {string} theme 主人点的主题（"唱首关于白饭的歌"→ 主题"白饭"），空则自由发挥
 * @returns {Promise<{file: string, title: string, lyrics: string[]}>}
 */
export async function sing(theme = '') {
  // ① 写词
  const msgs = [
    { role: 'system', content: '你是"大肥鱼"，一条圆滚滚的蓝鲸鱼娘，爱吃白饭、会撒娇、有点傲娇。现在要写一首超短的说唱歌词。只输出 JSON：'
      + '{"title":"歌名，≤8字","bpm":66到96的整数（慢=抒情快=活泼）,"lyrics":["每句5~10字，共6~8句，口语押韵，有鱼的生活细节（白饭/游泳/主人/刷视频）"]}' },
    { role: 'user', content: (theme ? `主题：${theme}。` : '自由发挥（今天的心情/最近看到的视频）。') + '\n写一首她的说唱：' },
  ]
  let title = '鱼的小曲', bpm = 76, lyrics = []
  try {
    const j = await llm.jsonChat(msgs, '{title:string,bpm:number,lyrics:string[]}', { temperature: 1.0 })
    title = String(j?.title || title).slice(0, 12)
    bpm = Math.max(60, Math.min(100, Number(j?.bpm) || 76))
    lyrics = (Array.isArray(j?.lyrics) ? j.lyrics : []).map(s => String(s).slice(0, 14)).filter(Boolean).slice(0, 8)
  } catch { /* 写词失败用兜底词 */ }
  if (lyrics.length < 2) lyrics = ['今天也想吃白饭', '三大碗都不够', '主人快去煮饭', '本鱼饿得游不动']

  // ② 逐句合成（她的音色；失败抛给上层降级）
  const voices = []
  let sr = 0
  for (const line of lyrics) {
    const f = await synth(line)
    const wav = readWav(f)
    sr = wav.sampleRate
    voices.push(wav.data)
    fs.rmSync(f, { force: true })   // 临时句文件不留
  }

  // ③ 排布：每句占 ceil(句长/小节) 个小节，句间留半拍气口
  const barLen = (60 / bpm) * 4 * sr
  const gap = Math.floor((60 / bpm) * 0.5 * sr)
  const slots = []
  let cursor = Math.floor(barLen * 0.5)   // 前奏半小节
  for (const v of voices) {
    slots.push({ at: cursor, data: v })
    const bars = Math.max(1, Math.ceil((v.length + gap) / barLen))
    cursor += Math.floor(bars * barLen)
  }
  const total = cursor + Math.floor(barLen * 1.2)   // 尾奏

  // ④ 混音：beat 底 + 人声
  const mix = new Float32Array(total)
  const beat = synthBeat(bpm, Math.ceil(total / barLen) + 1, sr)
  for (let i = 0; i < Math.min(beat.length, total); i++) mix[i] += beat[i] * 0.5
  for (const s of slots) {
    for (let i = 0; i < s.data.length && s.at + i < total; i++) mix[s.at + i] += s.data[i] * 1.0
  }
  // 首尾淡出 + 软限幅
  const fade = Math.floor(sr * 0.3)
  for (let i = 0; i < fade; i++) mix[i] *= i / fade
  for (let i = 0; i < fade; i++) mix[total - 1 - i] *= i / fade
  for (let i = 0; i < total; i++) mix[i] = Math.tanh(mix[i] * 0.9)

  const file = dataPath('voice', `song-${Date.now()}.wav`)
  writeWav(file, sr, mix)
  return { file, title, lyrics, bpm }
}
