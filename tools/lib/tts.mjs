// TTS —— GPT-SoVITS 本地音色克隆客户端。
// 调 api_v2.py 的 /tts 端点（默认 http://127.0.0.1:9880/tts）。
// 音色来自 voice 配置：ref_audio_path（参考音频，零样本克隆）或 sovits_path（训练好的权重，
// 如 xiaoxiao.safetensors）。字段透传，按你自己的 GPT-SoVITS 版本增减。
import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.mjs'
import { dataPath } from './paths.mjs'

const PASS_THROUGH = ['ref_audio_path', 'prompt_text', 'prompt_lang', 'sovits_path', 'gpt_path', 'text_split_method', 'batch_size']

/**
 * 合成一段语音，返回 wav 文件绝对路径。
 * 失败抛错（调用方降级成文字 —— 语音是可选项，任何环节失败内容不能丢）。
 */
export async function synth(text, outFile) {
  const v = config().voice ?? {}
  const body = {
    text,
    text_lang: v.text_lang || 'zh',
    media_type: v.media_type || 'wav',
    streaming_mode: v.streaming_mode ?? false,
  }
  for (const k of PASS_THROUGH) if (v[k]) body[k] = v[k]

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
