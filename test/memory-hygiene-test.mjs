// memory-hygiene-test —— 记忆卫生（10-27 主人报"连问十次吃没吃饭 / 南京执念 / 说看番一直不看"）
//
// 这些用例锁的是"病根不复发"，不是"代码能跑"：
//   ① 饥饿不能只涨不落（旧版非饭点 -0.5 ≈ 永不下降 → 一整天"满脑子都是吃的"）
//   ② 心情不能每 tick 被砍到底（旧版 -4/tick → 整天 0/100 → 句子压到 15 字）
//   ③ 他自己的推送不算"真实经历"（recallAll 必须排掉 kind:'push'）
//   ④ 价值观池不许混进运维笔记/干活流水/同主题刷屏
//   ⑤ 主人说过的硬事实必须记下来，并且能拦住"再问一遍"
//   ⑥ 承诺要有账、要到点、要能结清
//   ⑦ 能力清单里的命令必须真存在（写了却不存在 = 她会去调一个不存在的东西然后编）
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// ⚠️ 隔离必须在**任何 import 之前**完成：paths.mjs 在 import 时就把 HOME 定死了。
// 10-27 踩过：只设了自定义变量、没设 USERPROFILE，结果测试把真记忆库（lore 55KB /
// episodes 86KB / facts 10KB）写成了几条假数据 —— 只能从备份往回捞。
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-memtest-'))
process.env.USERPROFILE = TMP_HOME
process.env.HOME = TMP_HOME
process.env.FEIYU_DATA_DIR = path.join(TMP_HOME, '.feiyu-ai')
process.env.DSH_HOME = path.join(TMP_HOME, '.dsh')
fs.mkdirSync(process.env.FEIYU_DATA_DIR, { recursive: true })
fs.mkdirSync(process.env.DSH_HOME, { recursive: true })

const { dataPath, dshPath } = await import('../tools/lib/paths.mjs')
const mood = await import('../tools/lib/mood.mjs')
const memory = await import('../tools/lib/memory.mjs')
const ownerFacts = await import('../tools/lib/owner-facts.mjs')
const promises = await import('../tools/lib/promises.mjs')
const focus = await import('../tools/lib/focus.mjs')
const persona = await import('../tools/lib/persona.mjs')
const quote = await import('../tools/lib/quote.mjs')

let pass = 0
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log('  ✓ ' + name) } catch (e) { console.log('  ✗ ' + name + ' → ' + e.message); process.exitCode = 1 }
}
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 1)) }

console.log('记忆卫生测试')

// ① 饥饿：饭点封顶、非饭点按次掉、吃到饭归零
await ok('饭点饥饿封顶在 hungerCap（不再打满 100）', () => {
  fs.rmSync(dataPath('mood.json'), { force: true })
  for (let i = 0; i < 30; i++) mood.tickMood(() => 0.99)
  const st = mood.mood()
  assert.ok(st.hunger <= 70, `hunger=${st.hunger} 应该 ≤70`)
})
await ok('fed() 把饥饿打到 20 以下并回一点心情', () => {
  const before = mood.mood()
  const after = mood.fed(20)
  assert.equal(after.hunger, 20)
  assert.ok(after.value >= before.value, '吃到东西心情不该更差')
})
await ok('非饭点衰减是"按次"而不是 0.5（旧 bug）', () => {
  writeJson(dataPath('mood.json'), { value: 50, hunger: 60, day: new Date().toLocaleDateString('sv-SE') })
  const st = mood.tickMood(() => 0.99)
  const hour = new Date().getHours()
  const inMeal = [11, 12, 17, 18].includes(hour)
  if (inMeal) assert.ok(st.hunger >= 60, '饭点应该不降')
  else assert.ok(st.hunger <= 54, `非饭点应该掉 ≥6，实际 ${st.hunger}`)
})
await ok('心情不会被单次 tick 砍 4 分', () => {
  writeJson(dataPath('mood.json'), { value: 40, hunger: 90, day: new Date().toLocaleDateString('sv-SE') })
  const st = mood.tickMood(() => 0.99)
  assert.ok(st.value >= 39, `单次最多 -1，实际到了 ${st.value}`)
})

