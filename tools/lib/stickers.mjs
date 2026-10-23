// 表情包 / 颜文字 —— QQ、微信、B站、抖音共用的一套约定。
//
// 为什么要有这一层：
//   · 评论（B站/抖音）只能发文字，表情包发不了 → 那里只允许颜文字；
//   · QQ/微信能发图 → 模型写 [表情:开心]，宿主把本地图片发出去；
//   · 模型嘴一滑在评论里写了 [表情:xx]，发布前必须剥掉，否则评论里会带个原文标记。
//
// 图片放在 ~/.feiyu-ai/stickers/<标签>/ 下（png/jpg/gif/webp 都行），
// 换表情包不用改代码，往里丢文件即可。
import fs from 'node:fs'
import path from 'node:path'
import { homePath } from './paths.mjs'

export const STICKER_DIR = homePath('.feiyu-ai', 'stickers')

/** 内置兜底标签（文件夹里没有，也不影响 prompt 里出现这几个）。 */
export const DEFAULT_TAGS = ['开心', '无语', '委屈', '生气', '困', '比心']

const IMG = /\.(png|jpe?g|gif|webp)$/i

/** 扫描本机表情包：返回 { 标签: [绝对路径...] }。 */
export function listStickers() {
  const out = {}
  let dirs = []
  try { dirs = fs.readdirSync(STICKER_DIR, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name) } catch { return out }
  for (const tag of dirs) {
    const dir = path.join(STICKER_DIR, tag)
    let files = []
    try { files = fs.readdirSync(dir).filter(f => IMG.test(f)).map(f => path.join(dir, f)) } catch { continue }
    if (files.length) out[tag] = files
  }
  return out
}

/** 可用标签（本机有图的优先；一张图都没有时退回内置标签，只走颜文字）。 */
export function availableTags() {
  const have = Object.keys(listStickers())
  return have.length ? have : DEFAULT_TAGS
}

/** 取某个标签的一张图；没有就返回 null。 */
export function pickSticker(tag, random = Math.random) {
  const all = listStickers()
  const files = all[tag]
  if (!files || !files.length) return null
  return files[Math.floor(random() * files.length) % files.length]
}

const MARK = /[[【]\s*表情\s*[:：]\s*([^\]】\s]{1,10})\s*[\]】]/g

/** 从回复里摘出表情标记：{ text, tag }。tag 为 null 表示没写。 */
export function splitSticker(reply) {
  let tag = null
  const text = String(reply || '')
    .replace(MARK, (_m, t) => { if (!tag) tag = t.trim(); return '' })
    .replace(/[ \t]+\n/g, '\n')
    .trim()
  return { text, tag }
}

/** 评论用（b站/抖音）：剥掉表情标记，只留文字 + 颜文字。 */
export function toPlain(reply) {
  return splitSticker(reply).text
}

/** 注入 prompt 的「发表情规矩」。 */
export function stickerPrompt(platform = 'qq', random = Math.random) {
  const canImage = platform === 'qq' || platform === 'wechat'
  const tags = availableTags()
  const lines = [
    '【表情的规矩】偶尔带一个颜文字或 emoji 就够（比如 (๑•̀ㅂ•́)و✧ / 😴 / 🌙），一句最多一个，别每句都带。',
  ]
  if (canImage) {
    if (Object.keys(listStickers()).length) {
      lines.push(`想让气氛更足时，可以在回复最后单独写 [表情:标签]（一次最多一个，标签只能用：${tags.join('/')}）。没有贴切的不写也行 —— 写了就真的会发一张表情包。`)
    } else {
      lines.push('（表情包图库还空着，这次只用颜文字，别写 [表情:…]。）')
    }
  } else {
    lines.push('这里是评论区，发不了图片表情，只能用颜文字和 emoji；不要写 [表情:…]。')
  }
  return lines.join('\n')
}

/** 没图时按标签给个颜文字兜底（QQ/微信发送失败降级用）。 */
export const FACE_FALLBACK = {
  开心: '(๑˃̵ᴗ˂̵)و',
  无语: '(・_・;)',
  委屈: '(｡•́︿•̀｡)',
  生气: '(╯°□°）╯',
  困: '(－_－) zzZ',
  比心: '(♡˙︶˙♡)',
}
