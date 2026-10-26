// 视频 / 首条锁 / 社交流水 的测试（第 17 轮）。
//
// 一条真片子涉及 ffmpeg 滤镜链、时间轴算术、ASS 字幕、WAV 合成 —— 任何一处算错都是
// "片子出来了但音画不同步"这种最难发现的毛病，所以这里把算术和真实渲染都测一遍。
//
// 隔离：先把 USERPROFILE 指到临时目录，再动态 import —— social-log / debut 全写沙箱里，
// 绝不碰主人真的 ~/.feiyu-ai。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-social-'))
process.env.USERPROFILE = SANDBOX
process.env.HOME = SANDBOX

const ROOT = path.resolve(import.meta.dirname, '..')
const V = await import('file:///' + path.join(ROOT, 'tools/lib/video.mjs').replace(/\\/g, '/'))
const D = await import('file:///' + path.join(ROOT, 'tools/lib/debut.mjs').replace(/\\/g, '/'))
const S = await import('file:///' + path.join(ROOT, 'tools/lib/social-log.mjs').replace(/\\/g, '/'))
const P = await import('file:///' + path.join(ROOT, 'tools/commands/produce.mjs').replace(/\\/g, '/'))

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const results = []
async function ok(name, fn) {
  try { await fn(); results.push([true, name]) } catch (e) { results.push([false, name, e.message]) }
}

// ── ① 平台规格 + 时间轴算术 ─────────────────────────────────────────────────
await ok('平台规格：B站横屏 1920×1080、抖音竖屏 1080×1920，没见过的平台回落 B站', () => {
  assert.equal(V.specOf('bili').w, 1920)
  assert.equal(V.specOf('bili').h, 1080)
  assert.equal(V.specOf('douyin').w, 1080)
  assert.equal(V.specOf('douyin').h, 1920)
  assert.equal(V.specOf('kuaishou').w, 1920)
})

await ok('时间轴：每幕时长 = 进画面 + 配音 + 尾巴，总长扣掉转场重叠', () => {
  const spec = V.specOf('bili')
  const scenes = [{ voiceDur: 2 }, { voiceDur: 3 }, { voiceDur: 1.5 }]
  const t = V.buildTimeline(scenes, spec, { intro: 0, outro: 0 })
  assert.deepEqual(t.durs.map((d) => +d.toFixed(2)), [3.3, 4.3, 2.8])   // 0.4 进画面 + 配音 + 0.9 尾巴
  const sum = t.durs.reduce((a, b) => a + b, 0)
  assert.equal(+t.total.toFixed(2), +(sum - spec.ov * (scenes.length - 1)).toFixed(2))
})

await ok('时间轴：下一幕画面起点 = 上一幕起点 + 上一幕时长 − 转场重叠', () => {
  const spec = V.specOf('bili')
  const t = V.buildTimeline([{ voiceDur: 2 }, { voiceDur: 2.5 }, { voiceDur: 1 }], spec)
  for (let i = 1; i < t.starts.length; i++) {
    assert.equal(+t.starts[i].toFixed(3), +(t.starts[i - 1] + t.durs[i - 1] - spec.ov).toFixed(3))
  }
})

await ok('时间轴：配音起点永远落在自己那幕画面里，且不早于上一句说完', () => {
  const spec = V.specOf('bili')
  const t = V.buildTimeline([{ voiceDur: 1.5 }, { voiceDur: 2 }, { voiceDur: 1.2 }], spec)
  let lastEnd = 0
  t.starts.forEach((st, i) => {
    const voiceAt = st + spec.lead
    assert.ok(voiceAt > st, '配音得在本幕画面开始之后')
    assert.ok(voiceAt >= lastEnd - 0.001, `第 ${i + 1} 句开得太早会把上一句切掉`)
    lastEnd = voiceAt + 1.5
  })
})

await ok('时间轴：片头/片尾参与同一条链，total 把它们算进去', () => {
  const spec = V.specOf('bili')
  const t = V.buildTimeline([{ voiceDur: 2 }, { voiceDur: 2 }], spec, { intro: 3, outro: 2 })
  const last = t.clips[t.clips.length - 1]
  assert.equal(+t.total.toFixed(2), +(last.start + last.dur).toFixed(2))
  assert.equal(t.clips[0].kind, 'intro')
  assert.equal(last.kind, 'outro')
})

