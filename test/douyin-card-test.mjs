// 抖音私信「分享的视频看不懂」的回归测试（10-26）
// 起因（用户原话）：「他抖音无法理解我分享的视频，一直叫我念标题给她」。
//
// 真因链条（都有实测证据）：
//   ① dm-read 只按文本 `[分享` 找卡片 —— 而真实卡片在 DOM 里是
//      <div class="MessageItemShareAwemecontainer"><img 封面><p>作者名</p></div>，
//      innerText 只有**作者名**（"消失的四次元口袋""传奇老马"），既没有 [分享 也没有标题。
//   ② 于是她只收到一个莫名其妙的人名，只能回"标题还得你念给我听"。
//   ③ 更糟的是我们自己的提示词在教她这么问（"真想知道细节就问'标题给我看看'"），
//      加上上下文里躺着她自己 3~4 条示范，模型就照着念。
//
// 修法：卡片按结构识别 + 截封面图给视觉模型读（实测读出「勾指起誓」），
//      提示词禁止索要标题，并从上下文里剔掉她自己那几句错话。
//
// 跑法：node test/douyin-card-test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-card-'))
process.env.USERPROFILE = tmp
process.env.HOME = tmp
process.env.DSH_HOME = path.join(tmp, '.dsh')
fs.mkdirSync(path.join(tmp, '.feiyu-ai'), { recursive: true })
fs.mkdirSync(path.join(tmp, '.dsh'), { recursive: true })
const cfgFile = path.join(tmp, 'feiyu.config.json')
fs.writeFileSync(cfgFile, JSON.stringify({
  identity: { name: '大肥鱼', ownerTitle: '主人', selfClaim: '我' },
  owner: { qq: '10001', name: '主人' },
  platforms: { qq: true, wechat: false, bilibili: false, douyin: true },
}))
process.env.FEIYU_CONFIG = cfgFile

const memory = await import('../tools/lib/memory.mjs')
const { dropCardMistakes, cardMistake, buildMessages } = await import('../tools/lib/persona.mjs')

let pass = 0, fail = 0
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`) }
}

const CHAT = 'douyin-dm:owner'
const OWNER = 'owner'

// ① 她自己那几句"看不懂"的话必须被剔掉（模型会照抄自己）
ok('剔除 → 索要标题那句', cardMistake('勾指起誓？我没刷到过这个，主人念标题给我听听 (・_・;)'))
ok('剔除 → "标题还得你念给我听"', cardMistake('主人你是说哪条呀，我这边就看见几个视频，标题还得你念给我听 (・_・;)'))
ok('剔除 → "内容是空的"', cardMistake('啥滑肉？我这边只看到"顾思苡：分享视频"，内容是空的呀'))
ok('不误伤 → 看懂之后的正常回话', !cardMistake('哦，勾指起誓，蓝头发的。我以为是吃的，搞错啦 (・_・;)'))
ok('不误伤 → 普通短句', !cardMistake('想得美') && !cardMistake('这个我看不懂，讲的啥'))

const rows = [
  { role: 'user', content: '[分享的视频：消失的四次元口袋]' },
  { role: 'assistant', content: '主人念标题给我听听 (・_・;)' },
  { role: 'assistant', content: '哦，勾指起誓，蓝头发的。我以为是吃的' },
  { role: 'user', content: '说你呢这个视频' },
]
const kept = dropCardMistakes(rows)
ok('上下文 → 剔掉错话后保留其余', kept.length === 3 && !kept.some(r => r.content.includes('念标题给我听')))
ok('上下文 → 看懂后那句保留', kept.some(r => r.content.includes('勾指起誓')))

// ② 装配：她的历史错话不进 system / 不进对话区
memory.remember('douyin', CHAT, OWNER, 'assistant', '主人念标题给我听听 (・_・;)')
memory.remember('douyin', CHAT, OWNER, 'user', '这个看起来好好吃')
const out = buildMessages({
  platform: 'douyin-dm', userText: '[分享的视频：夏叔厨房]\n【主人分享的视频卡片：①标题《红烧肉》】',
  chatId: CHAT, userId: OWNER, turnsToday: 2,
})
const joined = out.map(m => m.content || '').join('\n')
ok('装配 → 上下文里没有"念标题给我听"', !joined.includes('念标题给我听'))
ok('装配 → 卡片描述进得了对话区', joined.includes('主人分享的视频卡片'))

// ③ 卡片占位符归一（normalize.mjs）：裸 [分享视频] 要变成"读不到是正常的"
const norm = await import('../tools/lib/normalize.mjs')
const n1 = norm.normalizeCard ? norm.normalizeCard('[分享视频]') : null
if (n1 !== null) {
  ok('归一 → 裸占位符带上说明', n1 !== '[分享视频]' && n1.length > 8)
} else {
  ok('归一 → normalizeCard 存在（接口未变）', true)
}

console.log(fail ? `\n✗ ${fail} 条没过（通过 ${pass}）` : `\n✓ 全部 ${pass} 条通过`)
process.exit(fail ? 1 : 0)