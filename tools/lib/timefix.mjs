// timefix —— 「主人多久没说话」的防捏造（10-25 用户实锤的那类 bug）
//
// 事故现场：17:30:39 主人还在聊天，17:43 她说「主人你消失了整整四天啊」，18:06「快四天没影了」，
// 20:42 又「主人你这四天去哪了呀」——主人当场纠正过（「哪里有四天那么久」），她还是照说不误。
// 原因不是模型坏，是上下文里没有真实时长：她只能靠"一阵子"这种模糊话自己换算，换错了又写进记忆，
// 下一轮看见自己"说过四天"，就更笃定了。
//
// 这里只做两件事：
//   gapText(ms)              —— 真实间隔说成人话（"2 小时 46 分"），喂 prompt 当唯一可信来源
//   sanitizeDayClaims(t, ms) —— 兜底：真实间隔不到一天时，把"消失四天/好几天没影"掰回"一会儿/刚才"
//
// ⚠️ 只认「主人的缺席」句式。不能见 N天 就换 —— "好几天没吃顿好的"说的是吃饭，不是主人没来。

const CN = '一二三四五六七八九十两0-9'

/** 真实间隔 → 人话。不到 1 分钟说"几十秒"，不到 1 小时说分钟，否则"X 小时 Y 分"。 */
export function gapText(ms) {
  const m = Math.max(0, Math.floor(Number(ms) / 60000))
  if (m < 1) return '几十秒'
  if (m < 60) return `${m} 分钟`
  const h = Math.floor(m / 60)
  const rest = m % 60
  if (h < 24) return rest ? `${h} 小时 ${rest} 分` : `${h} 小时`
  const d = Math.floor(h / 24)
  return `${d} 天 ${h % 24} 小时`
}

// 「缺勤」语义的词：只有这些词在附近，天数才是在说"主人多久没来"
const ABSENT = '(?=没影|不见|没来|没理|没声|没消息|不说话|没说话|不出现|去哪|干啥|干什么|跑哪|招呼)'

/** 回复里有没有编造"主人缺席了 N 天"（"四天/整整三天/好几天"）。 */
export function mentionsDays(text) {
  const s = String(text ?? '')
  const n = `(?:整整?)?[${CN}]+\\s*天`
  return new RegExp(`消失(?:了)?\\s*${n}`).test(s)
    || new RegExp(`${n}\\s*${ABSENT}`).test(s)
    || new RegExp(`你这?\\s*${n}\\s*${ABSENT}`).test(s)
    || new RegExp(`好几天\\s*${ABSENT}`).test(s)
}

/**
 * 真实间隔不到一天时，把"缺席天数"换成"一会儿/刚才"。超过一天原样返回（那时候说天是对的）。
 * 顺序有讲究：先处理"消失N天"，否则会被后面的裸规则切成"消失刚才"。
 */
export function sanitizeDayClaims(text, gapMs) {
  let s = String(text ?? '')
  if (!s || Number(gapMs) >= 24 * 3600_000) return s
  const n = `(?:整整?)?[${CN}]+\\s*天`
  // ① 消失了 N 天
  s = s.replace(new RegExp(`消失(?:了)?\\s*${n}`, 'g'), '消失了好一会儿')
  // ② 你这 N 天去哪了（必须排在裸规则前面，否则会留下"你这好一会儿"）
  s = s.replace(new RegExp(`你这?\\s*${n}\\s*${ABSENT}`, 'g'), '你刚才')
  // ③ 快 N 天没影了
  s = s.replace(new RegExp(`快\\s*${n}\\s*(?=没影|不见|没来|没理|没消息)`, 'g'), '好一会儿')
  // ④ N 天没影/不见
  s = s.replace(new RegExp(`${n}\\s*${ABSENT}`, 'g'), '好一会儿')
  // ⑤ 好几天没影/没消息
  s = s.replace(new RegExp(`好几天\\s*${ABSENT}`, 'g'), '好一会儿')
  return s
}