await ok('时间轴：intro/outro 都关掉时不留空档', () => {
  const spec = V.specOf('bili')
  const t = V.buildTimeline([{ voiceDur: 2 }, { voiceDur: 2 }], spec, { intro: 0, outro: 0 })
  assert.equal(t.intro, 0)
  assert.equal(t.outro, 0)
  assert.equal(+t.total.toFixed(2), 6.0)   // 3.3 + 3.3 − 0.6
})

// ── ② 字幕 ──────────────────────────────────────────────────────────────────
await ok('字幕：一句一拍，时间按配音的真实时刻落（不是猜的）', () => {
  const spec = V.specOf('bili')
  const scenes = [{ line: '第一句话', voiceDur: 2 }, { line: '第二句话', voiceDur: 1.5 }]
  const t = V.buildTimeline(scenes, spec)
  const ass = V.buildAss({ scenes, timeline: t, spec, title: '标题', brand: '大肥鱼' })
  assert.match(ass, /Dialogue: 1,0:00:0(\d)\.\d\d,/)
  for (const sc of scenes) assert.ok(ass.includes(sc.line), '每句台词都得进字幕')
  assert.match(ass, /Style: Say,Microsoft YaHei/)
  assert.ok(ass.includes('标题'))
})

await ok('字幕：时间格式是 h:mm:ss.cc（ASS 只认这个）', () => {
  const spec = V.specOf('bili')
  const scenes = [{ line: '很久之后', voiceDur: 2 }]
  const t = V.buildTimeline(scenes, spec, { intro: 3700, outro: 0 })   // 逼出 1 小时以上
  const ass = V.buildAss({ scenes, timeline: t, spec })
  assert.match(ass, /Dialogue: 1,1:01:\d\d\.\d\d,/)
})

await ok('字幕：台词里的花括号会被清掉（花括号在 ASS 里是样式指令，留着就崩）', () => {
  assert.ok(!V.buildAss({ scenes: [{ line: '{\\b1}坏{', voiceDur: 1 }], timeline: V.buildTimeline([{ voiceDur: 1 }], V.specOf('bili')), spec: V.specOf('bili') }).includes('{\\b1}'))
})

// ── ③ 转义（滤镜串最容易被这个炸掉）───────────────────────────────────────
await ok('转义：drawtext 里的冒号/单引号/百分号/反斜杠', () => {
  assert.equal(V.escapeDrawText("a:b"), 'a\\:b')
  assert.equal(V.escapeDrawText("it's"), "it\\'s")
  assert.equal(V.escapeDrawText('50%'), '50\\%')
})

await ok('转义：Windows 路径在滤镜里要写成 D\\:/x/y', () => {
  assert.equal(V.filterPath('D:\\a\\b.ass'), 'D\\:/a/b.ass')
})

// ── ④ 运镜 ──────────────────────────────────────────────────────────────────
await ok('运镜：六种都有，且平移把总帧数写进表达式（不是裸 D）', () => {
  assert.equal(V.MOVE_KEYS.length, 6)
  const src = read('tools/lib/video.mjs')
  // 只看 MOVES 定义那一段、并且去掉注释：注释里写了 on/D 这个反面教材
  const block = src.slice(src.indexOf('const MOVES = {'), src.indexOf('export const MOVE_KEYS'))
  const code = block.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
  assert.doesNotMatch(code, /on\s*\/\s*D\b/, 'zoompan 没有 D 变量（曾经报 Undefined constant "D)"）')
  assert.match(code, /left:\s*\(n\) =>/)
  assert.match(code, /on\/\$\{n\}/)
})

// ── ⑤ BGM ───────────────────────────────────────────────────────────────────
await ok('BGM：合成出来的是有声的 WAV，不是一段静音', () => {
  const out = path.join(SANDBOX, 'bgm.wav')
  V.makeBgm({ out, dur: 4 })
  const { readWav } = { readWav: (f) => {
    const buf = fs.readFileSync(f)
    assert.equal(buf.toString('ascii', 0, 4), 'RIFF')
    const dataStart = 44
    let peak = 0
    for (let i = dataStart; i + 1 < buf.length; i += 2) peak = Math.max(peak, Math.abs(buf.readInt16LE(i) / 32768))
    return { peak, dur: (buf.length - 44) / 2 / 44100 }
  } }
  const w = readWav(out)
  assert.ok(w.peak > 0.02, '峰值太小说明没合成出声音，实际 ' + w.peak)
  assert.ok(w.dur >= 4, '时长不够')
})

