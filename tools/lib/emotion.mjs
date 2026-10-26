// 情绪层（L1）—— 把"她现在是什么心情"变成语音参数与参考音色
//
// 由来（10-26）：主人说"语音只有略微的语气变化，没有人类情感"。
// 实测：起伏能不能出来，主要取决于 ①参考音频（天花板）②采样参数 ③断句/停顿 ④文本标点。
// 这个文件负责 ②③ 的"按情绪取不同值"，并把她的回复里那个不可念的情绪标签解析出来。
//
// 标签写法（她自己写在回复最前面，或结尾）：
//   [[撒娇]]  或  [[情绪:委屈]]  或  【情绪：困】   【生气】
// 发送前必须 stripEmotionTags() 掉 —— 主人不该看到这些方括号。

export const EMOTIONS = {
  calm: {
    label: '平静', aliases: ['平静', '正常', '淡定', '没什么'],
    temperature: 1.30, speed: 1.00, pause: 0.28, rate: [4.2, 6.4],
  },
  happy: {
    label: '开心', aliases: ['开心', '高兴', '兴奋', '雀跃', '得意', '乐', '激动', '爽', '美'],
    temperature: 1.45, speed: 1.05, pause: 0.22, rate: [4.4, 6.8],
  },
  coquettish: {
    label: '撒娇', aliases: ['撒娇', '黏人', '卖萌', '娇', '腻'],
    temperature: 1.40, speed: 0.97, pause: 0.30, rate: [3.9, 6.2],
  },
  wronged: {
    label: '委屈', aliases: ['委屈', '难过', '低落', '丧', '伤心'],
    temperature: 1.30, speed: 0.95, pause: 0.40, rate: [3.8, 6.0],
  },
  angry: {
    label: '生气', aliases: ['生气', '恼', '不爽', '凶', '火', '火大', '气炸', '炸毛', '恼火'],
    temperature: 1.45, speed: 1.02, pause: 0.20, rate: [4.3, 6.8],
  },
  sleepy: {
    label: '困倦', aliases: ['困', '累', '疲惫', '没精神', '懒', '想睡'],
    temperature: 1.25, speed: 0.90, pause: 0.45, rate: [3.4, 5.6],
  },
  shy: {
    label: '害羞', aliases: ['害羞', '脸红', '羞', '不好意思'],
    temperature: 1.35, speed: 0.96, pause: 0.35, rate: [3.8, 6.0],
  },
  tender: {
    label: '温柔', aliases: ['温柔', '轻声', '软', '认真'],
    temperature: 1.30, speed: 0.95, pause: 0.32, rate: [3.9, 6.0],
  },
  surprise: {
    label: '惊讶', aliases: ['惊讶', '吃惊', '震惊', '咦', '意外'],
    temperature: 1.50, speed: 1.06, pause: 0.20, rate: [4.4, 6.8],
  },
}

/** 按名字/别名找情绪 key（大小写、空格、全半角都容忍）。找不到返回 '' */
export function findEmotion(name) {
  const n = String(name || '').trim().replace(/[\s:：]/g, '')
  if (!n) return ''
  for (const [key, e] of Object.entries(EMOTIONS)) {
    if (key === n || e.label === n) return key
    if ((e.aliases || []).includes(n)) return key
  }
  return ''
}

/** 情绪参数（含 key/label）。未知情绪按 calm 走。 */
export function emotionProfile(name) {
  const key = findEmotion(name) || 'calm'
  const e = EMOTIONS[key]
  return {
    key, label: e.label, temperature: e.temperature, speed: e.speed, pause: e.pause,
    // 语速窗口：委屈/困本来就该慢 —— 拿"平静的 4.2~6.4"去判它们，会把正常的一条判成不合格
    rateMin: (e.rate || [4.2, 6.4])[0],
    rateMax: (e.rate || [4.2, 6.4])[1],
  }
}

