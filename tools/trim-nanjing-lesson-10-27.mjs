// 把"南京搜够了…"那条教训改成**不带地名**的通用教训（10-27）
//
// 这条本身是好教训（搜到第三轮没新东西就该收手），但它每轮都被注入，而且每轮都在
// 她眼前写"南京菜单已经定稿三天" —— 等于每天提醒她"我在研究南京"。
// 保留教训、去掉地名，让她记住"什么时候该收手"，而不是记住"南京"。
import fs from 'node:fs'
import { dataPath } from './lib/paths.mjs'

const GO = process.argv.includes('--go')
const FILE = dataPath('lore.json')
const list = JSON.parse(fs.readFileSync(FILE, 'utf8'))
const target = list.find((x) => /南京搜够了/.test(String(x.text ?? '')))
if (!target) { console.log('（没找到那条，可能已改过）'); process.exit(0) }
const next = '同一件事搜到第三轮还没新东西，就是该收手了：搜之前先问自己「还缺什么」，缺什么再搜什么；搜完了就把结论写下、别再回头翻。'
console.log('原：', String(target.text).slice(0, 80) + '…')
console.log('新：', next)
if (!GO) { console.log('\n（没加 --go：只报告）'); process.exit(0) }
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
fs.copyFileSync(FILE, FILE + '.bak-' + stamp)
target.text = next
target.trimmedAt = Date.now()
fs.writeFileSync(FILE, JSON.stringify(list, null, 1) + '\n', 'utf8')
console.log('\n✓ 已改写（备份：lore.json.bak-' + stamp + '）')