// vision —— 画面采样 + 视觉理解（可配置 provider 框架，10-25 就位）。
//
// 用户的 DeepSeek key 不支持视觉；等智谱 GLM-4V / 硅基流动 Qwen-VL 的 key 填进配置就点亮。
// provider 统一走 OpenAI 兼容 chat/completions（智谱/硅基流动/OpenAI 都是这套），
// 多帧以 base64 data URI 塞进同一条 user 消息。
// 没配 = 全链路静默跳过（watch 照旧走"读标题+热评"的老路），绝不报错挡路。
import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.mjs'
import { dataPath } from './paths.mjs'

export function visionCfg() {
  const v = config().vision ?? {}
  return {
    provider: v.provider || 'none',
    base_url: v.base_url || '',
    model: v.model || '',
    api_key: v.api_key || process.env.VISION_API_KEY || '',
    maxFrames: Number(v.maxFrames ?? 3),
    // 备通道（10-26）：主通道 429/额度没了自动换一家，视觉链路不跟着一起哑
    fallback: v.fallback ?? null,
  }
}

/** 视觉链路是否真的能用（四样都齐才开）。 */
export function visionOn() {
  const v = visionCfg()
  return v.provider !== 'none' && !!v.base_url && !!v.model && !!v.api_key
}

/** 图片 → base64 data URI（OpenAI 兼容 image_url 格式）。 */
export function dataUri(file) {
  const buf = fs.readFileSync(file)
  const mime = path.extname(file).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg'
  return `data:${mime};base64,${buf.toString('base64')}`
}

/** 打一次视觉请求（内部用，失败抛错）。 */
async function askOnce(cfg, content) {
  const r = await fetch(String(cfg.base_url).replace(/\/+$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.api_key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: cfg.model, messages: [{ role: 'user', content }], temperature: 0.4, max_tokens: 300 }),
    signal: AbortSignal.timeout(60000),
  })
  if (!r.ok) throw new Error(`vision HTTP ${r.status}: ${(await r.text()).slice(0, 120)}`)
  const j = await r.json()
  const out = String(j.choices?.[0]?.message?.content ?? '').trim()
  if (!out) throw new Error('vision 返回空内容')
  return out
}

/**
 * 多帧 → 一段中文画面描述。没配/失败返回 null（调用方降级，不上抛）。
 * 主通道失败会自动试 vision.fallback（别一家额度没了整个视觉链路就哑）。
 * @param {string[]} frames 帧图路径（同一条视频的连拍）
 * @param {{query?: string}} o 自定义提问
 */
export async function describeFrames(frames, o = {}) {
  if (!visionOn()) return null
  const v = visionCfg()
  const content = [{ type: 'text', text: o.query
    || '这是同一条短视频里连拍的几帧画面。用 2~3 句中文描述：画面里有什么、在做什么、什么风格氛围。只输出描述本身，别分析别啰嗦。' }]
  let attached = 0
  for (const f of (frames || []).slice(0, Math.max(1, v.maxFrames))) {
    try { content.push({ type: 'image_url', image_url: { url: dataUri(f) } }); attached++ } catch {}
  }
  if (!attached) return null
  try {
    return await askOnce(v, content)
  } catch (e) {
    const fb = v.fallback
    if (fb && fb.base_url && fb.model && fb.api_key) {
      try {
        const out = await askOnce(fb, content)
        try { fs.appendFileSync(dataPath('vision-fallback.log'), `${new Date().toISOString()} 视觉主通道失败(${String(e.message).slice(0, 70)}) → 已用备通道\n`) } catch {}
        return out
      } catch { /* 备通道也挂 → 下面统一返回 null */ }
    }
    return null
  }
}