// [[撒娇]]  [[情绪:撒娇]]  【情绪：撒娇】  【撒娇】  以及 [撒娇]（单方括号只在名字对得上时才认，
// 免得把 [表情:开心] / B站 [doge] 这种正经表情码吃掉）
const TAG_ANY = /\[\[\s*([^[\]]{1,8}?)\s*\]\]|\[\s*(?:情绪\s*[:：]\s*)?([^[\]:：]{1,6})\s*\]|【\s*(?:情绪\s*[:：]\s*)?([^[\]【】:：]{1,6})\s*】/g

function isEmotionTagText(raw, name) {
  const n = String(name || '').trim()
  if (!n) return false
  if (findEmotion(n)) return true
  // [[...]] 和 【情绪:…】 是我们的暗号，定了形状就认，哪怕名字生造（她会自己编词，别让她白写）
  return /\[\[/.test(raw) || /情绪\s*[:：]/.test(raw)
}

/** 从回复里取情绪：只认"是个已知情绪名"的标签，别把 [笑哭] 之类的当情绪 */
export function parseEmotionTag(text) {
  const s = String(text ?? '')
  let found = ''
  for (const m of s.matchAll(TAG_ANY)) {
    const name = (m[1] || m[2] || m[3] || '').trim()
    const key = findEmotion(name)
    if (key && isEmotionTagText(m[0], name)) { found = key; break }
  }
  return { emotion: found, text: stripEmotionTags(s) }
}

/** 去掉情绪标签（只去我们那几种形状；[表情:…]、[doge] 这类表情码原样留着） */
export function stripEmotionTags(text) {
  return String(text ?? '')
    .replace(TAG_ANY, (raw, dbl, sq, cb) => (isEmotionTagText(raw, dbl || sq || cb) ? '' : raw))
    .replace(/\[\s*\]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/^\s+|\s+$/g, '')
}

/**
 * 把回复切成"像人发的语音条"：每条 ≤maxChars，最多 maxParts 条，剩下的走文字。
 * 真人发语音很少一口气念完一整段；长段一次合成也天然更平（实测长文本 F0 起伏反而分散）。
 */
export function splitVoiceParts(text, { maxChars = 60, maxParts = 3 } = {}) {
  const s = stripEmotionTags(text).replace(/\r/g, '')
  if (!s) return { parts: [], rest: '' }
  const sentences = s.match(/[^。！？!?…\n]+[。！？!?…]*/g) || [s]
  const parts = []
  let buf = ''
  let idx = 0
  for (; idx < sentences.length; idx++) {
    const sen = sentences[idx].trim()
    if (!sen) continue
    if (buf && (buf + sen).length > maxChars) { parts.push(buf); buf = '' }
    if (sen.length > maxChars && !buf) {
      // 单句过长：按 maxChars 硬切
      let rest = sen
      while (rest.length > maxChars && parts.length < maxParts) {
        parts.push(rest.slice(0, maxChars))
        rest = rest.slice(maxChars)
      }
      buf = rest
    } else {
      buf += sen
    }
    if (parts.length >= maxParts) break
  }
  if (buf) parts.push(buf)
  const used = parts.slice(0, maxParts)
  const spoken = used.join('')
  // 剩下的（没念到的句子）作为文字补发
  const rest = s.slice(s.indexOf(used[used.length - 1] || '') + (used[used.length - 1] || '').length).trim()
  return { parts: used, rest: spoken.length >= s.replace(/\s/g, '').length ? '' : rest }
}

/** 给人看的情绪清单（提示语/面板都用它，避免两处写死） */
export function emotionMenu() {
  return Object.values(EMOTIONS).map((e) => e.label).join(' / ')
}

/** 提示语里那段"语气暗号"。只有能发语音的平台才教她 —— 别在 B 站/抖音评论区教出方括号。 */
export function emotionTagPrompt(platform = 'qq') {
  if (platform !== 'qq' && platform !== 'wechat') return ''
  return '【语气的暗号】想让人听出你现在是什么心情时，在回复最前面写一个 [[' + '撒娇' + ']] 这样的标签，'
    + '可选：' + emotionMenu() + '。写一个就够，别写两个。'
    + '这个方括号不会显示给主人，只决定这条语音用哪种语气念 —— 所以放心用，它不占字数也不算表情。'
}