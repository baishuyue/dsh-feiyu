/**
 * "像人"的两条硬指标：分条发 + 不带客服腔。
 * 跑法：node test/qq-human-test.mjs
 */
import assert from 'node:assert/strict'
import { splitBubbles } from '../tools/commands/qq-server.mjs'
import { clean } from '../tools/lib/guard.mjs'

// 1) 短短一句就是一条，不硬拆
assert.deepEqual(splitBubbles('嗯，我在。'), ['嗯，我在。'])
assert.deepEqual(splitBubbles(''), [])

// 2) 三句话 → 2~3 条，且每条都不是空
const three = splitBubbles('网络坏了啊。你先看看路由器，拔了插一下。要是还不行就重启光猫。')
assert.ok(three.length >= 2 && three.length <= 3, '应该拆成 2~3 条，实际 ' + JSON.stringify(three))
assert.ok(three.every(s => s.trim()), '不允许空气泡：' + JSON.stringify(three))
assert.ok(three.every(s => s.length <= 60), '单条不该太长：' + JSON.stringify(three))

// 3) 唠叨一大段 → 最多 3 条（宁可最后一条长一点，也不刷屏）
const long = Array(8).fill('这是一句用来测试分条的话。').join('')
const capped = splitBubbles(long)
assert.equal(capped.length, 3, '最多三条，实际 ' + capped.length)
assert.ok(capped.join('').includes('这是一句用来测试分条的话'), '内容不能丢')

// 4) 没有句号的长句也要能切（按逗号兜底）
const noStop = splitBubbles('我今天中午吃了红烧肉，然后看了一会儿视频，后来困得不行就睡了，醒来发现天都黑了，锅里还剩了半碗饭没吃完')
assert.ok(noStop.length >= 2, '逗号也应该参与分条：' + JSON.stringify(noStop))

// 5) 英文/无标点不崩
assert.ok(splitBubbles('hello world this is a long sentence without any punctuation at all').length >= 1)

// 6) 客服腔/AI 腔要清掉
assert.equal(clean('好的，希望这能帮到你。'), '好的，')
assert.equal(clean('总的来说，你先看看路由器吧。'), '你先看看路由器吧。')
assert.equal(clean('作为一个AI，我不能确定。'), '我不能确定。')
assert.equal(clean('如果你还有其他问题，随时问我。'), '')
assert.equal(clean('嗯，我在。'), '嗯，我在。', '正常聊天不该被误伤')

console.log('qq-human ✓  分条发送/AI腔清洗 通过')
console.log('  示例：', JSON.stringify(three))
