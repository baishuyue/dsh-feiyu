// brain 装配测试（§9 + I7）：硬预算、三级诚实、群聊看不到私聊、微信口径只在被问时出现。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-brain-prompt-'))
process.env.FEIYU_DATA_DIR = tmp
process.env.USERPROFILE = tmp
process.env.HOME = tmp
process.env.DSH_HOME = path.join(tmp, '.dsh')
process.env.FEIYU_BRAIN_MIRROR = '0'

let bad = 0
const ok = (name, pass, detail = '') => {
  if (!pass) bad++
  console.log(`${pass ? '  ✓' : '  ✗'} ${name}${detail ? ' —— ' + detail : ''}`)
}

const event = await import('../tools/brain/event.mjs')
const episode = await import('../tools/brain/episode.mjs')
const assemble = await import('../tools/brain/assemble.mjs')

const now = Date.now()
// 私聊里的一条暗号（群聊里绝不能出现）
event.emit({ proc: 'p', platform: 'qq', chatId: 'qq:1', userId: '1', role: 'user', text: '私聊暗号ZZZ 我今天吃了烧鸭饭', isOwner: true, msgId: 'p1' })
// 群里的一条
event.emit({ proc: 'p', platform: 'qq', chatId: 'qq:900', userId: '2', role: 'user', text: '群里在聊烧鸭饭', isGroup: true, groupId: '900', msgId: 'p2' })
episode.ingest({ limit: 20 })

const dm = assemble.assemble({ platform: 'qq', chatId: 'qq:1', userId: '1', userText: '在吗', isGroup: false, now })
const sys = dm.messages[0].content
ok('装配出了 system + user', dm.messages.length >= 2 && dm.messages[0].role === 'system')
ok('三级诚实块在', /怎么说话才算不糊弄他/.test(sys) && /记不清/.test(sys))
ok('旧的绝对禁令已撤（不许说"我不知道"那种话没了）', !/绝对不许说"我不知道"/.test(sys))
ok('保留"绝对不许说这事没发生过"（记不清不等于没发生）', /没发生过/.test(sys))
ok('私聊能看到自己那条暗号', sys.includes('私聊暗号ZZZ'), `${sys.includes('私聊暗号ZZZ')}`)

const grp = assemble.assemble({ platform: 'qq', chatId: 'qq:900', userId: '2', userText: '烧鸭饭好吃吗', isGroup: true, now })
const gsys = grp.messages[0].content
ok('群聊装配里没有私聊暗号（I6）', !gsys.includes('私聊暗号ZZZ'))
ok('群聊装配里有群聊那条', gsys.includes('烧鸭饭'))

// 微信口径：只在被问到时出现
const wx = assemble.assemble({ platform: 'qq', chatId: 'qq:1', userId: '1', userText: '你微信上怎么没回我', isGroup: false, now })
ok('被问微信时给出统一口径', /微信那边/.test(wx.messages[0].content))
const plain = assemble.assemble({ platform: 'qq', chatId: 'qq:1', userId: '1', userText: '在吗', isGroup: false, now })
ok('没问微信时不多嘴', !/微信那边/.test(plain.messages[0].content))

// 预算：压到 800 字，必须截断且不超
const tight = assemble.assemble({ platform: 'qq', chatId: 'qq:1', userId: '1', userText: '在吗', isGroup: false, now, budget: 800 })
ok('预算 800 时字数不超', tight.chars <= 800, `实际 ${tight.chars}`)
ok('预算 800 时记了截断明细', tight.dropped.length > 0, JSON.stringify(tight.dropped.map((d) => d.key)))
ok('预算再紧也保住身份层和诚实层', /大肥鱼/.test(tight.messages[0].content) && /怎么说话才算不糊弄他/.test(tight.messages[0].content))

// 默认预算（5650）下的字数
const def = assemble.assemble({ platform: 'qq', chatId: 'qq:1', userId: '1', userText: '在吗', isGroup: false, now })
ok('默认装配 ≤ 5650 字', def.chars <= 5650, `${def.chars} 字`)

console.log(bad ? `\n✗ ${bad} 项没过` : '\n✓ 全部通过')
process.exit(bad ? 1 : 0)