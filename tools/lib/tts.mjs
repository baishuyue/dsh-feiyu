// tts —— GPT-SoVITS 语音合成（L0/L1/L2 都在这条链上）
//
// 10-26 主人两轮反馈的产物：
//   「语音和视频里反复出现一句话」→ 参考文本串了旧音色（见 refTextOf）
//   「语音只有略微的语气变化，没有人类情感」→ 情绪三层：
//      L0 参数 + 择优：默认参数 F0 起伏只有 3.02 半音（人声 4.78）；放开切句 + 温度 1.35 一次就到 4.82，
//         但同参数连合 8 条会在 3.5~5.2 之间抽奖，所以还要"多合几条按起伏挑最好"（prosody.mjs 打分）。
//      L1 情绪标签：她的回复带 [[撒娇]] 这类标签 → 换成对应参数/参考段，标签本身不发给主人。
//      L2 情绪参考段：参考音频的起伏就是输出的天花板（yinlang 4.78 → 输出 4.82；sunshine 3.45 → 输出 2.83），
//         所以每种情绪准备一段"她自己的声音 + 有情绪的韵律"放在 ~/.feiyu-ai/voice-emo/，
//         由 `node feiyu.mjs voice emo build` 生成（多合多条挑最活的一条当参考）。
import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.mjs'
import { dataPath } from './paths.mjs'
import { emotionProfile, parseEmotionTag } from './emotion.mjs'
import { scoreWavs, bestOf } from './prosody.mjs'

const PASS_THROUGH = [
  'ref_audio_path', 'prompt_text', 'prompt_lang', 'text_split_method', 'batch_size',
  'top_k', 'top_p', 'temperature', 'speed_factor', 'fragment_interval', 'repetition_penalty',
  'sample_steps', 'cfg_rate', 'seed',
]

/** Windows 上的 GPT-SoVITS api_v2.py 用 GBK 编码文本/日志：任何 GBK 装不下的字符都会让它直接抛
 *  UnicodeEncodeError → /tts 返回 400 "tts failed"（实测：
 *    「(・_・;)」里的 \u30FB → 'gbk' codec can't encode character '\u30fb'
 *    「🐟」→ '\U0001f41f'；纯中文则 200 OK）。
 *  她的回复几乎每条都带颜文字/emoji —— 于是语音**从来没成功过**，全部降级成文字。 */
export function sanitizeForTts(text) {
  const s = String(text ?? '')
  const kept = s.replace(
    /[^\u0020-\u007E\u00B7\u2010-\u2015\u2018\u2019\u201C\u201D\u2026\u3000-\u303F\u3040-\u30FA\u30FC-\u30FF\u4E00-\u9FFF\uFF01-\uFF5E]/g,
    '',
  )
  return kept
    .replace(/[(\[（【][^\p{L}\p{N}]{0,8}[)\]）】]/gu, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s*([，。！？、；：）】」』])\s*/g, '$1')
    .replace(/^[\s，。！？、；：]+|[\s，。！？、；：]+$/g, '')
    .trim()
}

/** 参考文本必须和参考音频是**同一段话**。
 *
 *  10-26 主人报「说话包括做视频都重复出现一句『说好等手伤痊愈了就一起打游戏』」——
 *  旧音色（银狼）的参考文本留在了配置里：ref_audio_path 换成了 yinlang，
 *  prompt_text 还是那句"卡夫卡/手伤/打游戏"，而 yinlang.wav 真正说的是
 *  「战斗体验该优化了，哼就这速度太慢了。」。GPT-SoVITS 拿错文本去对齐参考音频，
 *  于是每次合成都会把这句参考文本**念出来**（实测同一句 42 字：错文本 30.66 秒 / 对文本 8.62 秒）。
 *
 *  防守：模型目录里一般有同名 .txt（参考音频的转写）。它比配置可信 —— 配置是人手填的，
 *  换音色时容易忘了跟着改。只要有 .txt 且内容不同，就用 .txt 的，并报一声。 */
