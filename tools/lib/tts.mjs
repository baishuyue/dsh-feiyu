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
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { config } from './config.mjs'
import { dataPath } from './paths.mjs'
import { emotionProfile, parseEmotionTag } from './emotion.mjs'
import { scoreWavs, bestOf } from './prosody.mjs'
import { voicedSeconds } from './video.mjs'

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

/**
 * 参考段的"文本 / 语音段"配比体检 —— 这是 10-26 那次"配音漏字"的真正病根。
 *
 * GPT-SoVITS 用 prompt_text 去对齐 ref 音频；文本只覆盖音频的一小段时，模型会把
 * "文本已经念完"当成收尾信号 → 每次生成都在句子中途 EOS（实测覆盖率恒定 46%，是系统性错配）。
 *
 * ⚠️ 10-27 修正：**配比不能用整个文件的时长算**。音声素材都是从长音频里剪出来的，
 *   前后留着大段留白 —— 实测 bingjiao2.wav 全长 6.19s 里 3.64s 是静音，真正在说话的
 *   只有 2.55s，11 个字配 2.55s 就是正常语速（配比 1.07）。旧算法拿 6.19s 算出 2.59，
 *   把它判成"不合格"，于是 bingjiao1~4 / yinlang 五条参考段**全被误杀**，
 *   她的基础音色从语音链上消失了 —— 聊天语音只能落到情绪段池，而池子里 8 条音高
 *   从 244Hz 到 286Hz 不等，候选各用一条 → 一句里音色乱跳，"不是她的声音"。
 *   所以配比按**真正有声的累加时长**算（静音、停顿都不算），而且不能用"第一声到最后一声"：
 *   音声素材两端常有剪辑咔哒，一帧爆音就能把跨度顶满（bingjiao2 就是这样把 2.0 秒的话
 *   量成 6.16 秒）。量法在 video.mjs 的 voicedSeconds()。
 *
 * @returns {{dur:number, speech:number, chars:number, ratio:number, ratioFile:number, ok:boolean, why:string}}
 */
export function refSanity(refAudioPath, promptText = '') {
  const out = { dur: 0, speech: 0, chars: 0, ratio: 0, ratioFile: 0, ok: true, why: '' }
  try {
    if (!refAudioPath) return { ...out, ok: false, why: '没有参考音频' }
    const text = String(promptText || refTextOf(refAudioPath) || '')
    out.chars = text.replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '').length
    // 体检要解码一遍音频，热路径上（每条消息都过）得缓存：同文件同文本只量一次
    const key = out.chars ? sanityKey(refAudioPath, out.chars) : ''
    const hit = key ? _sanityCache.get(key) : null
    if (hit) return { ...hit }
    out.dur = probeSeconds(refAudioPath)
    if (!out.dur || !out.chars) return { ...out, ok: false, why: '参考音频或文本读不出来' }
    out.speech = speechSeconds(refAudioPath, out.dur)
    out.ratio = +(out.speech / (out.chars / 4.6)).toFixed(2)
    out.ratioFile = +(out.dur / (out.chars / 4.6)).toFixed(2)
    // 4.6 字/秒 ≈ 她的正常语速；配比落在 0.5~1.8 之间才算"这段音频就是这句话"
    out.ok = out.ratio >= 0.5 && out.ratio <= 1.8
    out.why = out.ok ? '' : `文本/语音段配比 ${out.ratio}（${out.chars} 字配 ${out.speech.toFixed(1)}s）—— 模型会念一半就收尾`
    if (key) { if (_sanityCache.size > 200) _sanityCache.clear(); _sanityCache.set(key, { ...out }) }
  } catch (e) { out.ok = false; out.why = '体检失败：' + String(e.message).slice(0, 40) }
  return out
}

const _sanityCache = new Map()
function sanityKey(file, chars) {
  try { const st = fs.statSync(file); return `${path.resolve(file)}|${st.mtimeMs}|${st.size}|${chars}` } catch { return '' }
}

/** 语音段时长（真正有声的累加，静音/停顿不算）。量不出来就回落到整段 —— 宁可放过，不要误杀她的音色。 */
function speechSeconds(file, dur = 0) {
  try {
    const v = voicedSeconds(file)
    if (v > 0.25 && v <= dur + 0.25) return v
  } catch {}
  return dur
}

/** 音频时长（秒）。ffprobe 优先（这台机器 PATH 里没有，得试已知路径），再退 python/soundfile。 */
function probeSeconds(file) {
  const v = config().voice ?? {}
  const cands = [v.ffprobe, config().video?.ffprobe, 'D:/rvc/bin/ffprobe.exe',
    'D:/GPT-SoVITS/runtime/ffprobe.exe', 'ffprobe'].filter(Boolean)
  for (const bin of cands) {
    try {
      if (bin !== 'ffprobe' && !fs.existsSync(bin)) continue
      const buf = execFileSync(bin, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
        { encoding: 'utf8', timeout: 20_000, windowsHide: true })
      const d = Number(String(buf).trim())
      if (d > 0) return d
    } catch {}
  }
  try {
    const buf = execFileSync(pythonPath(),
      ['-c', 'import sys,soundfile as sf;print(round(float(sf.info(sys.argv[1]).duration),3))', file],
      { encoding: 'utf8', timeout: 30_000, windowsHide: true })
    return Number(String(buf).trim()) || 0
  } catch { return 0 }
}

