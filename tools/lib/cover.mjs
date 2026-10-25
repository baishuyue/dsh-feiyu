// cover —— 专业翻唱管线：真歌的人声干声 → RVC 换成她的音色 → 混回伴奏。
// 这就是"AI 孙燕姿"同款路线：旋律/气息/技巧是专业歌手的，音色是她的。
// 全链缓存（源音频/分离干声/换声/成品）—— 一首歌只花一次算力，之后随点随唱（她的歌单）。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { config } from './config.mjs'
import { dataPath } from './paths.mjs'
import * as rvc from './rvc.mjs'

const SONGS_DIR = () => dataPath('songs')
const FFMPEG = () => config().rvc?.ffmpeg || 'D:/GPT-SoVITS/runtime/ffmpeg.exe'
const PROXY = () => config().sing?.proxy || config().imageGen?.proxy || 'http://127.0.0.1:7897'

function ffmpeg(args, timeoutMs = 300000) {
  const exe = FFMPEG()
  if (!fs.existsSync(exe)) throw new Error('没找到 ffmpeg：' + exe)
  const r = execFileSync(exe, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8', timeout: timeoutMs, windowsHide: true })
  return r
}

/** 日下载额度（防 yt-dlp 搜索跑飞）：sing.searchDaily，默认 3，0 = 不限。 */
export function searchQuotaOk() {
  const max = Number(config().sing?.searchDaily ?? 3)
  if (!(max > 0)) return true
  try {
    const f = dataPath('sing-search.json')
    const j = JSON.parse(fs.readFileSync(f, 'utf8'))
    const day = new Date().toLocaleDateString('sv-SE')
    return (j.day === day ? Number(j.count ?? 0) : 0) < max
  } catch { return true }
}
function searchQuotaRecord() {
  try {
    const f = dataPath('sing-search.json')
    const day = new Date().toLocaleDateString('sv-SE')
    const j = JSON.parse(fs.readFileSync(f, 'utf8'))
    const count = j.day === day ? Number(j.count ?? 0) : 0
    fs.writeFileSync(f, JSON.stringify({ day, count: count + 1 }))
  } catch {}
}

/** URL → wav（yt-dlp 走本机 Clash；ytsearch1: 前缀 = YouTube 搜索第一名）。 */
async function fetchSource(src, dir) {
  const out = path.join(dir, 'source.wav')
  if (fs.existsSync(out) && fs.statSync(out).size > 100000) return out
  if (!/^https?:\/\//.test(src) && !src.startsWith('ytsearch')) {
    if (!fs.existsSync(src)) throw new Error('源文件不存在：' + src)
    ffmpeg(['-i', String(src).replace(/\//g, path.sep), '-ar', '44100', '-ac', '2', out])
    return out
  }
  const rvcPy = config().rvc?.python || 'D:/rvc/venv/Scripts/python.exe'
  const args = ['-m', 'yt_dlp', '-x', '--audio-format', 'wav', '--audio-quality', '0', '--no-playlist',
    '--proxy', PROXY(), '-o', path.join(dir, 'source.%(ext)s'), src]
  // YouTube 2026 起抽取要 JS 运行时解 NSIG（默认只认 deno）——机器上有 DSH 的 node，指给它用
  const nodeExe = 'C:/Users/30828/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe'
  if (fs.existsSync(nodeExe)) args.push('--js-runtimes', `node:${nodeExe}`)
  // -x 抽音轨的后期处理要 ffmpeg/ffprobe（D:/rvc/bin 里有全套）
  const ffDir = config().rvc?.binPath || 'D:/rvc/bin'
  if (fs.existsSync(path.join(ffDir, 'ffmpeg.exe'))) args.push('--ffmpeg-location', String(ffDir).replace(/\//g, path.sep))
  try {
    execFileSync(rvcPy, args, { encoding: 'utf8', timeout: 600000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    throw new Error('yt-dlp 下载失败：' + String(e.stderr || e.message).split('\n').filter(Boolean).slice(-2).join('；').slice(-200))
  }
  // yt-dlp 有 ffmpeg 时 -x 直接产出 source.wav（并删掉 webm 原件）；没有时留下 webm/m4a，自己转
  const wav = path.join(dir, 'source.wav')
  if (fs.existsSync(wav) && fs.statSync(wav).size > 100000) { searchQuotaRecord(); return wav }
  const got = fs.readdirSync(dir).find((f) => f.startsWith('source.') && f !== 'source.wav')
  if (!got) throw new Error('yt-dlp 没产出音频（链接/代理/额度？）')
  ffmpeg(['-i', path.join(dir, got), '-ar', '44100', '-ac', '2', wav])
  try { fs.rmSync(path.join(dir, got), { force: true }) } catch {}
  searchQuotaRecord()
  return wav
}

/** 歌单目录：按源 md5 落位，meta.json 存名字。 */
function songDir(key) { return path.join(SONGS_DIR(), key) }
function keyOf(source) { return crypto.createHash('md5').update(String(source)).digest('hex').slice(0, 12) }

/** 歌单列表（有成品 cover-<音色>.wav 的才算学会了）。 */
export function listSongs() {
  const out = []
  try {
    for (const key of fs.readdirSync(SONGS_DIR())) {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(SONGS_DIR(), key, 'meta.json'), 'utf8'))
        const voices = fs.readdirSync(path.join(SONGS_DIR(), key)).filter((f) => /^cover-.*\.wav$/.test(f)).map((f) => f.replace(/^cover-/, '').replace(/\.wav$/, ''))
        out.push({ key, title: meta.title || key, hasCover: voices.length > 0, voices, source: meta.source || '', at: meta.createdAt || 0 })
      } catch {}
    }
  } catch {}
  return out.sort((a, b) => b.at - a.at)
}

/** 按名字模糊找已学的歌（她的歌单点唱）。 */
export function findSong(name) {
  const q = String(name || '').toLowerCase().replace(/\s+/g, '')
  if (!q) return null
  return listSongs().filter((s) => s.hasCover).find((s) => {
    const t = s.title.toLowerCase().replace(/\s+/g, '')
    return t.includes(q) || q.includes(t) || q.split(/[，,、]/).some((x) => x && t.includes(x))
  }) || null
}

/**
 * 翻唱一首。source = 本地路径 | http(s) 链接 | ytsearch1:关键词。
 * @returns {{file, title, cache: 'hit'|'partial'|'new'}}
 */
export async function coverSong({ source, title = '', pitch = 0, log = () => {} }) {
  const key = keyOf(source)
  const dir = songDir(key)
  fs.mkdirSync(dir, { recursive: true })
  // 成品按音色分缓存：换音色后同一首歌要重唱，不能命中旧音色的歌声
  let voice = ''
  try { voice = (await import('./rvc.mjs')).currentVoice() } catch {}
  const cover = path.join(dir, `cover-${voice || 'none'}.wav`)
  const metaFile = path.join(dir, 'meta.json')
  if (voice && fs.existsSync(cover)) {
    return { file: cover, title: title || JSON.parse(fs.readFileSync(metaFile, 'utf8')).title || key, cache: 'hit' }
  }
  if (!rvc.rvcReady()) throw new Error('RVC 环境不齐（voice models 看看）')
  if (!voice) throw new Error('她还没有自己的音色模型（先 voice train）')
  if (!fs.existsSync(metaFile)) fs.writeFileSync(metaFile, JSON.stringify({ title: title || source, source, createdAt: Date.now() }))

  // ① 源音频
  log('① 取源音频…')
  const src = await fetchSource(source, dir)
  // ② 人声/伴奏分离（pymss roformer，SOTA 级）
  log('② 分离人声与伴奏…')
  const sep = await rvc.separateVocals({ input: src, outDir: dir })
  // ③ 干声换成她的音色
  log('③ 换上她的声音（RVC）…')
  const converted = path.join(dir, 'converted.wav')
  await rvc.convertVoice({ input: sep.vocal, output: converted, name: voice, pitch, indexRate: 0.75, log: (l) => log('  ' + String(l).slice(0, 90)) })
  // ④ 混回伴奏（没伴奏就清唱）
  let final = converted
  if (sep.instrumental && fs.existsSync(sep.instrumental)) {
    log('④ 混音…')
    final = cover
    ffmpeg(['-i', converted, '-i', sep.instrumental, '-filter_complex',
      '[0:a]aresample=44100[v];[1:a]aresample=44100,volume=0.85[i];[v][i]amix=inputs=2:duration=first:normalize=0,loudnorm=I=-15:TP=-1.5',
      '-ar', '44100', cover])
  } else {
    fs.copyFileSync(converted, cover)
  }
  return { file: cover, title: title || source, cache: 'new' }
}