export function refTextOf(refAudioPath) {
  try {
    if (!refAudioPath) return ''
    const dir = path.dirname(String(refAudioPath))
    const base = path.basename(String(refAudioPath)).replace(/\.[^.]+$/, '')
    for (const c of [base + '.txt', base + '.lab']) {
      const f = path.join(dir, c)
      if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim()
    }
    const any = fs.readdirSync(dir).find((f) => f.toLowerCase().endsWith('.txt'))
    if (any) return fs.readFileSync(path.join(dir, any), 'utf8').trim()
  } catch {}
  return ''
}

// ---------- L2：情绪参考段 ----------

export const EMO_DIR = () => dataPath('voice-emo')
export const EMO_MANIFEST = () => path.join(EMO_DIR(), 'manifest.json')

let _emoCache = { at: 0, data: null }
/** 读情绪参考段清单（带 mtime 缓存，`voice emo build` 之后无需重启） */
export function emotionRefs() {
  try {
    const f = EMO_MANIFEST()
    const st = fs.statSync(f)
    if (_emoCache.data && _emoCache.at === st.mtimeMs) return _emoCache.data
    const j = JSON.parse(fs.readFileSync(f, 'utf8'))
    _emoCache = { at: st.mtimeMs, data: j && typeof j === 'object' ? j : {} }
    return _emoCache.data
  } catch {
    return {}
  }
}

/** 为某情绪挑参考音色：情绪库有就用它，否则回落配置里的默认音色。 */
export function pickRef(emotionKey, v = config().voice ?? {}) {
  const lib = emotionRefs()
  const hit = emotionKey && lib[emotionKey]
  if (hit && hit.wav && fs.existsSync(hit.wav)) {
    const truth = refTextOf(hit.wav) || String(hit.text || '')
    return { ref_audio_path: hit.wav, prompt_text: truth, from: 'emotion:' + emotionKey }
  }
  return configRef(v)
}

/** 配置里的默认音色（顺便做参考文本对齐）。 */
export function configRef(v = config().voice ?? {}) {
  const refAudio = v.ref_audio_path || ''
  let prompt = String(v.prompt_text || '')
  const truth = refTextOf(refAudio)
  if (truth && truth !== prompt.trim()) {
    try { console.warn(`[tts] 参考文本与「${path.basename(String(refAudio))}」的转写不符，改用转写：${truth.slice(0, 40)}`) } catch {}
    prompt = truth
  }
  return { ref_audio_path: refAudio, prompt_text: prompt, from: 'config' }
}

/** 候选的参考段池：情绪参考段 + 默认音色一起上，谁合出来更像人就用谁。
 *
 *  10-26 A/B（每种情绪 4 条候选取最好，8 种情绪合计）：
 *    情绪参考段 114.2 分 vs 默认音色 105.0 分 —— 但只在 生气(+4.8)/开心(+5.6)/撒娇(+3.1) 稳赢，
 *    温柔/惊讶/害羞 反而是默认段更好（那几个参考段本身就偏软）。
 *  所以不做"情绪段一定优先"，而是两个参考段都参与候选，让打分决定。 */
export function refPool(emotionKey, v = config().voice ?? {}, override = {}) {
  if (override.ref_audio_path) {
    return [{
      ref_audio_path: override.ref_audio_path,
      prompt_text: override.prompt_text ?? refTextOf(override.ref_audio_path),
      from: 'override',
    }]
  }
  const pool = []
  const lib = emotionRefs()
  const hit = emotionKey && lib[emotionKey]
  if (hit && hit.wav && fs.existsSync(hit.wav)) {
    pool.push({ ref_audio_path: hit.wav, prompt_text: refTextOf(hit.wav) || String(hit.text || ''), from: 'emotion:' + emotionKey })
  }
  const base = configRef(v)
  if (base.ref_audio_path) pool.push(base)
  return pool.length ? pool : [base]
}

// ---------- L0：分块与拼接 ----------

/** 长文本分块：cut0 一次喂整段韵律最连贯，但太长容易漏字/糊，所以按句切到 ~80 字一块。 */
export function splitForTts(text, max = 80) {
  const s = String(text ?? '').trim()
  if (!s) return []
  if (s.length <= max) return [s]
  const out = []
  let buf = ''
  for (const sen of s.match(/[^。！？!?…\n]+[。！？!?…]*/g) || [s]) {
    const t = sen.trim()
    if (!t) continue
    if (buf && (buf + t).length > max) { out.push(buf); buf = '' }
    if (t.length > max) {
      let rest = t
      while (rest.length > max) { out.push(rest.slice(0, max)); rest = rest.slice(max) }
      buf = rest
    } else buf += t
  }
  if (buf) out.push(buf)
  return out.length ? out : [s]
}

