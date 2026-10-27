// 评论/回复的「表达类型」分配器（2026-10-27）
//
// 主人提的是：评论不该只有文字 —— 文字、颜文字、表情(emoji)、表情包(图)、图片，抖音还要能发语音，
// 自己作品下面能这样，刷到的别人视频下面也要能这样。
//
// 这个模块只干一件事：**决定"这一条用什么说"**，并给出落地要用的素材（表情包图片路径 / 抖音官方表情）。
// 具体怎么发由各平台执行层负责（抖音走 comment/comment-reply 的 --image/--emoji-pack；B站走 pictures）。
//
// ⚠️ 平台真实能力（2026-10-27 现场探到的，别凭想象写）：
//   抖音网页版评论区：文字 ✓（unicode emoji、颜文字都算文字）；官方表情面板 ✓（214 张图）；
//                     图片上传 ✓（隐藏 input[type=file] accept=.png/.webp/.jpeg/.pjpeg/.bmp/.jpg，单张）。
//                     录音 ✗ —— 评论框里没有任何录音控件（只有 1 个图 input + 表情面板）。
//   抖音网页版私信：  input[type=file] accept=.jpg,.jpeg,.png,.gif,.mp4 —— 图片/动图/视频，**也没有录音**。
//                     → "语音"只能做成带音轨的 mp4（她自己的声音 + 一帧封面），见 `voiceNoteArgs()`。
//   B站：文字 ✓、表情占位 `[大笑]` ✓（就是文字）、图片评论 ✓（/x/v2/reply/add 的 pictures）；语音 ✗。

import { listStickers } from './stickers.mjs'

/** 颜文字池：短、不抢戏，落在一个"语气词"的位置。 */
export const KAOMOJI = [
  '(・_・;)', '(๑•̀ㅂ•́)و', '(￣▽￣)', '(´･ω･`)', '(＾▽＾)', '(>_<)',
  '(≧▽≦)', '(￣ε￣)', '(๑￫ܫ￩)', 'ヽ(￣ω￣(￣ω￣〃)ゞ', '(*/ω＼*)', '(´-ω-`)',
]

/** emoji 池：她常用的那批（困/无语/开心/比心），跟人设不打架。 */
export const EMOJI = ['😌', '😴', '🥺', '😤', '🫠', '🙈', '😹', '🤍', '🐟', '✨', '😮‍💨', '🍚', '💤', '🫧']

export const EXTS = {
  // 抖音评论的 input accept 就是这个集合（实测），给它别的后缀会直接被前端吞掉
  douyin: ['.png', '.webp', '.jpeg', '.pjpeg', '.bmp', '.jpg'],
  // B站图床：常规静态图都行，gif 也能传
  bilibili: ['.png', '.jpg', '.jpeg', '.gif', '.webp'],
}

const pickOne = (arr, random = Math.random) => arr[Math.floor(random() * arr.length) % arr.length]