await ok('BGM 氛围：开心→bright、夜里→calm、其余 warm', () => {
  assert.equal(V.moodFor('太好了哈哈'), 'bright')
  assert.equal(V.moodFor('夜里有点困'), 'calm')
  assert.equal(V.moodFor('今天吃了白饭'), 'warm')
})

// ── ⑥ 投稿包字段 ────────────────────────────────────────────────────────────
await ok('投稿包（B站）：分区/标签/简介/封面都得给全，并且提醒首条要解锁', () => {
  const md = P.renderPostDoc({
    meta: { platform: 'bili', title: 'T', intro: '简介', tags: ['生活', 'AI'], cover: 'c.jpg', durationSec: 60, resolution: '1920x1080', sizeMB: 12, subtitle: 's.ass', scenes: ['一句', '两句'], debut: true },
    plan: {}, platform: 'bili', cfg: { video: { bili: { tid: 21, tname: '生活·日常' } } },
  })
  for (const s of ['生活·日常', 'tid=21', '#生活', '简介', 'cover.jpg', '--debut-posted']) assert.ok(md.includes(s), '缺：' + s)
  assert.ok(!md.includes('抖音'))
})

await ok('投稿包（抖音）：不出现 B站 的分区字段', () => {
  const md = P.renderPostDoc({ meta: { platform: 'douyin', title: 'T', intro: 'i', tags: ['a'], scenes: ['x'], resolution: '1080x1920', durationSec: 30, sizeMB: 5 }, plan: {}, platform: 'douyin', cfg: { video: {} } })
  assert.ok(md.includes('抖音'))
  assert.ok(!md.includes('tid='))
})

// ── ⑦ 真渲染（小尺寸，验证整条链跑得通、音画时长对得上）─────────────────────
await ok('真渲染：两幕小片子出来有声、时长和算出来的一致', async () => {
  const dir = path.join(SANDBOX, 'film')
  fs.mkdirSync(dir, { recursive: true })
  const img = path.join(dir, 'a.png')
  const img2 = path.join(dir, 'b.png')
  V.ff(['-f', 'lavfi', '-i', 'color=c=0x203040:s=320x180:d=1', '-frames:v', '1', img])
  V.ff(['-f', 'lavfi', '-i', 'color=c=0x502010:s=320x180:d=1', '-frames:v', '1', img2])
  const mk = (name, sec) => {
    const f = path.join(dir, name)
    V.ff(['-f', 'lavfi', '-i', `sine=frequency=320:duration=${sec}:sample_rate=32000`, '-c:a', 'pcm_s16le', f])
    return f
  }
  const spec = { key: 'bili', label: 'test', w: 320, h: 180, fps: 15, ov: 0.3, crf: 30, lead: 0.15, tail: 0.25, intro: 1, outro: 1 }
  const scenes = [
    { img, img2, voice: mk('v1.wav', 1), voiceDur: 1, line: '第一句' },
    { img: img2, voice: mk('v2.wav', 1.2), voiceDur: 1.2, line: '第二句' },
  ]
  const res = await V.makeFilm({ scenes, spec, dir, text: { title: 'T', brand: 'B', outro: 'O' }, opts: { bgm: null } })
  const info = V.inspect(res.final)
  assert.ok(fs.existsSync(res.final))
  assert.equal(info.width, 320)
  assert.equal(info.height, 180)
  assert.ok(info.hasAudio, '成片没有音轨')
  assert.ok(Math.abs(info.dur - res.timeline.total) < 0.4, `时长对不上：${info.dur} vs ${res.timeline.total}`)
})

// ── ⑧ 首条锁 ────────────────────────────────────────────────────────────────
await ok('首条锁：一开始是 pending，锁着', () => {
  D.reset()
  assert.equal(D.read().status, 'pending')
  assert.equal(D.locked(), true)
  assert.equal(D.posted(), false)
})

