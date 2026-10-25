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
  // 额度（0 = 不限，随便玩；克制是活下来的前提，但这是你的鱼）
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

  // AI 表情包自动生成（10-25 新增）：Pollinations flux 免费无 key，直连被墙走本机 Clash。
  // QQ 回复里图库没有的标签 / 自制表情 → 异步生成入库补发；B站图片评论同源。
  imageGen: {
    enabled: true,
    model: 'flux',
    dailyMax: 30,                      // 每天最多生成几张（0 = 不限），防免费档被刷限流
    proxy: 'http://127.0.0.1:7897',    // 空串 = 直连（机器能出墙时可清掉）
    refImage: '',                      // 图生图参考图（本地路径或 http 链接）——形象锚定，形象才"像"
  },

  // 视觉理解（10-25 框架就位，等视觉模型 key 点亮）：watch 自主观看截 N 帧 → 多模态描述 → 注入决策。
  // DeepSeek 的 key 不支持视觉；provider 四样全配齐才启用（provider/base_url/model/api_key），没配=静默跳过。
  vision: {
    provider: 'none',        // none=关 | openai=OpenAI 兼容 chat/completions（智谱/硅基流动/OpenAI 都走这个）
    base_url: '',            // 如 https://open.bigmodel.cn/api/paas/v4 或 https://api.siliconflow.cn/v1
    model: '',               // 如 glm-4v-plus / Qwen/Qwen2.5-VL-72B-Instruct / gpt-4o-mini
    api_key: '',             // 也可用环境变量 VISION_API_KEY
    maxFrames: 3,            // 每条视频最多喂几帧
  },

  // 专业唱歌（10-25）：RVC 翻唱——真歌干声换她的音色再混伴奏（AI 孙燕姿同款管线）。
  // 依赖 D:/rvc（RVC 仓库+venv，见 rvc.mjs）；她的歌单在 ~/.feiyu-ai/songs/。
  rvc: {
    root: 'D:/rvc/RVC',
    python: 'D:/rvc/venv/Scripts/python.exe',
    ffmpeg: 'D:/GPT-SoVITS/runtime/ffmpeg.exe',
  },
  sing: {
    search: true,            // QQ 点唱没学会的歌时，自动搜源歌学（yt-dlp 走代理）
    searchDaily: 3,          // 每天最多搜几首新的（0 = 不限），防跑飞
    proxy: 'http://127.0.0.1:7897',
  },

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
    at_only: true,                           // 群里只被 @ 才回；设 false = 群里所有消息都回（像私聊一样）
    voice_enabled: false,                    // 语音条开关
    voice_chance: 0.15,                      // 回复用语音的概率
    sing: true,                              // 唱歌开关（"唱一首"触发：LLM 写词+她的音色逐句+鼓点混音）
    qzone_enabled: false,                    // 发空间说说开关
    // 主动搭话（B站同款自主性）：主人安静久了她会带着由头主动开口。
    // 随机拟人不定点；正聊着不打扰；每天有上限 —— 宁可少说不刷屏。
    proactive: {
      enabled: false,
      dailyMax: 3,          // 每天最多主动找主人几次（0 = 不限）
      minQuietMin: 90,      // 主人安静至少这么久才开口（最近在聊就别插话）
      minGapMin: 150,       // 两次主动之间的最小间隔
      activeHours: [10, 23],// 活跃时段（10:00~23:00 之外不打扰）；null = 不限时（10-25 用户拍板可关）
      chance: 0.12,         // 每 60s tick 命中概率（不定点闹钟，随机开口）
    },
    // 群聊自主插话（10-25）：不等 @，她自己看着群聊决定要不要接话。
    // 趁话题正热（recentSec 内有人说话）+ 稍微等一下（minQuietSec 不抢话）+ 概率 + 双额度。
    groupChat: {
      enabled: true,
      recentSec: 600,       // 群里最近这么久有人说话才算"话题在场"
      minQuietSec: 20,      // 最后一条消息至少隔这么久（不抢话）
      minGapMin: 20,        // 同一个群两次插话最小间隔
      dailyMax: 6,          // 每个群每天最多插话几次（0 = 不限）
      chance: 0.1,          // 每 60s tick 命中概率
      recentN: 14,          // 决策时喂最近几条群聊
    },
    // 自主写说说（10-25）：她自己的见闻+心情 → 攒着劲发 QQ 空间说说（可文配图，图生图鲸鱼娘）。
    qzoneAuto: {
      enabled: true,
      dailyMax: 2,          // 每天最多发几条（0 = 不限）
      minGapMin: 240,       // 两条说说最小间隔（分钟）
      chance: 0.15,         // 每 30 分钟 tick 命中概率
      imageChance: 0.5,     // 配图概率
    },
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
    // 看到有意思的视频，直接分享给主人（替代评论 @）；每天最多 shareDaily 条（0 = 不限）
    shareToOwner: false,
    shareDaily: 5,
    // 真发评论的每日上限（自由刷不限量跑通宵，评论必须设顶，防 shadowban；0 = 不限）
    commentDaily: 8,
    shareVia: 'douyin',    // douyin=抖音私信发视频链接+评论 / qq=QQ私聊 / both=两边都发
    owner: { name: '' },   // 主人抖音昵称（私信分享目标）
    // 自主观看时也以"自学习人格"发评论（受 douyin.dryRun 控制，默认只演练）
    autoComment: false,
    watch: { enabled: false, durationMin: 10, maxVideos: 3, dry: true, silent: false },
    // 自由刷：大肥鱼自己长时间刷抖音看世界，不限条数/时长（unlimited），限度可调。
    // unlimited=true 时刷到「每日分享额度用完」或手动停；unlimited=false 按 maxVideos/maxMinutes。
    freeRoam: { enabled: false, unlimited: true, maxVideos: 0, maxMinutes: 0, restMin: 3 },
    // 私信陪聊（参照 QQ 模式）：常驻轮询主人私信，新消息→LLM 回
    // 端口默认 8095：8090 常被 Wondershare 推送组件（WsToastNotification.exe）抢占，绑不上
    dm: { enabled: false, pollSec: 300, port: 8095 },
  },

  // B站（生物钟在 night 段；这里放自由刷的限度 + 活人感写通道）
  bilibili: {
    // 自由刷：评论区 @ 主人那套。unlimited=true 不限条数/时长，刷到每日分享额度用完或手动停。
    freeRoam: { enabled: false, unlimited: true, maxVideos: 0, maxMinutes: 0, restMin: 5 },
    // 观看历史上报（debrief 后记入历史）
    reportHistory: true,
    // ── 活人感写通道（默认全关：养好号再开；每项独立开关 + 日额度 bili-actions.json，0 = 不限）──
    danmaku: { enabled: false, dailyMax: 5 },                       // 看视频发弹幕（bili-watch 顺手 / act 命令）
    dynamic: { enabled: false, dailyMax: 2, times: ['09:30', '21:30'] }, // 潜水日志动态（早晚定时 + 复盘后同步）
    react: { like: false, coin: false, likeDaily: 10, coinDaily: 1 },// 点赞（debrief 顺手）/投币（评分≥17）
    imageComment: { enabled: false, dailyMax: 2 },                  // 图片评论（贴纸/生图 → B站图床）
    replies: { enabled: false, dailyMax: 10 },                      // 回应别人对我评论的回复（replies 命令）
    fishCircle: { enabled: false },                                 // 鱼圈社交：选题加入「大肥鱼」相关视频
    follow: { enabled: false },                                     // 关注好 UP（act follow）
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
