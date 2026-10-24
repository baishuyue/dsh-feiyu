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

  // LLM 直连（QQ/抖音的实时响应用；B站那套塞 DSH 会话零费，这里直连按 token 计费）
  llm: {
    base_url: 'https://api.deepseek.com/v1',   // 也可换硅基流动 / Ollama / OneAPI
    api_key: '',                                // 优先读环境变量 DEEPSEEK_API_KEY；也可直接写这里
    model: 'deepseek-chat',
    temperature: 0.92,
    max_tokens: 600,
    // 写脚本/文案用另一套参数（dafeiyu 的设计：聊天口癖别污染内容）
    content_model: 'deepseek-chat',
    content_temperature: 0.7,
  },

  // QQ（NapCat / OneBot v11）
  qq: {
    enabled: false,
    napcat_http: 'http://127.0.0.1:3000',   // NapCat HTTP 服务器地址（在 NapCat WebUI 配置）
    allow_groups: [],                        // 空 = 全部群
    at_only: true,                           // 群里只被 @ 才回（铁律）
    voice_enabled: false,                    // 语音条开关
    voice_chance: 0.15,                      // 回复用语音的概率
    qzone_enabled: false,                    // 发空间说说开关
  },

  // 语音（GPT-SoVITS 本地音色克隆；xiaoxiao 音色）
  voice: {
    sovits_url: 'http://127.0.0.1:9880/tts',  // GPT-SoVITS api_v2.py 的 tts 端点
    ref_audio_path: '',                       // 参考音频绝对路径（可选）
    prompt_text: '今天也要好好吃饭',           // 参考文本
    prompt_lang: 'zh',
    text_lang: 'zh',
    media_type: 'wav',
    streaming_mode: false,
    // 语音服务（GPT-SoVITS）随 DSH 自动拉起，避免"有开关没声音"
    autoStartSovits: true,
    sovitsCmd: 'D:/GPT-SoVITS/.venv/Scripts/python.exe',
    sovitsScript: 'D:/GPT-SoVITS/api_v2.py',
  },

  // 抖音（social-auto-upload 发布）
  douyin: {
    enabled: false,
    account: 'creator',                        // sau 账号别名
    // 评论不带 @（LockyBee 结论：公开评论含 @ 是抖音风控主因）；显式开才真 @
    atMention: false,
    // 看到有意思的视频，直接分享给主人（替代评论 @）；每天最多 shareDaily 条
    shareToOwner: false,
    shareDaily: 1,
    shareVia: 'douyin',    // douyin=抖音私信发视频链接+评论 / qq=QQ私聊 / both=两边都发
    owner: { name: '' },   // 主人抖音昵称（私信分享目标）
    // 自主观看时也以"自学习人格"发评论（受 douyin.dryRun 控制，默认只演练）
    autoComment: false,
    watch: { enabled: false, durationMin: 10, maxVideos: 3, dry: true },
    // 私信陪聊（参照 QQ 模式）：常驻轮询主人私信，新消息→LLM 回
    dm: { enabled: false, pollSec: 20, port: 8090 },
  },
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
