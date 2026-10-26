// 真视频引擎（10-26 第 17 轮）—— 上一版 produce 是"一张图 + 旁白"，主人点名要升级。
//
// 这一版一条片子由这些零件组成（全是本地 ffmpeg 能做的真东西，不靠付费视频 API）：
//   片头卡（黑底 + 标题 + 她的名字） → 5~8 幕（每幕两帧连拍 + 各有各的运镜）
//   → 幕间转场（交替：淡入/滑入/擦除/圆开） → 逐句字幕（ASS 烧制）
//   → 她的配音（逐句 TTS，响度统一到 -16 LUFS） → BGM（本地合成，侧链ducking：她一说话音乐就退）
//   → 片尾卡（署名） → 1080p H.264 成片 + 封面
//
// 为什么不用"AI 视频 API"：这台机器只有虚拟显卡（GameViewer/MuMu 适配器），本地跑不动
// SVD/AnimateDiff；即梦/可灵要付费 key。所以"动"来自剪辑：多机位、运镜、双帧、转场、
// 字幕节奏、配乐 —— 观众看到的是**剪出来的片子**，不是一张图拉长。
//
// 时间轴（唯一真相，所有事都照它算）：
//   每幕时长 dᵢ = lead + 配音时长 + tail          （lead 留给进画面，tail 留给转场）
//   转场重叠 ov（0.5s 级），第 i 幕在成片里的起点 startᵢ = Σ_{j<i} dⱼ − ov·i
//   片头卡 T_intro、片尾卡 T_outro 各算一段，也参与同一条 xfade 链
//   配音起始时刻 = startᵢ + lead（落在转场之后，绝不被转场切掉）
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import { config } from './config.mjs'
import { dataPath } from './paths.mjs'

const FFMPEG_FALLBACKS = ['D:/rvc/bin/ffmpeg.exe', 'D:/GPT-SoVITS/runtime/ffmpeg.exe', 'ffmpeg']
const FFPROBE_FALLBACKS = ['D:/rvc/bin/ffprobe.exe', 'D:/GPT-SoVITS/runtime/ffprobe.exe', 'ffprobe']

/**
 * 选 ffmpeg：video.ffmpeg → D:/rvc/bin（实测可用）→ rvc.ffmpeg（那是给换声用的，
 * 顺位排在后面）→ GPT-SoVITS runtime → PATH。
 */
export function ffmpegBin(cfg = config()) {
  const cands = [cfg.video?.ffmpeg, FFMPEG_FALLBACKS[0], cfg.rvc?.ffmpeg, FFMPEG_FALLBACKS[1], 'ffmpeg']
  for (const c of cands.filter(Boolean)) {
    try { if (c === 'ffmpeg' || fs.existsSync(c)) return c } catch {}
  }
  return 'ffmpeg'
}

export function ffprobeBin(cfg = config()) {
  for (const c of [cfg.video?.ffprobe, ...FFPROBE_FALLBACKS].filter(Boolean)) {
    try { if (c === 'ffprobe' || fs.existsSync(c)) return c } catch {}
  }
  return 'ffprobe'
}