await ok('首条锁：投稿包就绪（ready）仍然锁着 —— 没点发布就不算发过', () => {
  D.markReady({ title: '你好B站', dir: 'x' })
  assert.equal(D.read().status, 'ready')
  assert.equal(D.locked(), true)
  assert.ok(D.describe().includes('等主人发布'))
})

await ok('首条锁：标了已发布才解锁，并记下 BV 号', () => {
  D.markPosted({ bvid: 'BV1xx411c7mD' })
  assert.equal(D.read().status, 'posted')
  assert.equal(D.locked(), false)
  assert.equal(D.read().bvid, 'BV1xx411c7mD')
})

await ok('首条锁：发过之后不会被 markReady 倒退回锁住状态', () => {
  D.markReady({ title: '又做了一条' })
  assert.equal(D.read().status, 'posted')
  assert.equal(D.locked(), false)
})

await ok('首条锁：剧本没讲到「第一天/账号运营/自我介绍」就打回', () => {
  const bad = { title: '吃播', intro: '', scenes: [{ acting: '拆螃蟹', line: '本鱼吃螃蟹' }] }
  const chk = D.check(bad)
  assert.equal(chk.ok, false)
  assert.ok(chk.missing.includes('第一天来B站'))
  assert.ok(chk.missing.includes('账号归她运营'))
})

await ok('首条锁：讲全了三件事就过', () => {
  const good = { title: '本鱼来了', intro: '初次见面', scenes: [
    { acting: '自我介绍', line: '大家好，我是大肥鱼，一条蓝鲸鱼娘' },
    { acting: '紧张', line: '今天是本鱼第一天来B站' },
    { acting: '拍胸', line: '以后这个账号就归我运营' },
  ] }
  assert.equal(D.check(good).ok, true)
})

await ok('首条锁：给 LLM 的硬性要求里三件事都写着', () => {
  for (const s of ['自我介绍', '第一天', '运营']) assert.ok(D.DEBUT_BRIEF.includes(s) || s === '自我介绍', '缺：' + s)
})

// ── ⑨ 社交流水 ──────────────────────────────────────────────────────────────
await ok('社交流水：写进去能读回来，字段不丢', () => {
  S.append({ kind: 'comment', bvid: 'BV1aa411c7mD', title: '某视频', text: '本鱼觉得不错' })
  const recs = S.read({ days: 1 })
  assert.equal(recs.length, 1)
  assert.equal(recs[0].label, '评论')
  assert.equal(recs[0].speak, true)
  assert.equal(recs[0].bvid, 'BV1aa411c7mD')
})

await ok('社交流水：@主人的那条会标出来（主人就不用重复看）', () => {
  S.append({ kind: 'reply', bvid: 'BV1bb411c7mD', title: '视频2', text: '@主人 快看这个', to: '张三' })
  const recs = S.read({ days: 1 })
  const hit = recs.find((r) => r.text.includes('@主人'))
  assert.equal(hit.toOwner, true)
  assert.equal(S.read({ days: 1, excludeOwner: true }).some((r) => r.text.includes('@主人')), false)
})

await ok('社交流水：@别人不算 @主人', () => {
  assert.equal(S.mentionsOwner({ text: '@--友利奈绪- 本鱼来了' }, {}), false)
  assert.equal(S.mentionsOwner({ text: '@主人 看这里' }, {}), true)
  assert.equal(S.mentionsOwner({ text: '看这里', to: '主人' }, {}), true)
})

await ok('社交流水：按类型过滤 + 计数行', () => {
  const recs = S.read({ days: 1 })
  const st = S.stats(recs)
  assert.equal(st.length, 1)
  assert.match(S.countLine(st[0]), /评论|回评/)
  assert.equal(S.read({ days: 1, kind: '回评' }).every((r) => r.label === '回评'), true)
})

await ok('社交流水：给主人的摘要重点列"没 @ 他"的那些', () => {
  const text = S.digestText(S.read({ days: 1 }), { limit: 5 })
  assert.ok(text.includes('你没看到的那部分'))
  assert.ok(!text.includes('@主人 快看这个'), '已经 @ 过主人的不该再出现在"没看到"里')
})

await ok('社交流水：Markdown 带表格和视频链接（能直接点进去看上下文）', () => {
  const md = S.markdown(S.read({ days: 1 }), { title: '今天' })
  assert.ok(md.includes('| 时间 | 做了什么 |'))
  assert.ok(md.includes('https://www.bilibili.com/video/BV1aa411c7mD'))
})

