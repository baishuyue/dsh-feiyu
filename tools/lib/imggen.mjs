// imggen —— AI 表情包自动生成（Pollinations flux，免费、无需 key）。
//
// 为什么用 curl 子进程出网：image.pollinations.ai 直连被墙（实测 HTTP 000），
// 必须走本机 Clash 代理；而 node fetch（undici）不认系统代理环境变量 ——
// spawn curl -x 代理 是版本无关、行为最确定的通道（实测 200 / 31KB / ~4s）。
//
// 生成结果按文案 md5 缓存进表情库：标签模式存 ~/.feiyu-ai/stickers/<标签>/ai-*.jpg
// （图库自己长大，下次同样式直接从图库拿）；自制模式存 自制/ 目录。
// 日额度账本 ~/.feiyu-ai/imggen.json（0 = 不限），防 Pollinations 免费档被刷限流。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { dataPath } from './paths.mjs'
import { config } from './config.mjs'
import { STICKER_DIR } from './stickers.mjs'

const GEN_FILE = () => dataPath('imggen.json')
const REF_CACHE = () => dataPath('imggen-ref.json')
const dayKey = () => new Date().toLocaleDateString('sv-SE')
/** 固定形象基底：鲸鱼娘（2D 动漫贴纸风，蓝发鱼尾少女 —— 参考主人给的形象），成品才像"她的"表情包。
 *  情绪/动作/服装由每条文案的 LLM 翻译自由发挥 —— 基底不变，风格她自己探索。 */
const STYLE = 'flat 2D anime chibi sticker illustration, cute whale-girl, long wavy navy-blue hair with light blue gradient, whale tail and small fin ears, big sparkling blue eyes, soft blush, kawaii, bold clean lineart, flat cel shading, simple pale background, high quality'
const TAG_CAP = 12   // 每个标签目录最多留几张 ai- 生成图（老的删掉，只删自己生成的）

// ── 图生图参考图（10-25）：形象锚定用主人给的参考图，img2img 才"像" ─────────
// Pollinations 的 &image= 参数要一个公网可达的图片 URL —— 参考图是本地文件，
// 自动传 tmpfiles.org（60 分钟过期）并缓存 URL，过期自动重传。
const REF_UPLOAD_PROXY = () => config().imageGen?.proxy || 'http://127.0.0.1:7897'
function refUrlCached() {
  try { const j = JSON.parse(fs.readFileSync(REF_CACHE(), 'utf8')); if (j.url && Date.now() - Number(j.at) < 50 * 60_000) return j.url } catch {}
  return ''
}
function uploadRef(localPath) {
  const exe = fs.existsSync('C:/Windows/System32/curl.exe') ? 'C:/Windows/System32/curl.exe' : 'curl'
  const r = execFileSync(exe, ['-sS', '-m', '90', '-x', REF_UPLOAD_PROXY(), '-F', `file=@${String(localPath).replace(/\//g, path.sep)}`, 'https://tmpfiles.org/api/v1/upload'],
    { encoding: 'utf8', timeout: 100000, windowsHide: true })
  const j = JSON.parse(r)
  const page = String(j?.data?.url || '')
  if (!page) throw new Error('tmpfiles 上传失败：' + r.slice(0, 120))
  const url = page.replace('tmpfiles.org/', 'tmpfiles.org/dl/')   // 页面链 → 直链
  try { fs.writeFileSync(REF_CACHE(), JSON.stringify({ url, at: Date.now() })) } catch {}
  return url
}
/** 参考图公网直链：配置了 imageGen.refImage（本地路径或 http 链接）才启用图生图；拿不到返回 ''。 */
function refImageUrl() {
  const ref = String(config().imageGen?.refImage || '').trim()
  if (!ref) return ''
  if (/^https?:\/\//.test(ref)) return ref
  try {
    if (!fs.existsSync(ref)) return ''
    const cached = refUrlCached()
    if (cached) return cached
    return uploadRef(ref)
  } catch { return '' }
}

// ── 日额度 ────────────────────────────────────────────────────────────────
export function genQuotaOk(max, file = GEN_FILE()) {
  if (!(Number(max) > 0)) return true   // 0 = 不限
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'))
    return (j.day === dayKey() ? Number(j.count ?? 0) : 0) < max
  } catch { return true }
}
export function genQuotaRecord(file = GEN_FILE()) {
  let count = 0
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); count = j.day === dayKey() ? Number(j.count ?? 0) : 0 } catch {}
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ day: dayKey(), count: count + 1 })) } catch {}
}

// ── 纯逻辑（测试用）─────────────────────────────────────────────────────────
/** 文案 → 文生图 prompt：LLM 翻译成英文（flux 对中文很糊），失败/没 LLM 用模板兜底。 */
export async function buildImagePrompt(caption, chat) {
  const cap = String(caption || '').trim().slice(0, 20)
  if (!cap) return STYLE
  const fallback = `${STYLE}, mood: ${cap}, adorable`
  if (typeof chat !== 'function') return fallback
  try {
    const out = await Promise.race([
      chat([
        { role: 'system', content: '你是文生图提示词工程师。把一条中文表情包文案翻译成英文文生图 prompt：描述这只圆滚滚卡通蓝鲸鱼娘在此场景下的表情、动作、情绪。只输出英文短语（50 词以内），不要解释不要换行。' },
        { role: 'user', content: `文案：${cap}\n英文 prompt：` },
      ], { temperature: 0.7, max_tokens: 120 }),
      new Promise((_r, rej) => setTimeout(() => rej(new Error('prompt 翻译超时')), 15000)),
    ])
    const t = String(out || '').trim().replace(/\s+/g, ' ')
    return t ? `${STYLE}, ${t.slice(0, 300)}` : fallback
  } catch { return fallback }
}

