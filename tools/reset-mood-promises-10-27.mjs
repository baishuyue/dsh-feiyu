// 把 mood.json / promises.json 复位成"诚实且合理"的状态（10-27 事故后）
//
// 事故同 restore-memory：有测试没隔离，把这两份也写成了假数据。
//   · mood.json    → 测试值（心情 40 / 饥饿 90 之类，跟今天真实情况不符）
//   · promises.json→ 测试造出来的"别的事：没有字幕"之类的假承诺
// 真实情况：主人 16:4x 说她看了《可塑性记忆》第一集（弹幕材料真读进去了），
// 中午他说自己吃了烧鸭 → 她的饥饿应该已经落地。
//
//   node tools/reset-mood-promises-10-27.mjs [--go]
import fs from 'node:fs'
import { dataPath } from './lib/paths.mjs'

const GO = process.argv.includes('--go')
const today = new Date().toLocaleDateString('sv-SE')

const mood = { value: 62, hunger: 20, day: today, note: '10-27 复位：主人说中午吃了烧鸭，她的饥饿落地' }
const promises = {
  items: [{
    id: 'pm-binge-ep1',
    what: '可塑性记忆',
    kind: '看',
    text: '这就去看《可塑性记忆》第一集，看完讲给你听',
    createdAt: Date.now() - 3600_000,
    dueAt: Date.now() - 3000_000,
    state: 'done',
    tries: 1,
    doneAt: Date.now() - 3000_000,
    why: '看完了《【4月】可塑性记忆 01【幻樱】》第 1 集',
  }],
}

console.log('mood.json：', JSON.stringify(mood))
console.log('promises.json：1 条（done：可塑性记忆 第 1 集）')
if (!GO) { console.log('\n（没加 --go：只报告）'); process.exit(0) }
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
for (const n of ['mood.json', 'promises.json']) {
  const p = dataPath(n)
  if (fs.existsSync(p)) fs.copyFileSync(p, p + '.wrecked-' + stamp)
}
fs.writeFileSync(dataPath('mood.json'), JSON.stringify(mood, null, 1) + '\n', 'utf8')
fs.writeFileSync(dataPath('promises.json'), JSON.stringify(promises, null, 1) + '\n', 'utf8')
console.log('\n✓ 已复位')