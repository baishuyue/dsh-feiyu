// TTS —— GPT-SoVITS 本地音色克隆客户端。
// 调 api_v2.py 的 /tts 端点（默认 http://127.0.0.1:9880/tts）。
// 音色来自 voice 配置：ref_audio_path（参考音频，零样本克隆）或 sovits_path（训练好的权重，
// 如 xiaoxiao.safetensors）。字段透传，按你自己的 GPT-SoVITS 版本增减。
import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.mjs'
import { dataPath } from './paths.mjs'

const PASS_THROUGH = ['ref_audio_path', 'prompt_text', 'prompt_lang', 'sovits_path', 'gpt_path', 'text_split_method', 'batch_size']

/** Windows 上的 GPT-SoVITS api_v2.py 用 GBK 编码文本/日志：任何 GBK 装不下的字符都会让它直接抛
 *  UnicodeEncodeError → /tts 返回 400 "tts failed"（实测：
 *    「(・_・;)」里的 \u30FB → 'gbk' codec can't encode character '\u30fb'
 *    「🐟」→ 'gbk' codec can't encode character '\U0001f41f'
 *  纯中文则 200 OK）。
 *  她的回复里几乎每条都带颜文字/emoji —— 于是语音**从来没成功过**，全部降级成文字。
 *  这里先洗掉 GBK 发不出的字符（语音是可选项，宁可少几个符号也别整条发不出去）。 */
export function sanitizeForTts(text) {
  const s = String(text ?? '')
  // 白名单：ASCII 可打印 + 中日文/CJK 标点 + 全角 + GBK 认的几个西文标点
  const kept = s.replace(
    /[^\u0020-\u007E\u00B7\u2010-\u2015\u2018\u2019\u201C\u201D\u2026\u3000-\u303F\u3040-\u30FA\u30FC-\u30FF\u4E00-\u9FFF\uFF01-\uFF5E]/g,
    '',
  )
  return kept
    // 颜文字的括号残骸 "(_;)" "（・_・）" —— 剩下的符号念出来是噪音，整段丢掉
    // （有字的括号如"（不想动）"要留）
    .replace(/[(\[（【][^\p{L}\p{N}]{0,8}[)\]）】]/gu, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s*([，。！？、；：）】」』])\s*/g, '$1')
    .replace(/^[\s，。！？、；：]+|[\s，。！？、；：]+$/g, '')
    .trim()
}

/**
 * 合成一段语音，返回 wav 文件绝对路径。
 * 失败抛错（调用方降级成文字 —— 语音是可选项，任何环节失败内容不能丢）。
 * override：临时覆盖音色（{ref_audio_path, prompt_text} 等 PASS_THROUGH 字段）——
 * 音色工坊试听/唱歌逐句合成用，不改全局配置。
 */
/** 参考文本必须和参考音频是**同一段话**。
 *
 *  10-26 主人报「说话包括做视频都重复出现一句『说好等手伤痊愈了就一起打游戏』」——
 *  查出来是旧音色（银狼）的参考文本留在了配置里：ref_audio_path 换成了 yinlang，
 *  prompt_text 还是那句"卡夫卡/手伤/打游戏"，而 yinlang.wav 真正说的是
 *  「战斗体验该优化了，哼就这速度太慢了。」。GPT-SoVITS 拿错文本去对齐参考音频，
 *  于是每次合成都会把这句参考文本**念出来**（实测同一句 42 字：错文本 30.66 秒 / 对文本 8.62 秒，
 *  多出来的 22 秒就是泄漏）。
 *
 *  防守：模型目录里一般有同名 .txt（参考音频的转写）。它比配置可信 —— 配置是人手填的，
 *  换音色时容易忘了跟着改。只要有 .txt 且内容不同，就用 .txt 的，并报一声。 */
export function refTextOf(refAudioPath) {
  try {
    if (!refAudioPath) return ''
    const dir = path.dirname(String(refAudioPath))
    const base = path.basename(String(refAudioPath)).replace(/\.[^.]+$/, '')
    const cands = [base + '.txt', base + '.lab']
    for (const c of cands) {
      const f = path.join(dir, c)
      if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim()
    }
    // 没同名文件就退一步：目录里任意一个 .txt
    const any = fs.readdirSync(dir).find((f) => f.toLowerCase().endsWith('.txt'))
    if (any) return fs.readFileSync(path.join(dir, any), 'utf8').trim()
  } catch {}
  return ''
}

export async function synth(text, outFile, override = {}) {
  const v = config().voice ?? {}
  const speak = sanitizeForTts(text)
  if (!speak) throw new Error('文本里全是 GBK 发不出的符号（颜文字/emoji），没有可念的内容')
  // 参考文本对齐（见 refTextOf 注释）：override 里显式给了就用它的（音色工坊/唱歌逐句覆盖），
  // 否则以模型目录的转写为准，防"配置里的旧参考文本"把话念歪。
  const refAudio = override.ref_audio_path || v.ref_audio_path || ''
  let prompt = override.prompt_text ?? v.prompt_text ?? ''
  if (override.prompt_text === undefined) {
    const truth = refTextOf(refAudio)
    if (truth && truth !== String(prompt).trim()) {
      try { console.warn(`[tts] 参考文本与「${path.basename(String(refAudio))}」的转写不符，改用转写：${truth.slice(0, 40)}`) } catch {}
      prompt = truth
    }
  }
  const body = {
    text: speak,
    text_lang: v.text_lang || 'zh',
    media_type: v.media_type || 'wav',
    streaming_mode: v.streaming_mode ?? false,
  }
  for (const k of PASS_THROUGH) if (v[k]) body[k] = v[k]
  for (const k of PASS_THROUGH) if (override[k]) body[k] = override[k]
  // 配置里的 prompt_text 可能是换音色前的旧值 —— 用模型转写盖掉（显式 override 除外）
  if (override.prompt_text === undefined && prompt) body.prompt_text = prompt
  if (refAudio) body.ref_audio_path = refAudio

  const r = await fetch(v.sovits_url || 'http://127.0.0.1:9880/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  })
  if (!r.ok) throw new Error(`GPT-SoVITS HTTP ${r.status}`)
  const buf = Buffer.from(await r.arrayBuffer())
  if (buf.length < 2000) throw new Error('GPT-SoVITS 返回音频过短（可能合成失败）')

  const file = outFile || dataPath('voice', `${Date.now()}.wav`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, buf)
  return file
}
