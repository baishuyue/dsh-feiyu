// 统一配置层 —— 一个文件承载所有"属于使用者"的东西。
// 设计来自 dsh-bili-whale 的 tools/lib/config.mjs（MIT），
// 默认值融合 dafeiyu 骨架的 config.yaml（guard / preferences / 作息哲学）。
//
// 查找顺序：$FEIYU_CONFIG → ~/.dsh/feiyu.config.json → 内置默认值
import fs from 'node:fs'
import { configPath } from './paths.mjs'

export { configPath } from './paths.mjs'

/** 中性默认值：换个账号也能跑；所有"个人化"的东西请写进配置文件。 */
export const DEFAULTS = {
  // 身份三件套（拼成一行注入提示）+ 专属人设文件（~/.feiyu-ai/persona.md，优先级更高）
  identity: {
    name: '大肥鱼',      // 她叫什么
    ownerTitle: '主人',  // 她怎么称呼你
    selfClaim: '我',     // 她怎么自称
  },
  // 你本人（分享型评论要 @ 的人）：mid 用于校验，name 用于正文 @
  owner: { mid: '', name: '' },
  // 作息（来自 bili-whale night-plan；跨零点自动处理；wakes = 每窗口醒几次，硬上限 12）
  night: {
    windows: [{ start: '20:00', end: '24:00', wakes: 1 }],
    skipChance: 0.3,   // 30% 概率今天不想看（她也有权利不看）
    minGapMin: 10,
    maxVideos: 5,
  },
  // 口味（feed 选题的权重来源；来自 dafeiyu 骨架的 preferences）
  preferences: {
    like: ['AI 与 Agent 工具', '鬼畜与怀旧', '猫咪', '美食（尤其是白饭相关）'],
    dislike: ['带货', '擦边', '标题党', '纯搬运'],
    keywords: [],       // 额外搜索词
  },
  // 分享标尺（来自 bili-whale：评分不够 = 今天没有值得发的，是合法结果 ✓）
  share: { enabled: true, via: 'comment', minScore: 13 },   // via: comment | dm
  // 额度（克制是活下来的前提）
  quota: { shareDaily: 3, sameVideoDays: 7 },
  // 风控闸门（来自 dafeiyu 骨架 ops/guard.py 的设计）
  guard: {
    dryRun: true,       // ⚠️ 默认干跑：只打印不真发。观察一周后再改 false
    minGapSec: 25,      // 同一"会话"两条消息最小间隔
    dupThreshold: 0.6,  // 3-gram Jaccard 超过即判复读
    banned: ['作为AI', '语言模型', '无法协助', '作为一个'],
  },
  // 日记（写日记不可关；push 留给将来的通知渠道）
  diary: { push: false },
}

const merge = (base, over) => {
  const out = { ...base }
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = (v && typeof v === 'object' && !Array.isArray(v)) ? merge(base[k] ?? {}, v) : v
  }
  return out
}

/** 读取合并后的配置（不缓存：改完保存立刻生效 —— bili-whale 的实战要求）。 */
export function config() {
  let user = {}
  try { user = JSON.parse(fs.readFileSync(configPath, 'utf8')) } catch { /* 没配置就用默认 */ }
  const cfg = merge(DEFAULTS, user)
  cfg.__hasUserFile = Object.keys(user).length > 0
  return cfg
}
