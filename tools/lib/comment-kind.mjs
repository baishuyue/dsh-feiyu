// comment-kind —— 一条评论到底是"文字 / 只有 emoji / 图片 / 表情包 / 空"。
//
// 为什么要有这个文件（10-27 主人报的 bug）：
//   抖音那边她只回了主人的文字评论，别人发**表情包**的那条一直没反应。根因是上层一句
//   `if (!c.text) continue` —— 纯表情包评论的 text 是空串，整条被当成"没有内容"丢掉。
//   B站同理：图片评论（content.pictures）没有字、只有 `[大笑]` 的评论剥掉占位也没有字。
//   现在统一在这里判类型，两个平台都按 label/kind 交给 LLM，**任何类型都有话可说**。
//
// 约定：
//   kind = 'text'    有真文字（剥掉 [微笑] 这类占位后还剩字）
//        | 'emote'   只有 `[微笑]` 这种 emoji 占位
//        | 'sticker' 抖音表情包贴纸（有 sticker 名字，没有字）
//        | 'image'   图片评论（pictures > 0，没有字）
//        | 'empty'   什么都没有（只剩贴纸/被折叠）
//   label = 给她看的"这条评论说了什么"：文字原样，其余给一句人话描述。

const EMOJI_PLACEHOLDER = /\[[^\]\n]{1,10}\]/g

/** 剥掉 `[微笑]` 这类占位、零宽字符和空白，看还剩不剩真字。 */
export function plainText(s) {
  return String(s ?? '')
    .replace(EMOJI_PLACEHOLDER, '')
    .replace(/[\u200b-\u200f\ufe0f]/g, '')
    .replace(/\s+/g, '')
}

/**
 * 判类型 + 给一句人话描述。两个平台的字段名不完全一样，这里统一收口。
 * @param {{text?:string, message?:string, sticker?:string, hasSticker?:boolean, pictures?:number|any[], emote?:object}} raw
 * @returns {{kind:string,label:string,plain:string,text:string,sticker:string,pictures:number}}
 */
export function classifyComment(raw = {}) {
  const text = String(raw.text ?? raw.message ?? '').trim()
  const sticker = String(raw.sticker ?? raw.sticker_name ?? '').trim()
  // 「有没有贴纸」和「贴纸叫什么」是两件事：抖音的贴纸名字常是哈希，剥完就空了，
  // 但这条评论**确实是**表情包（10-27 实测：靠名字判会把整条又判成空评论）。
  const hasSticker = Boolean(raw.hasSticker ?? raw.has_sticker ?? sticker)
  let pictures = raw.pictures ?? raw.pics ?? 0
  if (Array.isArray(pictures)) pictures = pictures.length
  else if (pictures && typeof pictures === 'object') pictures = Object.keys(pictures).length
  pictures = Number(pictures) || 0
  const plain = plainText(text)
  if (plain) return { kind: 'text', label: text, plain, text, sticker, pictures }
  if (hasSticker) {
    // 抖音贴纸的 display_name 有时是 URL/哈希文件名 —— 别把链接或乱码念给她听
    const nice = /^https?:/i.test(sticker) || /^[A-Za-z0-9_\-~.]{12,}$/.test(sticker) ? '' : sticker
    return { kind: 'sticker', label: nice ? `（发了张表情包：${nice}）` : '（发了张表情包，没有文字）', plain: '', text, sticker, pictures }
  }
  if (pictures) return { kind: 'image', label: `（发了 ${pictures} 张图，没有文字）`, plain: '', text, sticker, pictures }
  if (text) return { kind: 'emote', label: text, plain: '', text, sticker, pictures }
  return { kind: 'empty', label: '（空评论，可能只有贴纸或已被折叠）', plain: '', text, sticker, pictures }
}

/** 这条能不能回（现在什么类型都能回，只有完全空的才不建议硬凑）。 */
export function replyable(kind) {
  return kind !== 'empty'
}

/** 表情包/图片这种"没字"的评论，LLM 万一也憋不出话时的兜底回复（轮换，别老一句）。 */
export function stickerFallback(label = '', seed = 0) {
  const s = String(label)
  const pool = /图|照/.test(s)
    ? ['这张图我存了，笑死', '图收下了，谢谢你的图', '哈哈这图不错，本鱼收藏了']
    : /表情|贴纸/.test(s)
      ? ['这个表情包赏你了，回你一个', '表情包收到了，笑死我了', '哈哈这个表情好可爱']
      : ['看到了，说不出话是吧', '你这条我收到了，笑死', '不会说话就用表情，懂的都懂']
  return pool[Math.abs(Number(seed) || 0) % pool.length]
}