// ② recallAll 不把她自己的推送当经历
await ok('recallAll 排除 kind:push 行', () => {
  const f = dataPath('episodes.jsonl')
  const now = Date.now()
  const rows = [
    { platform: 'qq', chatId: 'qq:1', role: 'assistant', text: '我搜了南京小吃', kind: 'push', ts: now - 60000 },
    { platform: 'bilibili', chatId: 'bilibili:x', role: 'assistant', text: '看了个视频', ts: now - 50000 },
  ]
  writeJson(f, rows)
  // episodes.jsonl 是 jsonl：上面写成数组不合法，重写一遍
  fs.writeFileSync(f, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
  const out = memory.recallAll('qq:999', { hours: 12, max: 12 })
  const txt = (out.lines ?? []).join('\n')
  assert.ok(!/我搜了南京小吃/.test(txt), '自己的推送不该被当成跨平台经历注入：' + txt)
  assert.ok(/看了个视频/.test(txt), '真实经历应该还在：' + txt)
})

// ③ 价值观池：ops / 干活流水 / 同主题刷屏都不进
await ok('addLore：运维 tag 进 ops 池，不进价值观', () => {
  fs.rmSync(dataPath('lore.json'), { force: true })
  memory.addLore('运维', 'Bing URL 多带一个 &count=15 才能搜到')
  assert.equal(memory.loreValues(8).length, 0, '运维笔记不该出现在价值观池')
  assert.equal(memory.loreOps(8).length, 1, '但要查得到')
})
await ok('addLore：带日期前缀的干活流水不进价值观', () => {
  memory.addLore('学习', '10-27 16:05 统计了自己 84 条发言里 53 条带本鱼')
  assert.ok(!memory.loreValues(8).some((t) => /84 条发言/.test(t)))
})
await ok('addLore：同主题刷屏被折叠（不会 25 条南京）', () => {
  fs.rmSync(dataPath('lore.json'), { force: true })
  for (let i = 0; i < 9; i++) memory.addLore('学习', `替主人探南京小吃第${i}版：盐水鸭、烤鸭、鸭血粉丝三样必吃`)
  const vals = memory.loreValues(20)
  const nanjing = vals.filter((t) => /南京/.test(t))
  assert.ok(nanjing.length <= 2, `同主题应该只剩 ≤2 条，实际 ${nanjing.length} 条`)
})
await ok('真正的价值观照样注入', () => {
  fs.rmSync(dataPath('lore.json'), { force: true })
  memory.addLore('守规矩', '不许在群里叫别人主人，这是边界')
  assert.ok(memory.loreValues(8).some((t) => /群里叫别人主人/.test(t)))
})

// ④ 主人事实
await ok('从他的话里抽事实：吃了什么/在做什么/心情/作品', () => {
  assert.equal(ownerFacts.extract('我中午吃了烧鸭')[0].value, '烧鸭')
  assert.equal(ownerFacts.extract('我在改插件呢')[0].value, '改插件呢')
  assert.equal(ownerFacts.extract('我明天要去看牙')[0].value, '看牙')
  assert.equal(ownerFacts.extract('我有点累')[0].value, '累')
  assert.equal(ownerFacts.extract('我推荐你去看《可塑性记忆》')[0].value, '可塑性记忆')
})
await ok('同一个 key 只留最新（吃了烧鸭 → 吃了面）', () => {
  fs.rmSync(dataPath('facts.json'), { force: true })
  ownerFacts.put('food', '烧鸭')
  ownerFacts.put('food', '面')
  const food = ownerFacts.list().filter((x) => x.key === 'food')
  assert.equal(food.length, 1, '不该两条并列')
  assert.equal(food[0].value, '面')
})
await ok('事实闸：他已经说过吃了什么 → 再问就是命中', () => {
  fs.rmSync(dataPath('facts.json'), { force: true })
  ownerFacts.learnFromOwner('我中午吃了烧鸭')
  assert.ok(ownerFacts.asksKnown('你中午到底吃了没啊'), '应该拦下')
  assert.ok(ownerFacts.asksKnown('吃饭了吗'), '应该拦下')
  assert.equal(ownerFacts.asksKnown('今天南京下雨吗'), null, '无关的问题不该误伤')
})
await ok('事实块里明确写着"不用再问"', () => {
  const blk = ownerFacts.promptBlock()
  assert.ok(/烧鸭/.test(blk))
  assert.ok(/不用再问/.test(blk))
})

// ⑤ 承诺账本
await ok('从她的回复里认出承诺并落账（带名字）', () => {
  fs.rmSync(dataPath('promises.json'), { force: true })
  const got = promises.catchFromReply('这就去看《可塑性记忆》第一集，看完讲给你听', { userText: '我推荐你去看一部番叫做可塑性记忆' })
  assert.equal(got.length, 1, '两条正则命中同一件事，只该落一条')
  assert.equal(got[0].what, '可塑性记忆')
  assert.equal(got[0].state, 'open')
})
await ok('同一条承诺不重复记账', () => {
  const before = promises.list().length
  promises.catchFromReply('这就去看《可塑性记忆》第二集', { userText: '可塑性记忆' })
  assert.equal(promises.list().length, before, '同一个主题不该重复开账')
})
await ok('到期才 notable，done/fail 有终态', () => {
  const it = promises.add('看一集番', { what: '另一个番', dueMin: 1 })
  assert.equal(promises.dueNow().length, 0, '刚开的还不该到期')
  promises.done(it.id, '看完了')
  assert.equal(promises.list('done').length, 1)
  const it2 = promises.add('另一件事', { what: '别的事', dueMin: 1 })
  promises.fail(it2.id, '没有字幕')
  assert.equal(promises.list('failed').length, 1)
})
await ok('提示词里有"你欠着的事/你真没做成"（教她照实说）', () => {
  const blk = promises.promptBlock(Date.now() + 10 * 60_000)
  assert.ok(/你答应过|欠着|没做成/.test(blk), blk)
})

// ⑥ 看番这件事必须真的存在
await ok('focus 认"看番"，且 binge 是独立活动', () => {
  assert.equal(focus.normActivity('看番'), 'binge')
  assert.equal(focus.normActivity('binge'), 'binge')
  assert.equal(focus.labelOf('binge'), '看番/看剧')
})
await ok('binge / promises 命令文件存在且导出 run', async () => {
  for (const name of ['binge', 'promises']) {
    const f = path.join(import.meta.dirname, '..', 'tools', 'commands', name + '.mjs')
    assert.ok(fs.existsSync(f), `缺命令 ${name}`)
    const mod = await import('file://' + f.replace(/\\/g, '/'))
    assert.equal(typeof (mod.run ?? mod.default), 'function', `${name} 没有 run 导出`)
  }
})
await ok('能力清单里的每条命令都真的注册在 feiyu.mjs 里', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'tools', 'feiyu.mjs'), 'utf8')
  for (const [cmd] of persona.CAPABILITIES) {
    const name = String(cmd).trim().split(/\s+/)[0]
    const fileName = path.join(import.meta.dirname, '..', 'tools', 'commands', name.replace(/^--?/, '') + '.mjs')
    assert.ok(new RegExp(`(^|\\s)${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`, 'm').test(src) || /--/.test(name),
      `能力清单写了 ${name}，但 feiyu.mjs 的命令表里没有`)
    if (!/--/.test(name)) assert.ok(fs.existsSync(fileName), `缺文件 tools/commands/${name}.mjs`)
  }
})
await ok('人格层真的会注入"你能自己动手"（含 selfup 权限）', () => {
  const txt = persona.CAPABILITIES.map((c) => c.join(' ')).join('\n')
  assert.ok(/binge --show/.test(txt))
  assert.ok(/selfup backup/.test(txt), '要告诉她能自己改代码')
})

