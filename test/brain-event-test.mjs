// brain 事件层测试（I3/I7）：多进程并发写不丢不重、msgId 重放只算一次、微信进不来。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-brain-event-'))
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
const paths = await import('../tools/brain/paths.mjs')

const NODE = process.env.FEIYU_NODE || process.execPath
const EVENT_URL = pathToFileURL(path.join(REPO, 'tools', 'brain', 'event.mjs')).href

// ① 4 个进程各写 25 条（同一分片名 t）：不丢、不重、id 唯一
const writer = path.join(tmp, 'writer.mjs')
fs.writeFileSync(writer, `
const { emit } = await import(process.argv[2])
const n = Number(process.argv[3]), tag = process.argv[4]
for (let i = 0; i < n; i++) {
  emit({ proc: 't', platform: 'qq', chatId: 'qq:1', userId: '1', role: 'user', text: tag + '第' + i + '句', isOwner: true })
}
`)
for (const tag of ['甲', '乙', '丙', '丁']) {
  const r = spawnSync(NODE, [writer, EVENT_URL, '25', tag], { env: { ...process.env }, encoding: 'utf8' })
  if (r.status !== 0) console.log('    子进程失败：' + String(r.stderr).slice(0, 300))
}
const consumed = event.consume({ max: 1000 })
ok('4×25 并发写入全部可消费', consumed.length === 100, `实际 ${consumed.length}`)
const ids = new Set(consumed.map((e) => e.ev))
ok('事件 id 唯一（无覆盖）', ids.size === consumed.length, `${ids.size}/${consumed.length}`)
const texts = new Set(consumed.map((e) => e.text))
ok('每一条内容都在（无丢失）', texts.size === 100, `${texts.size}`)
ok('第二次消费不再重复给', event.consume({ max: 1000 }).length === 0)

// ② 同一 msgId 重放 → 只落一条情景
const before = episode.allEpisodes().length
event.emit({ proc: 'r', platform: 'qq', chatId: 'qq:1', userId: '1', role: 'user', text: '同一句话', isOwner: true, msgId: 'dup-1' })
event.emit({ proc: 'r', platform: 'qq', chatId: 'qq:1', userId: '1', role: 'user', text: '同一句话', isOwner: true, msgId: 'dup-1' })
const ing = episode.ingest({ limit: 50 })
const after = episode.allEpisodes().length
ok('msgId 重放只产生 1 条情景', after - before === 1, `新增 ${after - before}（ingested=${ing.ingested} skipped=${ing.skipped}）`)

// ③ 微信：拒绝 + 磁盘上零字节
const wx = event.emit({ proc: 'r', platform: 'wechat', chatId: 'wx:1', userId: '9', role: 'user', text: '微信里说的话' })
ok('微信事件被拒', wx.ok === false && wx.reason === 'wechat-isolated', JSON.stringify(wx.reason))
const inboxFiles = fs.readdirSync(paths.inboxDir()).filter((f) => f.endsWith('.jsonl'))
let wxBytes = 0
for (const f of inboxFiles) wxBytes += (fs.readFileSync(path.join(paths.inboxDir(), f), 'utf8').match(/微信里说的话/g) || []).length
ok('微信内容没落盘（0 处）', wxBytes === 0, `命中 ${wxBytes}`)
ok('ep 里没有微信行', episode.allEpisodes().every((e) => !/wechat|wx/.test(String(e.where?.platform || ''))))

// ④ 情景字段齐（谁说的/在哪说/能不能外说）
const ep = episode.allEpisodes().find((e) => e.who?.others?.some((w) => w.kind === 'owner'))
ok('情景带 who.kind=owner', Boolean(ep), ep ? ep.id : '')
ok('情景带 scope', ep && ['private', 'group', 'public'].includes(ep.scope), ep?.scope)
ok('情景带 srcEv（可回溯到原始事件）', Boolean(ep?.srcEv))

console.log(bad ? `\n✗ ${bad} 项没过` : '\n✓ 全部通过')
process.exit(bad ? 1 : 0)