/** 候选参考段池 —— **一句话只用一个音色**。
 *
 *  10-26 的做法是"情绪段 + 默认段一起上，谁合出来更像人用谁"。10-27 主人拍板改了：
 *  候选之间可以换采样运气，**不许换嗓子**。同一句话的三个候选如果各用一个参考段，
 *  择优就不是"挑念得最好的那条"，而是"挑哪个音色顺耳" —— 听感上音高逐句乱跳，
 *  正是"不是她的声音"的来源。所以：
 *    · 标了情绪 → 用该情绪的参考段（同一个人的不同语气，音高本来就是设计的一部分）
 *    · 没标情绪（calm）→ 用配置里的**基础音色**（bingjiao2，244Hz）
 *    · 主参考体检不合格 → 兜底也**只挑一条**，不再把整库丢进池子
 */
export function refPool(emotionKey, v = config().voice ?? {}, override = {}) {
  const pool = refPoolRaw(emotionKey, v, override)
  const good = pool.filter((p) => refSanity(p.ref_audio_path, p.prompt_text).ok)
  if (good.length) return [good[0]]
  if (override.ref_audio_path) return [pool[0]]   // 显式指定就照办，不替她挑
  // 主参考不合格 → 换成她自己的情绪参考段（嗓子是同一个人，只是文本配得上音频）
  const fb = bestEmotionRef(emotionKey)
  if (fb) {
    if (!globalThis.__feiyuRefWarned) {
      globalThis.__feiyuRefWarned = true
      console.warn('[tts] 这条参考段的文本配不上音频，已改用她的情绪参考段（嗓子不变）')
    }
    return [fb]
  }
  return [pool[0]]
}

/** 兜底挑**一条**她自己的情绪参考段。
 *
 *  旧代码这里是 `emoGood[emotionKey]` —— 数组拿字符串当下标取，永远是 undefined，
 *  于是每次都退回"整库 8 条"。修好取值的同时把返回值收敛成一条。 */
export function bestEmotionRef(emotionKey = '') {
  const lib = emotionRefs() || {}
  const usable = []
  for (const [k, val] of Object.entries(lib)) {
    for (const e of Array.isArray(val) ? val : [val]) {
      if (!e || !e.wav || !fs.existsSync(e.wav)) continue
      const text = refTextOf(e.wav) || String(e.text || '')
      if (!refSanity(e.wav, text).ok) continue
      usable.push({ key: k, wav: e.wav, text, score: Number(e.score) || 0 })
    }
  }
  if (!usable.length) return null
  const same = usable.find((u) => u.key === String(emotionKey || ''))
  if (same) return { ref_audio_path: same.wav, prompt_text: same.text, from: 'emo-fallback:' + same.key }
  // 没有同名情绪段时的次序：贴近她日常嗓音的那几种先上（F0 251~256Hz，离 bingjiao2 的 244 最近），
  // 高唤醒的（惊讶/生气/开心）排后面 —— 兜底是"实在没参考可用了"，不该一上来就在喊。
  const ORDER = ['sleepy', 'wronged', 'shy', 'coquettish', 'tender', 'happy', 'angry', 'surprise']
  const rank = (k) => { const i = ORDER.indexOf(k); return i < 0 ? ORDER.length : i }
  const best = usable.slice().sort((a, b) => rank(a.key) - rank(b.key) || b.score - a.score)[0]
  return { ref_audio_path: best.wav, prompt_text: best.text, from: 'emo-fallback:' + best.key }
}

function refPoolRaw(emotionKey, v = config().voice ?? {}, override = {}) {
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
      const ref = pool[0]                        // 一句话一个音色：候选共用同一条参考段，只换采样运气
      const f = path.join(tmpDir, `${tag}-c${ci}-${k}.wav`)
      cands.push({ file: await ttsOnce(chunk, f, { ref, prof, override, v }), refFrom: ref.from })
    }
    made.push({ chunk, cands })
  }

  // 10-27：候选怎么挑，决定"像不像她"。老的打分偏爱"音域宽、F0 起伏大"的那条 ——
// 三条里最抖的一条永远赢，听感就是颤音/电音。现在默认改**保真择优**：
//   · 有锚（视频线，override.registerRef）→ 音区贴本片中位 + 不抖不噪；
//   · 没锚（聊天线）→ 只比"抖不抖、噪不噪"，不按起伏加分，也不拿参考段当音区锚
//     （参考段是一句情绪很高的音声，比正常说话高 7 个半音，锚它会把声音往上拽）。
// config 里 voice.fidelity=false 可以退回老行为。
const fidelity = override.fidelity !== undefined ? !!override.fidelity : config().voice?.fidelity !== false
  const all = made.flatMap((m) => m.cands.map((c) => ({
    path: c.file, chars: m.chunk.length, rateMin: prof.rateMin, rateMax: prof.rateMax,
    ref: override.registerRef ? pool[0]?.ref_audio_path : undefined,
    fidelity,
  })))
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