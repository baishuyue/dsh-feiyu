// 提示词体检：确认新增的三块（今天已经知道的事 / 你欠着的事 / 你能自己动手）真的进了 system
import * as persona from './lib/persona.mjs'
import * as ownerFacts from './lib/owner-facts.mjs'

ownerFacts.learnFromOwner('我中午吃了烧鸭，撑死了')
ownerFacts.learnFromOwner('我在改插件呢')
ownerFacts.learnFromOwner('我推荐你去看一部番叫做可塑性记忆')

const msgs = persona.buildMessages({ platform: 'qq', userText: '你在干嘛', chatId: 'qq:3082864371', userId: '3082864371', turnsToday: 12 })
const sys = msgs[0].content
const has = (re) => (re.test(sys) ? '✓' : '✗')
console.log('system 长度：', sys.length, '字符')
console.log(has(/【今天已经知道的事】/), '【今天已经知道的事】')
console.log(has(/【你欠着的事 · 现在就该做】|【你答应过、还没做的】|【这些你真没做成】|【你最近真做成的事】/), '【承诺账本】')
console.log(has(/【你能自己动手】/), '【你能自己动手】')
console.log(has(/binge --show "番名" --ep 2 --go/), '  含 binge 用法')
console.log(has(/selfup backup/), '  含 selfup 权限')
console.log(has(/【当下状态】/), '【当下状态】')
console.log(has(/南京小吃/), '（不该出现）南京小吃 注入')
console.log('\n—— 承诺块原文 ——')
const i = sys.indexOf('【你')
console.log(i >= 0 ? sys.slice(i, i + 400) : '(没有承诺块)')
console.log('\n—— 能力块原文（前 500 字）——')
const j = sys.indexOf('【你能自己动手】')
console.log(j >= 0 ? sys.slice(j, j + 520) : '(没有能力块)')