function readWavPcm(file) {
  const b = fs.readFileSync(file)
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error('不是 wav：' + file)
  let off = 12
  let fmt = null
  let data = null
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4)
    const size = b.readUInt32LE(off + 4)
    const body = b.subarray(off + 8, off + 8 + size)
    if (id === 'fmt ') {
      fmt = { format: body.readUInt16LE(0), channels: body.readUInt16LE(2), sampleRate: body.readUInt32LE(4), bits: body.readUInt16LE(14) }
    }
    if (id === 'data') data = body
    off += 8 + size + (size % 2)
  }
  if (!fmt || !data) throw new Error('wav 缺 fmt/data：' + file)
  return { fmt, data }
}

/** 把多块 wav 拼成一个（句间留 gapSec 静音）—— 真人说话本来就有停顿。 */
export function concatWav(files, out, gapSec = 0.18) {
  if (!files.length) throw new Error('没有可拼接的音频')
  if (files.length === 1) {
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.copyFileSync(files[0], out)
    return out
  }
  const parts = files.map(readWavPcm)
  const first = parts[0].fmt
  if (first.format !== 1 || first.bits !== 16) throw new Error('只支持 16bit PCM 拼接')
  for (const p of parts) {
    if (p.fmt.sampleRate !== first.sampleRate || p.fmt.channels !== first.channels || p.fmt.bits !== 16) {
      throw new Error('采样格式不一致，无法拼接')
    }
  }
  const frame = first.channels * 2
  const gap = Buffer.alloc(Math.max(0, Math.round(gapSec * first.sampleRate)) * frame)
  const chunks = []
  parts.forEach((p, i) => { if (i) chunks.push(gap); chunks.push(p.data) })
  const data = Buffer.concat(chunks)
  const h = Buffer.alloc(44)
  h.write('RIFF', 0, 'ascii'); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8, 'ascii')
  h.write('fmt ', 12, 'ascii'); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(first.channels, 22)
  h.writeUInt32LE(first.sampleRate, 24); h.writeUInt32LE(first.sampleRate * frame, 28)
  h.writeUInt16LE(frame, 32); h.writeUInt16LE(16, 34)
  h.write('data', 36, 'ascii'); h.writeUInt32LE(data.length, 40)
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, Buffer.concat([h, data]))
  return out
}

// ---------- 单次调用 ----------

async function ttsOnce(text, outFile, { ref, prof, override, v }) {
  const url = v.sovits_url || 'http://127.0.0.1:9880/tts'
  const body = {
    text,
    text_lang: v.text_lang || 'zh',
    media_type: 'wav',
    streaming_mode: false,
    ref_audio_path: ref.ref_audio_path,
    prompt_text: ref.prompt_text,
    prompt_lang: v.prompt_lang || 'zh',
    // cut0 = 不按标点切碎，保留跨句韵律（实测起伏 3.96 → 4.43）；长文本由 splitForTts 先分块
    text_split_method: override.text_split_method || v.text_split_method || 'cut0',
    temperature: Number(override.temperature ?? prof.temperature),
    speed_factor: Number(override.speed_factor ?? prof.speed),
    fragment_interval: Number(override.fragment_interval ?? prof.pause),
  }
  for (const k of PASS_THROUGH) if (v[k] !== undefined && body[k] === undefined) body[k] = v[k]
  for (const k of PASS_THROUGH) if (override[k] !== undefined) body[k] = override[k]

  // 服务偶发掉连接（实测连发 40 条时会出现 fetch failed）——重试两次，别让一条候选毁掉整条消息
  let lastErr = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120000),
      })
      if (!r.ok) throw new Error(`GPT-SoVITS HTTP ${r.status}`)
      const buf = Buffer.from(await r.arrayBuffer())
      if (buf.length < 2000) throw new Error('GPT-SoVITS 返回音频过短（可能合成失败）')
      fs.mkdirSync(path.dirname(outFile), { recursive: true })
      fs.writeFileSync(outFile, buf)
      return outFile
    } catch (e) {
      lastErr = e
      if (attempt < 2) await new Promise((r2) => setTimeout(r2, 400 + attempt * 900))
    }
  }
  throw lastErr
}