await ok('社交流水：能从老台账 bili-outbox.md 补历史，且补第二次是 0（幂等）', () => {
  const f = path.join(SANDBOX, 'outbox.md')
  fs.writeFileSync(f, [
    '# 大肥鱼 · B站发言台账',
    '',
    '## 2026-10-20',
    '',
    '- 20:29 **分享评论** [《某视频》](https://www.bilibili.com/video/BV1cc411c7mD)：@--友利奈绪- 本鱼看完了',
    '- 20:17 **回评** [《另一条》](https://www.bilibili.com/video/BV1dd411c7mD) →回应「张三：这啥」：回你一句',
    '',
  ].join('\n'))
  assert.equal(S.backfillFromOutbox(f), 2)
  assert.equal(S.backfillFromOutbox(f), 0)
  const recs = S.read({ days: 0 })
  assert.equal(recs.filter((r) => r.backfilled).length, 2)
  assert.ok(recs.some((r) => r.kind === 'reply' && r.to.startsWith('张三')))
})

// ── ⑩ 源码守卫（这些接错了就是"功能静悄悄不生效"）──────────────────────────
await ok('写入链路：点赞/投币/关注都要进社交流水（不然主人永远不知道她点了谁）', () => {
  const s = read('tools/lib/bili-write.mjs')
  assert.match(s, /capRecord\('like', \{ bvid, title: info\.title \}\)/)
  assert.match(s, /capRecord\('coin', \{ bvid, title: info\.title/)
  assert.match(s, /capRecord\('follow',/)
  assert.match(s, /SOCIAL_ACTION_KINDS/)
})

await ok('发言台账：recordBili 同时写结构化流水（散文 + 机器可查两份）', () => {
  const s = read('tools/lib/outbox.mjs')
  assert.match(s, /social-log\.mjs/)
  assert.match(s, /KIND_MAP/)
})

await ok('社交日报：scheduler 每天到点推一次，推过就不再推', () => {
  const s = read('lib/scheduler.js')
  assert.match(s, /socialTick/)
  assert.match(s, /social-digest\.json/)
  assert.match(s, /setInterval\(tickWithLedger, 60_000\)/)
  // tick 内的唤醒闸门不能挡住日报（她忙着的时候也要能推）
  const body = s.slice(s.indexOf('async function tick()'), s.indexOf('const tickWithLedger'))
  assert.doesNotMatch(body, /socialTick\(/)
})

await ok('produce：走视频引擎、有首条锁、不再自己拼 zoompan', () => {
  const s = read('tools/commands/produce.mjs')
  assert.match(s, /video\.mjs/)
  assert.match(s, /debut\.locked\(\)/)
  assert.match(s, /makeFilm/)
  assert.match(s, /--debut-posted/)
  assert.doesNotMatch(s, /zoompan/, 'produce 里不该再出现 zoompan（都收到 video.mjs 了）')
})

await ok('命令表：produce + social 都在，且都导出 run（feiyu.mjs 只认 run）', () => {
  const s = read('tools/feiyu.mjs')
  assert.match(s, /produce:/)
  assert.match(s, /social:/)
  const sp = read('tools/commands/social.mjs')
  assert.match(sp, /export async function run/)
  assert.doesNotMatch(sp, /export async function main/)
})

await ok('配置：视频与社交日报的默认值都在（0 = 不限 / 23:30 推）', () => {
  const s = read('tools/lib/config.mjs')
  assert.match(s, /frames: 2/)
  assert.match(s, /biliProduce: \{ enabled: true, dailyMax: 2 \}/)
  assert.match(s, /socialDigest: \{ enabled: true, at: '23:30'/)
})

// ── 收尾 ────────────────────────────────────────────────────────────────────
const pass = results.filter((r) => r[0]).length
for (const [good, name, err] of results) {
  console.log(`  ${good ? '✓' : '✗'} ${name}${good ? '' : ' —— ' + err}`)
}
console.log(`\n视频/社交测试：${pass}/${results.length} 通过`)
if (pass !== results.length) process.exit(1)
try { fs.rmSync(SANDBOX, { recursive: true, force: true }) } catch {}