/** 给一句回复加上 emoji 或颜文字（不会同时加，也不会加在已经有表情的句子上）。 */
export function decorateText(text, { emojiChance = 0.35, kaomojiChance = 0.2, random = Math.random } = {}) {
  const t = String(text || '').trim()
  if (!t) return t
  // 已经带 emoji / 颜文字 / 表情占位就别再叠了（真人不会一句话四个表情）
  if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(t)) return t
  if (/[（(][^)）]{0,6}[ω・´`∀≧▽￣ε][^)）]{0,6}[)）]/.test(t)) return t
  if (random() < kaomojiChance) return `${t} ${pickOne(KAOMOJI, random)}`
  if (random() < emojiChance) return `${t} ${pickOne(EMOJI, random)}`
  return t
}

/**
 * 挑一条回复的表达类型。
 * @param {{platform?: 'douyin'|'bilibili', styles?: object, allowImage?: boolean, random?: function}} o
 * @returns {'text'|'sticker'|'emoji-pack'|'image'|'voice'}
 *   text        —— 纯文字（可能被 decorateText 加个 emoji/颜文字）
 *   emoji-pack  —— 抖音官方表情面板里的表情（抖音专属；B站没有这个通道，会自动降级）
 *   sticker     —— 本地表情包图片当图片评论发
 *   image       —— 更"图片"一点的评论（同一套上传通道，语义上区别：贴纸 vs 图）
 *   voice       —— 语音（抖音：私信 mp4 语音条；B站：不支持 → 降级 text）
 */
export function chooseKind({ platform = 'douyin', styles = {}, allowImage = true, random = Math.random } = {}) {
  // auto:false = 主人一键收手，只发纯文字（调用方也在判，这里再兜一层，别让别的入口绕过去）
  if (styles.auto === false) return 'text'
  const s = {
    text: Number(styles.text ?? 0.6),
    emoji: Number(styles.emoji ?? 0.1),
    kaomoji: Number(styles.kaomoji ?? 0.1),
    sticker: Number(styles.sticker ?? 0.15),
    emojiPack: Number(styles.emojiPack ?? 0.1),
    image: Number(styles.image ?? 0.05),
    voice: Number(styles.voice ?? 0),
  }
  if (platform !== 'douyin') { s.emojiPack = 0; s.voice = 0 }   // 只有抖音有官方表情通道/语音
  if (!allowImage) { s.sticker = 0; s.image = 0 }
  const total = Object.values(s).reduce((a, b) => a + (b > 0 ? b : 0), 0)
  if (total <= 0) return 'text'
  let r = random() * total
  for (const [k, w] of Object.entries(s)) {
    if (w <= 0) continue
    r -= w
    if (r <= 0) {
      if (k === 'emoji') return 'text'      // emoji 只是把 emoji 塞进文字里，出口仍是文字
      if (k === 'kaomoji') return 'text'
      // 配置里写 emojiPack（驼峰），对外统一用 'emoji-pack'（命令层/日志都按这个匹配）
      return k === 'emojiPack' ? 'emoji-pack' : k
    }
  }
  return 'text'
}

/** 从她的表情包仓库里挑一张这个平台发得出去的图。返回绝对路径或 ''（没有可用素材）。 */
export function pickCommentImage({ platform = 'douyin', tag = '', random = Math.random } = {}) {
  const allowed = EXTS[platform] || EXTS.douyin
  const ok = (p) => allowed.some((e) => String(p).toLowerCase().endsWith(e))
  let all = []
  try {
    const store = listStickers()
    const tags = tag && store[tag] ? [tag] : Object.keys(store)
    for (const t of tags) for (const p of store[t] || []) if (ok(p)) all.push(p)
  } catch { /* 仓库读不到就算了 */ }
  if (!all.length) return ''
  return pickOne(all, random)
}

/** 抖音私信的"语音条"：把她的声音做成带音轨的 mp4（DM 的 file input 只吃 jpg/png/gif/mp4）。 */
export function voiceNoteArgs({ audioPath, coverPath, outPath }) {
  // 一帧封面 + 音轨 → 竖屏小视频（抖音 DM 里点开就能听）
  return [
    '-y', '-loop', '1', '-i', String(coverPath || ''), '-i', String(audioPath || ''),
    '-c:v', 'libx264', '-tune', 'stillimage', '-c:a', 'aac', '-b:a', '96k',
    '-pix_fmt', 'yuv420p', '-shortest', '-movflags', '+faststart', String(outPath || ''),
  ]
}

/** 汇总：这条回复最终以什么形式发出去（给日志/测试看的稳定字符串）。 */
export function describeKind(kind) {
  return ({ text: '文字', 'emoji': '文字', kaomoji: '文字', sticker: '表情包', 'emoji-pack': '官方表情', emojiPack: '官方表情', image: '图片', voice: '语音' })[kind] || '文字'
}