/** 跑一条 ffmpeg/ffprobe（失败把 stderr 尾巴带出来 —— 静默失败最坑）。 */
export function run(bin, args, { timeout = 600_000, cfg = config() } = {}) {
  try {
    return execFileSync(bin, args, { encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
  } catch (e) {
    const tail = String(e?.stderr || e?.stdout || e?.message || '').trim().split('\n').slice(-4).join(' | ')
    throw new Error(`${path.basename(bin)} 失败：${tail.slice(0, 400)}`)
  }
}

export function ff(args, opts) {
  return run(ffmpegBin(opts?.cfg), ['-hide_banner', '-loglevel', 'error', '-y', ...args], opts)
}

/** 时长（秒）；读不出来返回 0。 */
export function probeDur(file, cfg = config()) {
  try {
    const out = run(ffprobeBin(cfg), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file])
    return Number(String(out).trim()) || 0
  } catch { return 0 }
}

// ── 平台规格 ────────────────────────────────────────────────────────────────
export const PLATFORMS = {
  bili: { key: 'bili', label: 'B站', w: 1920, h: 1080, fps: 30, ov: 0.6, crf: 18, lead: 0.4, tail: 0.9, intro: 3.0, outro: 2.4 },
  douyin: { key: 'douyin', label: '抖音', w: 1080, h: 1920, fps: 30, ov: 0.45, crf: 20, lead: 0.35, tail: 0.8, intro: 2.4, outro: 2.0 },
}

export function specOf(platform) {
  return PLATFORMS[platform] || PLATFORMS.bili
}

// ── 运镜 ────────────────────────────────────────────────────────────────────
// zoompan 的表达式：z 是缩放，x/y 是取景窗左上角，on 是输出帧序号。
// ⚠️ zoompan 里没有 D 变量（有 duration，但拿帧数更稳）：平移要用的总帧数直接写进表达式，
//    写成 `...*(1-on/D)` 会报 "Undefined constant or missing '(' in 'D)'"。
const MOVES = {
  in:    (n) => ({ z: 'min(1.02+0.0011*on,1.17)', x: 'iw/2-(iw/zoom/2)', y: 'ih/2-(ih/zoom/2)' }),
  out:   (n) => ({ z: 'max(1.17-0.0011*on,1.02)', x: 'iw/2-(iw/zoom/2)', y: 'ih/2-(ih/zoom/2)' }),
  left:  (n) => ({ z: '1.10', x: `(iw-iw/zoom)*(1-on/${n})`, y: 'ih/2-(ih/zoom/2)' }),
  right: (n) => ({ z: '1.10', x: `(iw-iw/zoom)*(on/${n})`, y: 'ih/2-(ih/zoom/2)' }),
  up:    (n) => ({ z: '1.10', x: 'iw/2-(iw/zoom/2)', y: `(ih-ih/zoom)*(1-on/${n})` }),
  down:  (n) => ({ z: '1.10', x: 'iw/2-(iw/zoom/2)', y: `(ih-ih/zoom)*(on/${n})` }),
}
export const MOVE_KEYS = Object.keys(MOVES)

/** 幕与幕之间交替用的转场（xfade 的 transition 名）。 */
const TRANSITIONS = ['fade', 'smoothleft', 'fadeblack', 'smoothup', 'wipeleft', 'circleopen', 'slideleft', 'fadegrays']
export function transitionAt(i) {
  return TRANSITIONS[i % TRANSITIONS.length]
}

/**
 * 把一张图渲染成一段"会动的镜头"（静图 → 运镜 + 轻微呼吸），无音轨。
 * @param {object} o {img,out,dur,w,h,fps,move,zoom}
 */
export function renderShot({ img, out, dur, w, h, fps = 30, move = 'in', cfg = config() }) {
  const frames = Math.max(2, Math.round(dur * fps))
  const m = (MOVES[move] || MOVES.in)(frames)
  // 源图先放大再 crop，zoompan 才不会啃到边缘黑边（B站 1080p 用 2x 超采样）
  // ⚠️ crop 的宽高分隔符是冒号（3840:2160），写成 3840x2160 会被当表达式解析 → Invalid chars 'x2160'
  const vf = [
    `scale=${w * 2}:${h * 2}:force_original_aspect_ratio=increase`,
    `crop=${w * 2}:${h * 2}`,
    `zoompan=z='${m.z}':x='${m.x}':y='${m.y}':d=${frames}:s=${w}x${h}:fps=${fps}`,
    'setsar=1',
    'format=yuv420p',
  ].join(',')
  ff(['-loop', '1', '-t', String(dur), '-i', img, '-vf', vf,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-an', out], { cfg })
  return out
}

/** 标题卡/署名卡：纯色底 + 居中叠字（drawtext + 微软雅黑粗体，淡入）。 */
export function renderCard({ out, dur, w, h, fps = 30, lines = [], bg = '0x0b1220', cfg = config() }) {
  const font = fontFile(cfg)
  const draws = lines.filter((ln) => ln && ln.text).map((ln, i) => {
    const size = Number(ln.size) || Math.round(h * 0.085)
    const y = ln.y != null ? Math.round(ln.y) : Math.round(h * 0.34 + i * size * 1.45)
    const color = ln.color || 'white'
    const text = escapeDrawText(String(ln.text))
    return `drawtext=fontfile='${filterPath(font)}':text='${text}':fontcolor=${color}:fontsize=${size}`
      + `:x=(w-text_w)/2:y=${y}:alpha='if(lt(t,0.45),t/0.45,1)'`
  })
  const graph = `[0:v]${draws.length ? draws.join(',') : 'null'}[v]`
  ff(['-f', 'lavfi', '-i', `color=c=${bg}:s=${w}x${h}:d=${dur}:r=${fps}`, '-filter_complex', graph,
    '-map', '[v]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-an', out], { cfg })
  return out
}

export function fontFile(cfg = config()) {
  const cands = [cfg.video?.font, 'C:/Windows/Fonts/msyhbd.ttc', 'C:/Windows/Fonts/msyh.ttc', 'C:/Windows/Fonts/simhei.ttf']
    .filter(Boolean)
  for (const c of cands) {
    try { if (fs.existsSync(c)) return c } catch {}
  }
  return cands[0]
}

/** drawtext 的转义：冒号、单引号、反斜杠、百分号都要处理，否则滤镜串直接炸。 */
export function escapeDrawText(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/%/g, '\\%')
    .replace(/\n/g, '\\n')
}

/** 滤镜里用的路径（Windows 盘符的冒号要转义）。 */
export function filterPath(p) {
  return String(p).replace(/\\/g, '/').replace(/:/g, '\\:')
}

// ── 时间轴 ──────────────────────────────────────────────────────────────────
/**
 * @param {Array<{voiceDur:number}>} scenes
 * @param {object} spec 平台规格
 * @param {{intro?:number, outro?:number}} extra 片头/片尾时长（0 = 不要）
 */
export function buildTimeline(scenes, spec, extra = {}) {
  const intro = extra.intro ?? spec.intro
  const outro = extra.outro ?? spec.outro
  const ov = spec.ov
  const durs = scenes.map((s) => Math.max(1.2, spec.lead + Number(s.voiceDur || 0) + spec.tail))
  const clips = []
  let t = 0
  if (intro > 0) { clips.push({ kind: 'intro', dur: intro, start: 0 }); t = intro }
  const starts = []
  for (const [i, d] of durs.entries()) {
    const start = i === 0 ? (intro > 0 ? intro - ov : 0) : starts[i - 1] + durs[i - 1] - ov
    starts.push(start)
    clips.push({ kind: 'scene', index: i, dur: d, start })
  }
  const lastScene = clips.filter((c) => c.kind === 'scene').pop()
  if (outro > 0) clips.push({ kind: 'outro', dur: outro, start: lastScene.start + lastScene.dur - ov })
  const total = clips[clips.length - 1].start + clips[clips.length - 1].dur
  return { intro, outro, ov, durs, starts, clips, total }
}

// ── 字幕（ASS）──────────────────────────────────────────────────────────────
function assTime(sec) {
  const t = Math.max(0, sec)
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = Math.floor(t % 60)
  const cs = Math.round((t - Math.floor(t)) * 100)
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(Math.min(99, cs)).padStart(2, '0')}`
}

function assEscape(s) {
  return String(s || '').replace(/[{}]/g, '').replace(/\r?\n/g, '\\N')
}

/**
 * 逐句字幕：一拍一句，落在配音的准确时刻（时间轴算出来的，不是猜的）。
 * 底部安全区 + 黑描边 —— 竖屏横屏都好读。
 */
export function buildAss({ scenes, timeline, spec, title = '', brand = '' }) {
  const size = Math.round(spec.h * 0.052)
  const marginV = Math.round(spec.h * 0.085)
  const head = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${spec.w}`,
    `PlayResY: ${spec.h}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Say,Microsoft YaHei,${size},&H00FFFFFF,&H00FFFFFF,&H00101010,&H64000000,-1,0,0,0,100,100,0.4,0,1,${Math.round(size * 0.09)},1,2,${Math.round(spec.w * 0.08)},${Math.round(spec.w * 0.08)},${marginV},1`,
    `Style: Mark,Microsoft YaHei,${Math.round(spec.h * 0.13)},&H00FFFFFF,&H00FFFFFF,&H00101010,&H64000000,-1,0,0,0,100,100,1,0,1,3,2,2,40,40,40,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ]
  const ev = []
  if (timeline.intro > 0) {
    if (title) ev.push(`Dialogue: 0,${assTime(0.35)},${assTime(timeline.intro - 0.15)},Mark,,0,0,0,,${assEscape(title)}`)
    if (brand) ev.push(`Dialogue: 0,${assTime(0.6)},${assTime(timeline.intro - 0.1)},Say,,0,0,0,,${assEscape(brand)}`)
  }
  scenes.forEach((sc, i) => {
    const line = String(sc.line || '').trim()
    if (!line) return
    const start = timeline.starts[i] + spec.lead
    const end = start + Math.max(0.8, Number(sc.voiceDur || 0) - 0.08)
    ev.push(`Dialogue: 1,${assTime(start)},${assTime(end)},Say,,0,0,0,,${assEscape(line)}`)
  })
  return head.concat(ev).join('\n') + '\n'
}

// ── BGM：本地合成，不碰版权 ─────────────────────────────────────────────────
/**
 * 一条温柔的垫底音乐：慢和弦（正弦+三角泛音，长 attack/release）+ 稀疏琶音。
 * 目的不是好听，是"有人在片子里呼吸"—— 人声一出来它就得让位（侧链压缩）。
 */
export function makeBgm({ out, dur = 30, sr = 44100, mood = 'warm', cfg = config() }) {
  void cfg
  const n = Math.ceil(dur * sr) + sr
  const buf = new Float32Array(n)
  // 和弦进行（频率 Hz）：Am9 → Fmaj7 → Cadd9 → G6，每档 4 秒
  const chords = [
    [220.0, 261.63, 329.63, 392.0],
    [174.61, 220.0, 261.63, 349.23],
    [196.0, 261.63, 329.63, 392.0],
    [196.0, 246.94, 293.66, 392.0],
  ]
  const barSec = 4
  const bright = mood === 'bright' ? 1.25 : mood === 'calm' ? 0.85 : 1
  for (let i = 0; i < n; i++) {
    const t = i / sr
    const bar = Math.floor(t / barSec) % chords.length
    const local = t % barSec
    // 和弦包络：每小节缓入缓出，衔接处不硬切
    const env = Math.min(1, local / 0.9) * Math.min(1, (barSec - local) / 0.9)
    let v = 0
    for (const [k, f] of chords[bar].entries()) {
      const g = (k === 0 ? 0.16 : 0.09) * bright
      v += Math.sin(2 * Math.PI * f * t) * g
      v += Math.sin(2 * Math.PI * f * 2.002 * t) * g * 0.12      // 薄薄一层泛音
      v += Math.sin(2 * Math.PI * f * 0.5 * t) * g * 0.18         // 低八度垫底
    }
    // 琶音：每小节 4 下，正弦短音（像有人在敲玻璃杯）
    const step = Math.floor(local / (barSec / 4))
    const at = local - step * (barSec / 4)
    if (at < 0.9) {
      const af = chords[bar][(step + 1) % chords[bar].length] * 2
      const aenv = Math.exp(-at * 6) * 0.06 * bright
      v += Math.sin(2 * Math.PI * af * t) * aenv
    }
    buf[i] = v * env * 0.9
  }
  // 尾部淡出 2 秒（成片里还会再叠 afade）
  const fadeN = Math.min(n, Math.round(2 * sr))
  for (let i = 0; i < fadeN; i++) buf[n - fadeN + i] *= 1 - i / fadeN
  const { writeWav } = singIO()
  fs.mkdirSync(path.dirname(out), { recursive: true })
  writeWav(out, sr, buf)
  return out
}

// sing.mjs 里已经有 WAV 读写（16bit PCM），复用它，别写第二份
let _singIO = null
function singIO() {
  if (_singIO) return _singIO
  // 同步 require 不到 ESM，这里直接内联一份最小实现（只在需要时用）
  _singIO = { writeWav: writeWavLocal }
  return _singIO
}

function writeWavLocal(file, sampleRate, data) {
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

// ── 剪辑：把镜头串成片子 ────────────────────────────────────────────────────
/**
 * @param {object} o
 * @param {Array} o.clips  [{file, dur}] 按时间轴顺序（片头卡/各幕/片尾卡）
 * @param {object} o.timeline buildTimeline 的结果
 * @param {string} o.ass    字幕文件（要烧进去）
 * @param {string} o.out    输出（无声）
 */
export function composeVisual({ clips, timeline, ass, out, spec, cfg = config() }) {
  const args = []
  for (const c of clips) args.push('-i', c.file)
  const parts = []
  let prev = '[0:v]'
  for (let i = 1; i < clips.length; i++) {
    const startOfThis = timeline.clips[i].start
    const offset = Math.max(0.1, startOfThis)
    const label = i === clips.length - 1 ? '[vx]' : `[v${i}]`
    parts.push(`${prev}[${i}:v]xfade=transition=${transitionAt(i - 1)}:duration=${timeline.ov}:offset=${offset.toFixed(3)}${label}`)
    prev = label
  }
  if (clips.length === 1) parts.push('[0:v]null[vx]')
  let last = 'vx'
  if (ass) {
    parts.push(`[${last}]subtitles='${filterPath(ass)}':fontsdir='${filterPath(path.dirname(fontFile(cfg)))}'[vsub]`)
    last = 'vsub'
  }
  args.push('-filter_complex', parts.join(';'), '-map', `[${last}]`,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', String(spec.crf), '-pix_fmt', 'yuv420p',
    '-r', String(spec.fps), '-an', out)
  ff(args, { cfg })
  return out
}

/**
 * 音轨：逐句配音按时间轴摆位 + BGM 侧链避让 + 响度统一。
 * 配音位置用 adelay 精确摆（毫秒），不做"串行拼接"—— 拼接和转场重叠对不上。
 *
 * ⚠️ 这里踩过一个 10 分钟的坑：每条配音后面写 `apad`（不带长度）会变成**无限静音流**，
 *    amix 就永远等不到结尾，ffmpeg 一直跑（表现是"剪辑卡死"）。所以 apad 必须给 whole_dur，
 *    输出再加一道 -t 兜底。
 */
export function composeAudio({ voices, timeline, bgm, out, spec, cfg = config() }) {
  const args = []
  const filters = []
  const mix = []
  const total = Math.max(0.5, timeline.total)
  voices.forEach((v, i) => {
    args.push('-i', v.file)
    const at = Math.round((timeline.starts[v.index] + spec.lead) * 1000)
    filters.push(`[${i}:a]adelay=${at}|${at},apad=whole_dur=${total.toFixed(3)}[a${i}]`)
    mix.push(`[a${i}]`)
  })
  if (!voices.length) throw new Error('没有配音，成不了片')
  filters.push(`${mix.join('')}amix=inputs=${voices.length}:normalize=0,`
    + `loudnorm=I=-16:TP=-1.5:LRA=11,apad=whole_dur=${total.toFixed(3)}[vo]`)
  let bgmIdx = -1
  if (bgm) {
    bgmIdx = voices.length
    args.push('-i', bgm)
    // BGM 垫在人声下面：低音量 + 侧链压缩（人声一出，音乐自动退 8~10dB）
    filters.push(`[${bgmIdx}:a]atrim=0:${total.toFixed(3)},volume=0.22,afade=t=in:st=0:d=1.2,`
      + `afade=t=out:st=${Math.max(0, total - 2).toFixed(2)}:d=2[bg]`)
    filters.push('[vo][bg]sidechaincompress=threshold=0.035:ratio=9:attack=15:release=380:makeup=1[duck]')
    filters.push('[duck]alimiter=limit=0.94[aout]')
  } else {
    filters.push('[vo]alimiter=limit=0.94[aout]')
  }
  args.push('-filter_complex', filters.join(';'), '-map', '[aout]', '-t', total.toFixed(3),
    '-c:a', 'aac', '-b:a', '192k', out)
  ff(args, { cfg })
  return out
}

/** 音画合一（视频不重编码，只换封装）。 */
export function mux({ video, audio, out, cfg = config() }) {
  ff(['-i', video, '-i', audio, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'copy',
    '-shortest', '-movflags', '+faststart', out], { cfg })
  return out
}

// ── 封面 ────────────────────────────────────────────────────────────────────
/** 封面：拿第一幕的图，压暗 + 大标题 + 署名（一次 AI 生图就够，别多花钱）。 */
export function makeCover({ img, out, title = '', brand = '', spec, cfg = config() }) {
  const font = fontFile(cfg)
  const w = spec.w
  const h = spec.h
  const titleSize = Math.round(h * 0.115)
  const brandSize = Math.round(h * 0.045)
  const safe = escapeDrawText(title)
  const bsafe = escapeDrawText(brand)
  const graph = `[0:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},`
    + `eq=brightness=-0.08:contrast=1.08,`
    + `drawbox=x=0:y=${Math.round(h * 0.52)}:w=${w}:h=${Math.round(h * 0.48)}:color=black@0.42:t=fill,`
    + `drawtext=fontfile='${filterPath(font)}':text='${safe}':fontcolor=white:fontsize=${titleSize}:`
    + `x=(w-text_w)/2:y=h*0.56:borderw=${Math.round(titleSize * 0.05)}:bordercolor=black@0.55,`
    + `drawtext=fontfile='${filterPath(font)}':text='${bsafe}':fontcolor=white@0.85:fontsize=${brandSize}:`
    + `x=(w-text_w)/2:y=h*0.86[v]`
  const args = ['-loop', '1', '-t', '1', '-i', img, '-filter_complex', graph, '-map', '[v]',
    '-frames:v', '1', '-q:v', '2', out]
  ff(args, { cfg })
  return out
}

// ── 一条龙 ──────────────────────────────────────────────────────────────────
/**
 * 把"策划 + 配音"变成一条真片子。
 * @param {object} o
 * @param {Array} o.scenes [{img, img2?, voice, voiceDur, line, move, move2, acting}]
 * @param {object} o.spec
 * @param {object} o.text {title, brand, outro}
 * @param {string} o.dir 工作目录
 */
export async function makeFilm({ scenes, spec, text = {}, dir, opts = {}, log = () => {} }) {
  const cfg = config()
  fs.mkdirSync(dir, { recursive: true })
  const keep = opts.keep !== false
  const clipsDir = path.join(dir, 'clips')
  fs.mkdirSync(clipsDir, { recursive: true })

  const timeline = buildTimeline(scenes, spec, { intro: opts.intro, outro: opts.outro })

  // ① 片头 / 片尾卡
  const clips = []
  if (timeline.intro > 0) {
    const f = path.join(clipsDir, 'clip-intro.mp4')
    renderCard({ out: f, dur: timeline.intro, w: spec.w, h: spec.h, fps: spec.fps, cfg,
      lines: [{ text: text.title || '', size: Math.round(spec.h * 0.1), y: Math.round(spec.h * 0.32) },
        { text: text.brand || '', size: Math.round(spec.h * 0.05), color: '0x9fd8ff' }],
      bg: opts.introBg || '0x0b1220' })
    clips.push({ file: f, dur: timeline.intro })
    log('  片头卡 ✓')
  }

  // ② 每一幕：静图 → 运镜镜头（有第二帧就在幕内交叉淡入，像"动了一下"）
  for (const [i, sc] of scenes.entries()) {
    const dur = timeline.durs[i]
    const moveA = sc.move || MOVE_KEYS[i % MOVE_KEYS.length]
    // 统一产物名 shot-{i}.mp4（单帧/双帧都一样，后面拼片和排查都省事）
    const clipFile = path.join(clipsDir, `shot-${i}.mp4`)
    if (sc.img2 && fs.existsSync(sc.img2)) {
      const a = path.join(clipsDir, `shot-${i}-a.mp4`)
      const b = path.join(clipsDir, `shot-${i}-b.mp4`)
      const cut = Math.max(0.6, dur * 0.52)
      const durB = dur - cut + 0.7
      renderShot({ img: sc.img, out: a, dur, w: spec.w, h: spec.h, fps: spec.fps, move: moveA, cfg })
      const moveB = sc.move2 || MOVE_KEYS[(i + 2) % MOVE_KEYS.length]
      renderShot({ img: sc.img2, out: b, dur: durB, w: spec.w, h: spec.h, fps: spec.fps, move: moveB, cfg })
      ff(['-i', a, '-i', b, '-filter_complex',
        `[0:v][1:v]xfade=transition=fade:duration=0.7:offset=${(cut - 0.7).toFixed(3)}[v]`,
        '-map', '[v]', '-t', String(dur), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-an', clipFile], { cfg })
    } else {
      renderShot({ img: sc.img, out: clipFile, dur, w: spec.w, h: spec.h, fps: spec.fps, move: moveA, cfg })
    }
    clips.push({ file: clipFile, dur })
    log(`  [${i + 1}/${scenes.length}] 镜头 ✓ ${dur.toFixed(1)}s（${moveA}${sc.img2 && fs.existsSync(sc.img2) ? '+双帧' : ''}）`)
  }

  // ③ 片尾卡
  if (timeline.outro > 0) {
    const f = path.join(clipsDir, 'clip-outro.mp4')
    renderCard({ out: f, dur: timeline.outro, w: spec.w, h: spec.h, fps: spec.fps, cfg,
      lines: [{ text: text.outro || '', size: Math.round(spec.h * 0.06) },
        { text: text.brand || '', size: Math.round(spec.h * 0.042), color: '0x9fd8ff' }],
      bg: opts.outroBg || '0x0b1220' })
    clips.push({ file: f, dur: timeline.outro })
    log('  片尾卡 ✓')
  }

  // ④ 字幕（先算时间轴，再烧进去 —— 顺序反了字幕就会错位）
  const assPath = path.join(dir, 'subtitle.ass')
  fs.writeFileSync(assPath, buildAss({ scenes, timeline, spec, title: text.title, brand: text.brand }))
  log('  字幕 ✓')

  // ⑤ 画面合成（xfade 链 + 烧字幕）
  const visual = path.join(dir, 'visual.mp4')
  composeVisual({ clips, timeline, ass: assPath, out: visual, spec, cfg })
  log(`  画面合成 ✓ ${timeline.total.toFixed(1)}s`)

  // ⑥ 配音摆位 + BGM 避让（BGM 默认现合成一条，不碰版权）
  const voices = scenes.map((sc, i) => ({ file: sc.voice, index: i })).filter((v) => v.file && fs.existsSync(v.file))
  let bgm = opts.bgm || null
  if (bgm === 'auto') {
    bgm = path.join(dir, 'bgm.wav')
    makeBgm({ out: bgm, dur: timeline.total + 1, mood: opts.mood || 'warm', cfg })
    log('  BGM 合成 ✓')
  }
  const audio = path.join(dir, 'audio.m4a')
  composeAudio({ voices, timeline, bgm: bgm && fs.existsSync(bgm) ? bgm : null, out: audio, spec, cfg })
  log('  音轨 ✓')

  // ⑦ 音画合一
  const final = path.join(dir, 'video.mp4')
  mux({ video: visual, audio, out: final, cfg })
  const dur = probeDur(final, cfg)
  log(`  成片 ✓ ${dur.toFixed(1)}s · ${(fs.statSync(final).size / 1024 / 1024).toFixed(1)}MB`)

  if (!keep) {
    try { fs.rmSync(clipsDir, { recursive: true, force: true }) } catch {}
  }
  return { final, timeline, dur, assPath }
}

/** 依据场景自动挑"情绪/氛围"给 BGM（她累就 calm，开心就 bright）。 */
export function moodFor(line = '') {
  const s = String(line)
  if (/[笑哈嘿嘿]|开心|高兴|太好了|喜欢/.test(s)) return 'bright'
  if (/累|困|沉|安静|慢慢|夜/.test(s)) return 'calm'
  return 'warm'
}

/** 成片校验：分辨率/时长/有没有音轨 —— 交给 selftest 用的。 */
export function inspect(file, cfg = config()) {
  try {
    const out = run(ffprobeBin(cfg), ['-v', 'error', '-show_entries', 'stream=codec_type,width,height:format=duration', '-of', 'json', file])
    const j = JSON.parse(out)
    const v = (j.streams || []).find((s) => s.codec_type === 'video') || {}
    const hasAudio = (j.streams || []).some((s) => s.codec_type === 'audio')
    return { width: v.width, height: v.height, dur: Number(j.format?.duration) || 0, hasAudio }
  } catch { return null }
}

/** produce 的产物目录（B站/抖音分开）。 */
export function postsDir(platform) {
  return dataPath(platform === 'bili' ? 'bili-posts' : 'douyin-posts')
}