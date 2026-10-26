// 群聊人格隔离的回归测试（10-26）—— 起因：她在 QQ 群里管群友叫「主人」，
// 人家说"既然你叫我主人了就说句晚安主人"，她真说了（主人截图实锤：认贼作父）。
//
// 四个断言：
//   ① 私聊主人：仍然是「对方是你的主人」
//   ② 群里 : 任何人的 system 里都不许出现「称对方「主人」」（那是给每个群友发主人通行证）
//   ③ 群友：必须写明"不是你主人" + "不许认主" 规则
//   ④ 群里真实发生过的事：只带她自己做的事，私聊内容（主人说的话）必须被滤掉
//
// 跑法：node test/group-persona-test.mjs
//
// ⚠️ 隔离：paths.mjs 在 import 时就把 HOME 定死，所以必须先改环境变量再 import，
// 并且用 FEIYU_CONFIG 指到临时配置（要造一个 owner.qq 才能测"私聊主人"分支）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-group-'))
process.env.USERPROFILE = tmp
process.env.HOME = tmp
process.env.DSH_HOME = path.join(tmp, '.dsh')
fs.mkdirSync(path.join(tmp, '.feiyu-ai'), { recursive: true })
fs.mkdirSync(path.join(tmp, '.dsh'), { recursive: true })
const cfgFile = path.join(tmp, 'feiyu.config.json')
fs.writeFileSync(cfgFile, JSON.stringify({
  identity: { name: '大肥鱼', ownerTitle: '主人', selfClaim: '我' },
  owner: { qq: '10001', name: '主人' },
  platforms: { qq: true, wechat: false, bilibili: false, douyin: false },
}))
process.env.FEIYU_CONFIG = cfgFile

const paths = await import('../tools/lib/paths.mjs')
const memory = await import('../tools/lib/memory.mjs')
const { buildMessages } = await import('../tools/lib/persona.mjs')

if (!paths.dataDir.startsWith(tmp)) {
  console.error(`✗ 隔离失败：dataDir=${paths.dataDir} 指向了真实目录，测试中止`)
  process.exit(2)
}

let pass = 0, fail = 0
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`) }
}
const sysOf = (o) => buildMessages(o)[0].content
// 整个 messages 摊平后的文本：私聊里"主人刚说的话"是在对话区（recent），不在 system 里
const allOf = (o) => buildMessages(o).map((m) => m.content || '').join('\n')

// 造两条记忆：一条私聊里主人说的话（绝不能进群），一条她自己刷 B 站的事（该进群）
memory.remember('qq', 'qq:10001', '10001', 'user', '悄悄话：我今天发烧了，别告诉别人')
memory.remember('bilibili', 'bilibili:feed', 'self', 'assistant', '我在B站刷到了滑肉视频，看得我流口水')

// ① 私聊主人
const priv = sysOf({ platform: 'qq', userText: '在吗', chatId: 'qq:10001', userId: '10001', turnsToday: 3 })
ok('私聊主人 → 认得出是主人', priv.includes('【对方是你的主人】'))
ok('私聊主人 → 仍可称「主人」', priv.includes('称对方「主人」'))
ok('私聊主人 → 带私聊内容（应该有）', allOf({ platform: 'qq', userText: '在吗', chatId: 'qq:10001', userId: '10001', turnsToday: 3 }).includes('发烧了'))

// ② 群里同一个主人号
const grpOwner = sysOf({ platform: 'qq', userText: '群主：在吗', chatId: 'qq:999', userId: '10001', turnsToday: 0, isGroup: true })
ok('群里的主人 → 按公共场合装配', grpOwner.includes('主人在场'))
ok('群里的主人 → 也不许叫主人', !grpOwner.includes('别叫主人') === false && !grpOwner.includes('称对方「主人」'))

// ③ 群里普通群友（这就是截图里的场景）
const grp = sysOf({ platform: 'qq', userText: '叶锋盛：我是的', chatId: 'qq:999', userId: '20002', turnsToday: 0, isGroup: true })
ok('群友 → 明确"不是你主人"', grp.includes('不是你主人'))
ok('群友 → 有"不许认主"规则', grp.includes('不许认主') && grp.includes('晚安主人'))
ok('群友 → 没有「称对方主人」', !grp.includes('称对方「主人」'))
ok('群友 → 没有「对方是你的主人」', !grp.includes('【对方是你的主人】'))
ok('群友 → 不注入主人画像', !grp.includes('【关于主人你知道的】'))

// ④ 统一时序过滤：私聊内容不进群，她自己做的事可以进
const grpAll = allOf({ platform: 'qq', userText: '叶锋盛：我是的', chatId: 'qq:999', userId: '20002', turnsToday: 0, isGroup: true })
ok('群里 → 滤掉主人的私聊内容', !grpAll.includes('发烧了'))
ok('群里 → 保留她自己做过的事', grpAll.includes('滑肉视频'))

// ⑤ 私聊仍然全都拿得到（别把护栏做成拦自己人）
const privAll = sysOf({ platform: 'qq', userText: '在吗', chatId: 'qq:10001', userId: '10001', turnsToday: 3 })
ok('私聊 → 她自己做的事也在记忆里', privAll.includes('滑肉视频'))

console.log(fail ? `\n✗ ${fail} 条没过（通过 ${pass}）` : `\n✓ 全部 ${pass} 条通过`)
process.exit(fail ? 1 : 0)