/** 是不是一张真图（JPEG/PNG 魔数 + 大小下限，防把 HTML 拦截页存进图库）。 */
export function isImageFile(file) {
  try {
    if (!fs.existsSync(file) || fs.statSync(file).size < 2048) return false
    const head = fs.readFileSync(file).subarray(0, 4)
    return (head[0] === 0xff && head[1] === 0xd8) || (head[0] === 0x89 && head[1] === 0x50)
  } catch { return false }
}

/** 标签目录里 ai- 图超过上限时删最老的（只动自己生成的，内置图不碰）。 */
export function capTagFiles(tag, cap = TAG_CAP, dir = STICKER_DIR) {
  try {
    const d = path.join(dir, tag)
    const files = fs.readdirSync(d).filter(f => f.startsWith('ai-') && /\.(jpg|jpeg|png|webp|gif)$/i.test(f))
      .map(f => ({ f, mt: fs.statSync(path.join(d, f)).mtimeMs })).sort((a, b) => a.mt - b.mt)
    for (const x of files.slice(0, Math.max(0, files.length - cap))) { try { fs.rmSync(path.join(d, x.f), { force: true }) } catch {} }
  } catch {}
}

// ── 生成主流程 ──────────────────────────────────────────────────────────────
const inflight = new Map()   // 同一文案/标签并发生成去重（qq-server 两条消息先后到时别画两张）

function curlTo(url, file, timeoutMs, proxy) {
  return new Promise((resolve, reject) => {
    const exe = fs.existsSync('C:/Windows/System32/curl.exe') ? 'C:/Windows/System32/curl.exe' : 'curl'
    const args = ['-sS', '-L', '-m', String(Math.ceil(timeoutMs / 1000)), '-o', file, '-w', '%{http_code}',
      ...(proxy ? ['-x', proxy] : []), url]
    execFile(exe, args, { windowsHide: true, timeout: timeoutMs + 8000 }, (e, so, se) => {
      if (e && !fs.existsSync(file)) return reject(new Error(String(se || e.message).slice(-200)))
      resolve(String(so || '').trim())
    })
  })
}

/**
 * 生成一张表情包并入库。返回图片绝对路径；失败返回 null（调用方自行降级）。
 * @param {string} caption 表情文案（如「本鱼饿了」「太搞笑了8」）
 * @param {{tag?: string, llmChat?: (msgs, opts) => Promise<string>, timeoutMs?: number}} o
 *   tag 给了就存进 <tag>/ 目录（图库增长）；不给存 自制/（按文案缓存）。
 */
export async function generateStickerImage(caption, o = {}) {
  const ig = config().imageGen ?? {}
  if (ig.enabled === false) return null
  const cap = String(caption || '').trim().slice(0, 20)
  if (!cap) return null
  const dailyMax = Number(ig.dailyMax ?? 30)
  const tag = o.tag ? String(o.tag).replace(/[\\/:*?"<>|]/g, '').slice(0, 10) : ''
  const dir = path.join(STICKER_DIR, tag || '自制')
  const hash = crypto.createHash('md5').update((tag ? `t:${tag}:` : '') + cap).digest('hex').slice(0, 12)
  const out = path.join(dir, `${tag ? 'ai-' : ''}${hash}.jpg`)
  if (isImageFile(out)) return out          // 缓存命中：同文案不重画、不占额度
  const key = `${tag}|${cap}`
  if (inflight.has(key)) return inflight.get(key)

  if (!genQuotaOk(dailyMax)) return null    // 今日额度用完，安静放弃（调用方有 PIL/颜文字兜底）
  const run = (async () => {
    try {
      const chat = o.llmChat ?? (await import('./llm.mjs')).chat
      const prompt = await buildImagePrompt(cap, chat)
      const ref = refImageUrl()   // 图生图锚：有参考图就带上，形象才"像"
      const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}`
        + `?width=512&height=512&nologo=true&model=${encodeURIComponent(ig.model || 'flux')}&seed=${Math.floor(Math.random() * 1e6)}`
        + (ref ? `&image=${encodeURIComponent(ref)}` : '')
      fs.mkdirSync(dir, { recursive: true })
      const tmp = out + '.part'
      // 免费档 1 张/45s + 服务偶发 503：402/503 退避 55s 重试，最多 3 次
      let code = ''
      for (let attempt = 1; attempt <= 3; attempt++) {
        code = await curlTo(url, tmp, o.timeoutMs ?? 120000, ig.proxy ?? 'http://127.0.0.1:7897')
        if (code === '200') break
        try { fs.rmSync(tmp, { force: true }) } catch {}
        if (attempt < 3 && (code === '402' || code === '503')) {
          await new Promise((r) => setTimeout(r, 55000))
          continue
        }
        return null
      }
      if (code !== '200' || !isImageFile(tmp)) { try { fs.rmSync(tmp, { force: true }) } catch {}; return null }
      fs.renameSync(tmp, out)
      genQuotaRecord()
      if (tag) capTagFiles(tag)
      return out
    } catch { return null }
    finally { inflight.delete(key) }
  })()
  inflight.set(key, run)
  return run
}
