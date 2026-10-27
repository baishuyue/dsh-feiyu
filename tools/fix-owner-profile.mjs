// 主人画像手术（10-27）
//
// 病根：`qq/owner-profile.md` 是她**自己写**的摘要，里面这句
//   「他馋南京的鸭血粉丝汤、盐水鸭、小笼包，菜单我已背下来」
// 不是主人说的 —— 是她 10-24 抖音刷到《史上最全南京美食攻略》后自己推的，
// 然后被每轮注入（persona 读这段），变成"我确实在替他研究南京"。
// 这里把它换成能核实的近况，并明确写死"主人没提过的馋，不许替他编"。
//
//   node tools/fix-owner-profile.mjs [--go]
import fs from 'node:fs'
import path from 'node:path'
import { homePath } from './lib/paths.mjs'

const GO = process.argv.includes('--go')
const FILE = homePath('.feiyu-ai', 'qq', 'owner-profile.md')
const old = fs.readFileSync(FILE, 'utf8')

const from = '他馋南京的鸭血粉丝汤、盐水鸭、小笼包，菜单我已背下来，还记着答应一起去吃桑拿鸡汤泡饭。'
const to = '他的口味是他自己说的才算：今天（10-27）中午他吃了烧鸭；他没点名想吃的东西，我不许替他编（南京那套菜单是我自己搜出来的，不再挂在他身上）。'

if (!old.includes(from)) {
  console.log('（画像里那句话已经不在，可能已修过 —— 不动）')
  process.exit(0)
}
const next = old.replace(from, to)
console.log('原文：', from)
console.log('改成：', to)
if (!GO) { console.log('\n（没加 --go：只报告）'); process.exit(0) }
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
fs.copyFileSync(FILE, FILE + '.bak-' + stamp)
fs.writeFileSync(FILE, next, 'utf8')
console.log('\n✓ 已写入（备份：owner-profile.md.bak-' + stamp + '）')