// ⑦ 记忆卫生：日志钩子读"今天最新"而不是"文件最底部"
await ok('qq-server 的网志钩子取的是当天段落最上面几条', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'tools', 'commands', 'qq-server.mjs'), 'utf8')
  assert.ok(/function todayWebLines/.test(src), '缺 todayWebLines')
  assert.ok(/## \$\{today\}/.test(src), '要按 ## 日期 找当天段落')
  assert.ok(!/web-log\.md'[\s\S]{0,80}slice\(-3\)/.test(src), '不能再 slice(-3) 取文件末尾')
})

// ⑧ 引用消息（10-27 主人报"他看不懂引用/看不见引用了哪条"）
//    OneBot 只给 reply 段的 id，正文得自己取 —— 以前只折成"【引用回复了一条消息】"，
//    被引用的原话一个字没有，于是她只能回"我这边看不到引用的啥"。
await ok('parseMessage 把 reply 段的 id 挖出来（array 与 CQ 码都认）', async () => {
  const { parseMessage } = await import('../tools/commands/qq-server.mjs')
  const a = parseMessage([{ type: 'reply', data: { id: '50854801' } }, { type: 'text', data: { text: '这句啥意思' } }], '3796002846')
  assert.equal(a.replyId, '50854801', 'array 上报要取到 id')
  assert.equal(a.text, '这句啥意思')
  const b = parseMessage('[CQ:reply,id=-99123]这句啥意思', '3796002846')
  assert.equal(b.replyId, '-99123', 'CQ 码上报也要取到 id')
  const c = parseMessage([{ type: 'text', data: { text: '在吗' } }], '1')
  assert.equal(c.replyId, '', '没引用时不该有 id')
})

