// brain 隔离与时钟测试（I7 + 存储口径）：微信进不来、群聊看不到私聊、时间按本地 +08:00 存 / 按人话渲染。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-brain-iso-'))
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
const clock = await import('../tools/brain/clock.mjs')
const recall = await import('../tools/brain/recall.mjs')
const paths = await import('../tools/brain/paths.mjs')

// ① 微信完全隔离
const r = event.emit({ proc: 'i', platform: 'wechat', chatId: 'wx:1', userId: '9', role: 'user', text: '微信暗号QQQ' })
ok('微信事件被拒（wechat-isolated）', r.ok === false && r.reason === 'wechat-isolated')
const wxDir = path.join(paths.BRAIN(), 'wechat')
ok('没有生成 wechat 目录', !fs.existsSync(wxDir), wxDir)
const allFiles = []
const walk = (d) => {
  if (!fs.existsSync(d)) return
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, f.name)
    if (f.isDirectory()) walk(p)
    else allFiles.push(p)
  }
}
walk(paths.BRAIN())
let hits = 0
for (const f of allFiles) { try { if (fs.readFileSync(f, 'utf8').includes('微信暗号QQQ')) hits++ } catch {} }
ok('脑目录里零处微信内容', hits === 0, `命中 ${hits} 个文件`)

// ② 群聊 audience 看不到私聊情景
event.emit({ proc: 'i', platform: 'qq', chatId: 'qq:1', userId: '1', role: 'user', text: '私聊暗号ZZZ 说了个秘密', isOwner: true, msgId: 'i1' })
event.emit({ proc: 'i', platform: 'qq', chatId: 'qq:900', userId: '2', role: 'user', text: '群里说个秘密', isGroup: true, groupId: '900', msgId: 'i2' })
episode.ingest({ limit: 20 })
const now = Date.now()
const forGroup = recall.search({ cues: '秘密', audience: 'group', now })
ok('群聊检索不含私聊情景', !forGroup.items.some((x) => /私聊暗号ZZZ/.test(x.ep.quote)), JSON.stringify(forGroup.items.map((x) => x.ep.scope)))
const forOwner = recall.search({ cues: '私聊暗号', audience: 'private', now })
ok('主人私聊能检索到', forOwner.items.some((x) => /私聊暗号ZZZ/.test(x.ep.quote)))

// ③ 存储口径：本地 +08:00
const iso = clock.isoOf(now)
ok('时间戳带本地偏移 +08:00', /\+08:00$/.test(iso), iso)
const ep = episode.allEpisodes()[0]
ok('情景同时存 at(ms) 和 atIso', Number(ep.at) > 0 && /\+08:00$/.test(ep.atIso), ep.atIso)

// ④ 人话渲染：相对时间
const yest = new Date(now)
yest.setDate(yest.getDate() - 1)
yest.setHours(15, 20, 0, 0)
const rel = clock.relTime(yest.getTime(), now)
ok('昨天下午渲染成"昨天"', /昨天/.test(rel), rel)
ok('几分钟前渲染成"分钟前"', /分钟前/.test(clock.relTime(now - 12 * 60_000, now)), clock.relTime(now - 12 * 60_000, now))

// ⑤ 相对时间解析（"明天 9 点半"要落成绝对时间）
const rr = clock.resolveRelative('明天9点半', now)
ok('"明天9点半"解析出绝对区间', Number(rr.from) > now, JSON.stringify(rr))
const d = new Date(rr.from)
ok('解析出 9:30', d.getHours() === 9 && d.getMinutes() === 30, `${d.getHours()}:${d.getMinutes()}`)
const rr2 = clock.resolveRelative('19:30', now)
ok('"19:30"解析出 19:30', new Date(rr2.from).getHours() === 19 && new Date(rr2.from).getMinutes() === 30)
const cue = clock.parseCue('明天早上9点再看', now)
ok('parseCue 认得"明天早上9点"', cue && cue.type === 'at' && Number(cue.at) > now, JSON.stringify(cue))
ok('endOfDay 落在当天 23:59', new Date(clock.endOfDay(now)).getHours() === 23, String(new Date(clock.endOfDay(now)).getHours()))

console.log(bad ? `\n✗ ${bad} 项没过` : '\n✓ 全部通过')
process.exit(bad ? 1 : 0)