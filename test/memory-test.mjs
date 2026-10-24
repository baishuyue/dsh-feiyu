/**
 * QQ 记忆层测试：独立记忆文件 / 滚动摘要 / 主人画像 / 称呼不再是 QQ 号。
 * 跑法：node test/memory-test.mjs
 *
 * 关键手法：在 import 业务模块**之前**把 USERPROFILE 指到临时目录，
 * paths.mjs 就会把记忆写到那儿，不会污染真实数据。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-mem-'))
process.env.USERPROFILE = tmp
process.env.HOME = tmp
delete process.env.DSH_HOME
const cfgPath = path.join(tmp, 'feiyu.config.json')
fs.writeFileSync(cfgPath, JSON.stringify({
  identity: { name: '大肥鱼', ownerTitle: '主人', selfClaim: '我' },
  owner: { qq: '3082864371', name: '友利奈绪', mid: '3493288510228945' },
  llm: { api_key: 'x' },
}))
process.env.FEIYU_CONFIG = cfgPath

const memory = await import('../tools/lib/memory.mjs')
const qqMemory = await import('../tools/lib/qq-memory.mjs')
const persona = await import('../tools/lib/persona.mjs')

const dataDir = path.join(tmp, '.feiyu-ai')
const QQ_EP = path.join(dataDir, 'qq', 'episodes.jsonl')
const WX_EP = path.join(dataDir, 'wechat', 'episodes.jsonl')
const MAIN_EP = path.join(dataDir, 'episodes.jsonl')

// 1) QQ 的记忆写进独立文件，微信写主文件
memory.remember('qq', 'qq:3082864371', '3082864371', 'user', '在吗')
memory.remember('qq', 'qq:3082864371', '3082864371', 'assistant', '在的，主人。')
memory.remember('wechat', 'wechat:wxid_a', 'wxid_a', 'user', '微信来的消息')

assert.ok(fs.existsSync(QQ_EP), 'QQ 应该有独立的 episodes 文件：' + QQ_EP)
assert.ok(fs.existsSync(WX_EP), '微信应该有独立的 episodes 文件：' + WX_EP)
const qqRaw = fs.readFileSync(QQ_EP, 'utf8')
const wxRaw = fs.readFileSync(WX_EP, 'utf8')
assert.ok(qqRaw.includes('在吗') && !wxRaw.includes('在吗'), 'QQ 消息不该进微信记忆')
assert.ok(wxRaw.includes('微信来的消息') && !qqRaw.includes('微信来的消息'), '微信消息不该进 QQ 记忆')

// 2) 按会话读：互不串台
assert.deepEqual(memory.recent('qq:3082864371', 10).map(m => m.content), ['在吗', '在的，主人。'])
assert.deepEqual(memory.recent('wechat:wxid_a', 10).map(m => m.content), ['微信来的消息'])

// 3) 老数据兼容：主文件里的旧 QQ 记录也要能读到
fs.appendFileSync(MAIN_EP, JSON.stringify({ ts: Date.now() - 86400e3, platform: 'qq', chatId: 'qq:3082864371', userId: '3082864371', role: 'user', text: '这条是换文件之前的旧记录', summary: '旧记录' }) + '\n')
assert.ok(memory.recent('qq:3082864371', 10).some(m => m.content.includes('旧记录')), '老数据应该能接上')

// 4) 滚动摘要 + 主人画像（refresh 要求至少 4 条对话，先补两条）
memory.remember('qq', 'qq:3082864371', '3082864371', 'user', '网络坏了，我洗不了澡了')
memory.remember('qq', 'qq:3082864371', '3082864371', 'assistant', '先看看路由器吧，拔了插一下。')

let called = 0
const fakeChat = async () => {
  called++
  return JSON.stringify({
    summary: '他今天网络坏了，洗不了澡，有点烦躁；我陪他聊到凌晨。',
    profile: '称呼：友利奈绪。作息：经常凌晨还在。最近在烦心网络问题。',
  })
}
for (let i = 0; i < 6; i++) qqMemory.bump('qq:3082864371')
assert.equal(qqMemory.due('qq:3082864371'), true, '满 6 条应该触发压缩')
assert.equal(qqMemory.loadSummary('qq:3082864371'), '', '压缩前摘要应为空')
const okRefresh = await qqMemory.refresh({ chatId: 'qq:3082864371', owner: { name: '友利奈绪' }, chat: fakeChat })
assert.equal(okRefresh, true)
assert.equal(called, 1)
assert.ok(qqMemory.loadSummary('qq:3082864371').includes('网络坏了'), '摘要没写进去')
assert.ok(qqMemory.loadProfile().includes('友利奈绪'), '画像没写进去')
assert.equal(qqMemory.due('qq:3082864371'), false, '压缩后计数应清零')

// 5) 她从 B站/抖音 带回来的世界，也要进 QQ 人格
memory.addLore('口味', '喜欢看人做饭，尤其是红烧肉')
memory.remember('bilibili', 'bilibili:BV1xx', 'up', 'assistant', '这个红烧肉教程绝了，我记下来了')
memory.remember('douyin', 'douyin:vid1', 'author', 'assistant', '刷到一只会开门的猫，笑了半天')
const world = qqMemory.worldBlock()
assert.ok(world.includes('红烧肉教程'), 'worldBlock 应该带上 B站 见闻：' + world)
assert.ok(world.includes('会开门的猫'), 'worldBlock 应该带上抖音 见闻')
assert.ok(world.includes('喜欢看人做饭'), 'worldBlock 应该带上她记住的观念')

// 5.5) 微信记录不参与人格回忆：写一条很久以前的微信内容，recall 不能命中
fs.appendFileSync(WX_EP, JSON.stringify({ ts: Date.now() - 30 * 86400e3, platform: 'wechat', chatId: 'wechat:wxid_a', userId: 'wxid_a', role: 'user', text: '供应商报销单我下周交', summary: '供应商报销单我下周交' }) + '\n')
assert.deepEqual(memory.recall('报销'), [], '微信的工作记录不该被人格回忆捡到')
assert.deepEqual(memory.recall('报销', 2, 7, { includeWechat: true }).length, 1, '显式 includeWechat 时才读')
// 老的微信数据还在主文件里，也要挡住
fs.appendFileSync(MAIN_EP, JSON.stringify({ ts: Date.now() - 30 * 86400e3, platform: 'wechat', chatId: 'wechat:wxid_a', userId: 'wxid_a', role: 'user', text: '报销单记得盖章', summary: '报销单记得盖章' }) + '\n')
assert.deepEqual(memory.recall('报销单'), [], '主文件里的历史微信记录同样不能进人格回忆')

// 6) 拼 prompt：带画像/摘要/见闻，且不再把 QQ 号当称呼
const msgs = persona.buildMessages({ platform: 'qq', userText: '我是谁', chatId: 'qq:3082864371', userId: '3082864371', turnsToday: 2 })
const sys = msgs[0].content
assert.ok(sys.includes('【关于主人你知道的】'), 'QQ prompt 应该带主人画像')
assert.ok(sys.includes('【你们最近】'), 'QQ prompt 应该带滚动摘要')
assert.ok(sys.includes('【你最近在外面看到的】'), 'QQ prompt 应该带她刷 B站/抖音 的见闻')
assert.ok(sys.includes('红烧肉教程'), '见闻要具体，不是空壳')
assert.ok(sys.includes('友利奈绪'), '称呼应该用人名')
assert.ok(sys.includes('绝对不要用这串数字称呼他'), '必须明确禁止拿号码当称呼')
assert.ok(!sys.includes('账号 3082864371 就是你主人'), '不能再用"账号 xxx 就是你主人"这种 prompt')
// QQ 上下文比微信长
const qqTurns = msgs.length - 2
assert.ok(qqTurns >= 3, 'QQ 最近对话条数应 >= 3，实际 ' + qqTurns)

// 7) 微信 prompt 不带 QQ 的长期记忆/见闻（各平台独立）
const wxMsgs = persona.buildMessages({ platform: 'wechat', userText: '在吗', chatId: 'wechat:wxid_a', userId: 'wxid_a' })
assert.ok(!wxMsgs[0].content.includes('【关于主人你知道的】'), '微信不该带 QQ 主人画像')
assert.ok(!wxMsgs[0].content.includes('【你最近在外面看到的】'), '微信不该带 QQ 的见闻块')

fs.rmSync(tmp, { recursive: true, force: true })
console.log('memory ✓  QQ 独立记忆/老数据兼容/摘要/画像/称呼修正/微信隔离 全部通过')