await ok('引用索引：自己的话 / 他自己的话 / 别人的话 说法各不同', () => {
  quote.clear()
  quote.remember('m1', { text: '我明天去看可塑性记忆', who: 'me', at: Date.now() - 60000 })
  quote.remember('m2', { text: '中午吃了烧鸭', who: 'owner' })
  quote.remember('m3', { text: '我也想吃', who: 'other', name: '阿强' })
  const s1 = quote.describe(quote.get('m1'))
  const s2 = quote.describe(quote.get('m2'))
  const s3 = quote.describe(quote.get('m3'))
  assert.match(s1, /你自己刚说的/)
  assert.match(s1, /我明天去看可塑性记忆/, '被引用的原话必须在里面')
  assert.match(s2, /他自己前面说的/)
  assert.match(s3, /阿强说的/)
  assert.match(quote.describe(null), /没取到/, '取不到要老实说取不到')
  quote.clear()
})

await ok('引用索引：get_msg 返回体认得出发送者是谁', () => {
  const parse = (m, selfId) => ({
    text: (m || []).filter((s) => s.type === 'text').map((s) => s.data.text).join(''),
    images: [], marks: [],
  })
  const mine = quote.fromGetMsg({ message: [{ type: 'text', data: { text: '我发的那句' } }], sender: { user_id: 3796002846 }, time: 1793000000 },
    { selfQQ: '3796002846', ownerQQ: '3082864371', parseMessage: parse })
  assert.equal(mine.who, 'me')
  const his = quote.fromGetMsg({ message: [{ type: 'text', data: { text: '他说的话' } }], sender: { user_id: 3082864371 }, time: 1793000000 },
    { selfQQ: '3796002846', ownerQQ: '3082864371', parseMessage: parse })
  assert.equal(his.who, 'owner')
  assert.equal(his.at, 1793000000000, '时间戳要按秒→毫秒换算')
})

await ok('提示词里要有"这是在接上面那条"的引用块，且不许装看不见', () => {
  const block = persona.quoteBlock('【他引用的是你自己刚说的这一句：「我明天去看番」】')
  assert.match(block, /接上面那一条/)
  assert.match(block, /我明天去看番/)
  assert.match(block, /不许装没看见|不许反问/)
  assert.equal(persona.quoteBlock(''), '', '没有引用时不要多出空块')
})

await ok('qq-server 真的把 quoteLine 送进提示词，并且写进记忆', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'tools', 'commands', 'qq-server.mjs'), 'utf8')
  assert.ok(/resolveQuote\(parsed\.replyId/.test(src), '入口要拿 replyId 去解析')
  assert.ok(/quote: quoteLine/.test(src), 'buildMessages 要收到 quote')
  assert.ok(/memory\.remember\('qq', chatId, userId, 'user', memText/.test(src), '记忆里要带引用上下文')
  assert.ok(/warmQuoteIndex/.test(src), '老消息要靠预热历史才取得到原文')
})

// ⑨ B站「自己作品下的评论」（10-27 主人报"没有实现和抖音一样的回复评论"）
//   真实病根三连：bvid 没落库 → 找不到投稿；space 列表默认关 → 自己发现不了；
//   "发现即算看过" → 额度卡住一次就永久失联。
await ok('找自己的投稿：默认会走 space 接口（否则永远"自己还没有投稿"）', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'tools', 'lib', 'bili-write.mjs'), 'utf8')
  assert.ok(/cfg\.useSpaceList !== false/.test(src), 'space 列表必须默认开（soft 不熔断）')
  assert.ok(/soft: true/.test(src), 'space 接口要走 soft，别把整个 B站 通道熔断')
})

await ok('回自己作品评论：只在真回过时记 seen，失败不许吃掉这条', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'tools', 'commands', 'replies.mjs'), 'utf8')
  // 发现阶段不许写 seen
  const discover = src.slice(src.indexOf('const news = []'), src.indexOf('const ownerMid'))
  assert.ok(!/wm\.seen\.push/.test(discover), '发现评论时不能直接标 seen（额度卡住就永久失联）')
  assert.ok(/wm\.seen\.push\(n\.key\)[\s\S]{0,40}save\(\)/.test(src), '成功之后才写 seen')
  assert.ok(/这条没回成，水位不退不记/.test(src), '失败要明说会重试')
})