// ---------- 对外 ----------

/**
 * 合成一条语音。
 * @param {string} text 要说的话（可含 [[情绪]] 标签，会被解析并去掉）
 * @param {string} [outFile] 输出路径
 * @param {object} [override] emotion / candidates / temperature / speed_factor / text_split_method / detail…
 * @returns {Promise<string>} 音频路径
 */
export async function synth(text, outFile, override = {}) {
  const info = await synthDetailed(text, outFile, override)
  return info.file
}

/** 同 synth，但把"用了哪个情绪、挑了第几条、各候选多少分"一起返回（CLI/测试/日志用）。 */
export async function synthDetailed(text, outFile, override = {}) {
  const v = config().voice ?? {}
  const { emotion: tagged, text: bare } = parseEmotionTag(text)
  const speak = sanitizeForTts(bare)
  if (!speak) throw new Error('文本里全是 GBK 发不出的符号（颜文字/emoji），没有可念的内容')

  const emotionKey = override.emotion ? emotionProfile(override.emotion).key : tagged
  const prof = emotionProfile(emotionKey)
  const pool = refPool(prof.key, v, override)

  const chunks = splitForTts(speak, Number(v.chunkChars) || 80)
  const wantBest = String(v.pick ?? 'best') !== 'first' && override.pick !== 'first'
  let n = Math.max(1, Number(override.candidates ?? v.candidates ?? 3))
  if (!wantBest) n = 1
  // 合成预算：整条消息不超过 9 次调用（1 块×3 条≈8 秒，够快）
  const budget = Math.max(1, Number(v.maxSynthPerMessage) || 9)
  while (chunks.length * n > budget && n > 1) n -= 1

  const tmpDir = dataPath('voice', 'tmp')
  fs.mkdirSync(tmpDir, { recursive: true })
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const made = []
  for (const [ci, chunk] of chunks.entries()) {
    const cands = []
    for (let k = 0; k < n; k++) {
      const ref = pool[k % pool.length]          // 参考段轮流上：情绪段 / 默认段
      const f = path.join(tmpDir, `${tag}-c${ci}-${k}.wav`)
      cands.push({ file: await ttsOnce(chunk, f, { ref, prof, override, v }), refFrom: ref.from })
    }
    made.push({ chunk, cands })
  }

  const all = made.flatMap((m) => m.cands.map((c) => ({ path: c.file, chars: m.chunk.length, rateMin: prof.rateMin, rateMax: prof.rateMax })))
  const scores = all.length > 1 ? scoreWavs(all) : [{ path: all[0].path, ok: true, score: 0 }]
  const byPath = new Map(scores.map((s) => [s.path, s]))
  const chosen = made.map((m) => {
    if (m.cands.length === 1) return m.cands[0]
    const best = bestOf(m.cands.map((c) => byPath.get(c.file) || { path: c.file, ok: false, score: 0 }))
    return m.cands.find((c) => c.file === (best && best.path)) || m.cands[0]
  })

  const file = outFile || dataPath('voice', `${Date.now()}.wav`)
  concatWav(chosen.map((c) => c.file), file, Number(v.chunkGapSec ?? 0.18))

  for (const f of all.map((x) => x.path)) {
    if (chosen.some((c) => c.file === f) || f === file) continue
    try { fs.rmSync(f, { force: true }) } catch {}
  }

  return {
    file,
    emotion: prof.key,
    emotionLabel: prof.label,
    refFrom: chosen.map((c) => c.refFrom).join('+'),
    params: { temperature: Number(override.temperature ?? prof.temperature), speed: Number(override.speed_factor ?? prof.speed), pause: Number(override.fragment_interval ?? prof.pause) },
    chunks: chunks.length,
    candidates: n,
    scores: scores.map((s) => ({ path: path.basename(s.path), ok: s.ok, score: s.score, sd: s.sd, rng: s.rng, why: s.why })),
    chosen: chosen.map((c) => ({ file: path.basename(c.file), ref: c.refFrom })),
  }
}