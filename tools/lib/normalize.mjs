// normalize —— 记忆文本的"占位符/死链"正规化。
//
// 来自 dsh-world 的做法（src/history.ts shortenLocalImages）：喂给模型之前，把
// **看得见但读不到**的东西换成明确的占位符，模型就不会为"打不开"道歉或瞎编。
//
// 我们的老账（10-25 实锤两次）：主人分享视频 → 她反复说「我这边只看到『顾思苡：分享视频』，
// 内容是空的呀」。根因不是模型笨，是记忆里存的是裸占位符 `[分享视频]`，她只能照字面理解。
// 正确做法：写进记忆之前就把它标成"占位符，本来就读不到"。

// 失效的本地图片链接（DSH/面板端口每次都换，链接必然死）→ [图片]、[表情包]
const LOCAL_IMAGE = /!\[([^\]]*)\]\(https?:\/\/(?:127\.0\.0\.1|localhost):\d+([^)\s]*)\)/g
// 裸分享卡片：`[分享视频]`、`[分享的音乐]` 等 → 带解释的占位符（幂等：已带括号说明的不会再匹配）
const BARE_CARD = /\[(分享视频|分享的音乐|分享的直播|视频卡片|卡片)\]/g

/** 记忆写入前的归一（幂等）。 */
export function normalizeMemoryText(text) {
  let t = String(text ?? '')
  t = t.replace(LOCAL_IMAGE, (_m, alt) => `[图片${alt ? '：' + alt : ''}]`)
  t = t.replace(BARE_CARD, (m, kind) => `[${kind}（只有卡片标题，正文看不到是正常的）]`)
  return t
}

/** 拼进 prompt 的一句提醒（只在记忆里出现过占位符时才用）。 */
export function placeholderHint() {
  return '（记忆里的「[分享视频（…）]」「[图片]」是**占位符**：卡片正文本来就读不到，这是正常的 —— '
    + '直接顺着他说的话聊，想问细节就问"分享的哪个呀，标题给我看看"，绝不要为"看不到"道歉或解释。）'
}

/** 这段文本里有没有占位符（决定要不要拼上面那句提醒）。 */
export function hasPlaceholder(text) {
  return /（只有卡片标题|\[图片[：\]]/.test(String(text ?? ''))
}