await ok('子评论不能带图：楼中楼要降级成纯文字，并有兜底重试', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'tools', 'lib', 'bili-write.mjs'), 'utf8')
  assert.ok(/子评论（楼中楼）不能带图/.test(src), '注释里要写清这个平台约束')
  assert.ok(/const isNested = String\(rootRpid/.test(src), '要判断是不是楼中楼')
  assert.ok(/if \(image && isNested\)/.test(src), '楼中楼要主动去掉图')
  assert.ok(/去掉图再来一次/.test(src), '被拒还要再试一次纯文字')
})

await ok('发出去了≠看得见：要有匿名可见性核查 + 被挂就自刹车', () => {
  const w = fs.readFileSync(path.join(import.meta.dirname, '..', 'tools', 'lib', 'bili-write.mjs'), 'utf8')
  const r = fs.readFileSync(path.join(import.meta.dirname, '..', 'tools', 'commands', 'replies.mjs'), 'utf8')
  assert.ok(/export async function replyVisibility/.test(w), '要有匿名核查函数')
  assert.ok(/仅自己可见/.test(w), '要说清 state=17 的含义')
  assert.ok(/--audit/.test(r), '要有体检入口')
  assert.ok(/holdCheck/.test(r) && /--force/.test(r), '被挂过半要自刹车，但要留 --force')
})

await ok('主人评论免额度：跟抖音一致', () => {
  const w = fs.readFileSync(path.join(import.meta.dirname, '..', 'tools', 'lib', 'bili-write.mjs'), 'utf8')
  assert.ok(/bypassCap/.test(w), 'postReply 要支持 bypassCap')
  assert.ok(/主人的评论永远不受日额度限制/.test(w), '语义要写清')
})

// ⑩ 辅助服务守护（10-27 第三批·下半）：
//    病根是"抖音私信陪聊 09:46 起过一次，之后进程没了，主人发私信一整天没人回" ——
//    没人崩了不管。也要保证"别人来她视频下评论"不被主动出击的日额度卡死。
await ok('辅助服务：探活靠端口 /health，不是靠手里有没有 child', () => {
  // 名字是 auxsvc.mjs：aux.mjs 是 Windows 保留设备名（AUX），Win32 打不开 → 动态 import 静默失败
  const aux = fs.readFileSync(path.join(import.meta.dirname, '..', 'tools', 'lib', 'auxsvc.mjs'), 'utf8')
  assert.ok(/export async function probeHealth/.test(aux), '要有探活函数')
  assert.ok(/http:\/\/127\.0\.0\.1:\$\{port\}\/health/.test(aux), '探 /health 而不是只看进程')
  assert.ok(/export async function ensureDouyinDm/.test(aux), '抖音私信要能自愈')
  assert.ok(/tries\.length >= 3/.test(aux), '要有退避，别 crash-loop 刷进程')
  const idx = fs.readFileSync(path.join(import.meta.dirname, '..', 'lib', 'index.js'), 'utf8')
  assert.ok(/function portHealthy/.test(idx), '插件侧也要端口级探活')
  assert.ok(/async function watchServices/.test(idx), '插件要有 60s 看门狗')
  assert.ok(/startWithDsh === true/.test(idx), '看门狗只在该自启的服务上动手')
})

await ok('B站：别人来她视频下评论走独立额度桶，不被主动出击额度卡死', () => {
  const w = fs.readFileSync(path.join(import.meta.dirname, '..', 'tools', 'lib', 'bili-write.mjs'), 'utf8')
  const r = fs.readFileSync(path.join(import.meta.dirname, '..', 'tools', 'commands', 'replies.mjs'), 'utf8')
  assert.ok(/capKind = 'reply'/.test(w), 'postReply 要能指定额度桶')
  assert.ok(/capRecord\(bucket\)/.test(w), '记账也要跟着桶走')
  assert.ok(/capKind: 'ownReply'/.test(r), 'ownWorks 要写进 ownReply 桶')
  assert.ok(/ownDailyMax/.test(r) && /ownDailyMax/.test(w), '要能单独配这个桶的上限')
})

await ok('被挂审核时不再一律停手：holdMode=limit 照回但一轮只发 1 条', () => {
  const r = fs.readFileSync(path.join(import.meta.dirname, '..', 'tools', 'commands', 'replies.mjs'), 'utf8')
  assert.ok(/holdMode \|\| 'limit'/.test(r), '默认是 limit 不是 block')
  assert.ok(/holdLimit = 1/.test(r), 'limit 模式一轮只发一条')
  assert.ok(/holdLimit \|\| Infinity/.test(r), '预算要夹紧')
  assert.ok(/'block'/.test(r), '仍保留彻底停手的分支')
})

console.log(`\n记忆卫生测试：${pass}/${pass} 通过`)
if (process.exitCode) console.log('（有失败项，见上）')
