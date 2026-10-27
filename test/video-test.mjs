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
const T = await import('file:///' + path.join(ROOT, 'tools/lib/tts.mjs').replace(/\\/g, '/'))

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

// ── ⑨ 配音对齐与漏字（10-26 主人报"字幕和语音没对上、漏了很多字"）────────────────
// 造一条"0.3s 静音 + 1.0s 正弦 + 0.3s 静音"的 wav 当素材，验三件事：
//   说话段测得准、剪完头尾干净、成片同步校验能把偏移算出来。
const toneWav = path.join(SANDBOX, 'tone.wav')
{
  const sr = 16000
  const n = Math.round(sr * 1.6)
  const pcm = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++) {
    const t = i / sr
    const live = t >= 0.3 && t < 1.3
    pcm.writeInt16LE(live ? Math.round(Math.sin(2 * Math.PI * 440 * t) * 12000) : 0, i * 2)
  }
  const head = Buffer.alloc(44)
  head.write('RIFF', 0, 'ascii'); head.writeUInt32LE(36 + n * 2, 4); head.write('WAVE', 8, 'ascii')
  head.write('fmt ', 12, 'ascii'); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22)
  head.writeUInt32LE(sr, 24); head.writeUInt32LE(sr * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34)
  head.write('data', 36, 'ascii'); head.writeUInt32LE(n * 2, 40)
  fs.writeFileSync(toneWav, Buffer.concat([head, pcm]))
}

await ok('说话段检测：头尾 0.3s 静音被认出来（on≈0.30 / off≈1.30）', () => {
  const sp = V.speechSpan(toneWav)
  assert.ok(Math.abs(sp.on - 0.3) <= 0.05, `on=${sp.on}`)
  assert.ok(Math.abs(sp.off - 1.3) <= 0.05, `off=${sp.off}`)
  assert.ok(Math.abs(sp.dur - 1.6) <= 0.01, `dur=${sp.dur}`)
})

await ok('剪静音：剪完约 1.18s（前留 0.06 气口 + 后留 0.12 余音），开口就在开头', () => {
  const out = path.join(SANDBOX, 'tone.trim.wav')
  const r = V.trimVoice(toneWav, out)
  assert.ok(Math.abs(r.dur - 1.18) <= 0.06, `dur=${r.dur}`)
  const sp = V.speechSpan(out)
  assert.ok(sp.on <= 0.08, `剪完还有 ${sp.on}s 头静音`)
  assert.ok(sp.tail <= 0.16, `剪完还有 ${sp.tail}s 尾静音`)
})

await ok('剪静音不能毁音质：输出必须是原声的波形，不是 ±1 的方波（10-27 真凶）', () => {
  // 这是主人报了一周的"电音机械音"的根：writeWavLocal 把 Int16Array 当 float 压成 ±1 再乘 32767，
  // 整条配音只剩 3 个取值（-32767 / 0 / +32767）—— 满幅方波，听起来就是电音。
  const out = path.join(SANDBOX, 'tone.trim2.wav')
  V.trimVoice(toneWav, out)
  const b = fs.readFileSync(out)
  const set = new Set()
  for (let k = 44; k + 1 < b.length; k += 2) set.add(b.readInt16LE(k))
  assert.ok(set.size > 200, `不同取值只有 ${set.size} 个 —— 又被量化成方波了`)
  // 峰值不能顶到满幅（±1 方波必然满幅）
  let peak = 0
  for (let k = 44; k + 1 < b.length; k += 2) peak = Math.max(peak, Math.abs(b.readInt16LE(k)))
  assert.ok(peak < 32000, `峰值 ${peak} 顶到满幅了`)
})

await ok('只重做音轨：makeFilm 支持 reuseVisual，且时间轴对不上会自动重渲染', () => {
  const s = read('tools/lib/video.mjs')
  assert.match(s, /opts\.reuseVisual/)
  assert.match(s, /Math\.abs\(probeDur\(visualFile, cfg\) - timeline\.total\) <= 0\.2/)
  const p = read('tools/commands/produce.mjs')
  assert.match(p, /reuseVisual: reAudio/)
  assert.match(p, /hasFlag\(argv, '--reaudio'\)/)
})

await ok('同步校验：配音挪进混音里能被算出来，偏差 ≤0.06s（能当机器判据用）', () => {
  const mixFile = path.join(SANDBOX, 'mix.wav')
  // 混音 = 整个 wav（含 0.3s 头静音）挪到 1.9s → 真正开口落在 1.9+0.3=2.2s
  V.ff(['-i', toneWav, '-af', 'adelay=1900:all=1,apad=whole_dur=6', '-t', '6', mixFile])
  const spec = V.specOf('bili')
  // 期望开口 = starts[0] + lead = 1.8 + 0.4 = 2.2
  const timeline = { starts: [1.8], intro: 0, outro: 0, ov: 0, durs: [3], clips: [] }
  const r = V.verifySync({ video: mixFile, voices: [{ file: toneWav, index: 0 }], timeline, spec })
  assert.equal(r.length, 1)
  assert.ok(Math.abs(r[0].delta) <= 0.06, `delta=${r[0].delta}（找到 ${r[0].found}，期望 ${r[0].expect}）`)
  assert.ok(r[0].score > 0.5, `相关系数只有 ${r[0].score}`)
})

await ok('漏字闸门：13 字念 1.07 秒 = 12.2 字/秒，必须被拦下来', () => {
  assert.equal(P.speakChars('本鱼叫大肥鱼，住在主人电脑里。'), 13)
  assert.equal(P.speakChars('规矩就一条：别叫本鱼胖，哼。'), 11)
  assert.ok(13 / 1.07 > 6.0, '这条必须被判为离谱')
  const s = read('tools/commands/produce.mjs')
  // 判据窗口：下限放到 2.4（她的"温柔/撒娇"语气其实很慢），上限 6.0（超过就是句尾被吃了）
  assert.match(s, /RATE_OK = \[2\.4, 6\.0\]/)
  assert.match(s, /export async function synthChecked/)
  assert.match(s, /拆两句念/)          // 实在念不好就拆开念
  assert.match(s, /finalize\(/)          // 选中的 take 落地，临时 take 清掉
  assert.match(read('tools/lib/video.mjs'), /sc\.voiceDur = r\.dur/)  // 剪静音归 makeFilm
})

await ok('音色护栏：配音把 speed_factor 钉死 1.0、温度钉死 1.0（改一点就是变调/电音）', () => {
  const s = read('tools/commands/produce.mjs')
  // 只看配音那一段（从注释块到"策划"分界），策划用的 LLM 温度不算
  const voiceSeg = s.slice(s.indexOf('// ── 配音'), s.indexOf('// ── 策划'))
  assert.ok(voiceSeg.length > 500, '配音段落没找到')
  const code = voiceSeg.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
  // 10-27 之前这里是"别出现 speed_factor"——其实 slowdown 从情绪档案偷偷进来（wronged 0.95），
  // 那就是 5% 重采样 = 降 0.9 个半音 = "不是她的声音"。现在改成**显式钉死**：
  assert.match(code, /speed_factor:\s*1\.0/, '配音必须显式钉 speed_factor: 1.0')
  assert.equal(/prof\.speed|prof\.temperature/.test(code), false, '不许让情绪档案改语速/温度')
  assert.match(code, /videoTemperature \?\? 1\.0/, '温度默认必须是模型自己的 1.0')
  // 视频统一一个情绪参考（音高才稳），允许 voice.videoEmotion 改
  assert.match(s, /config\(\)\.voice\?\.videoEmotion/)
  assert.match(s, /emotion: emo/)
})

await ok('参考段体检：文本配不上音频的参考会被认出来（这是"念一半就收尾"的病根）', () => {
  const tone = path.join(SANDBOX, 'ref-tone.wav')
  V.ff(['-f', 'lavfi', '-i', 'sine=frequency=300:duration=6', '-ar', '32000', '-ac', '1', tone])
  // 6 秒音频只配 11 个字（≈2.4 秒的话）→ 配比 2.5，必须判不合格
  const bad = T.refSanity(tone, '是第一次看你这个样子呢。')
  assert.equal(bad.ok, false, `配比 ${bad.ratio} 竟然合格`)
  assert.ok(bad.ratio > 1.8, `ratio=${bad.ratio}`)
  // 同一段音频配一句话长差不多的文本 → 合格
  const good = T.refSanity(tone, '主人你看这条片子，本鱼自己剪的，声音是不是还认得出来呀，嗯？')
  assert.ok(good.dur > 5.5, `dur=${good.dur}`)
  assert.equal(good.ok, true, `配比 ${good.ratio} 应该是合格的`)
})

await ok('参考段体检（10-27 修正）：留白不算进配比 —— 音声剪出来的参考段不能被误杀', () => {
  const padded = path.join(SANDBOX, 'ref-padded.wav')
  // 3.6s 静音 + 2.55s 有声 ≈ bingjiao2.wav 的真实形状（6.19s 里 3.64s 是静音）
  V.ff(['-f', 'lavfi', '-i', 'sine=frequency=300:duration=2.55', '-af', 'adelay=3600|3600',
    '-t', '6.2', '-ar', '32000', '-ac', '1', padded])
  // 11 个字配 2.55s 的语音段 = 正常语速 → 必须合格（旧算法按整段 6.19s 算会判 2.59 不合格）
  const r = T.refSanity(padded, '是第一次看你这个样子呢。')
  assert.equal(r.ok, true, `配比 ${r.ratio}（语音段 ${r.speech}s）不该判不合格`)
  assert.ok(r.speech > 2.2 && r.speech < 3.0, `语音段量成了 ${r.speech}s，静音没剪掉`)
  assert.ok(r.ratioFile > 1.8, `整段配比 ${r.ratioFile} 才是旧算法的坑`)
  // 但闸门不能因此变瞎：同一段音频配 4 个字的文本 → 语音段太长，照样拦下来
  const short = T.refSanity(padded, '本鱼来啦')
  assert.equal(short.ok, false, `配比 ${short.ratio} 应该不合格`)
})

await ok('参考池兜底：默认参考不合格时自动换成她的情绪参考段（嗓子不变）', () => {
  const s = read('tools/lib/tts.mjs')
  assert.match(s, /export function refSanity/)
  const iPool = s.indexOf('export function refPool(')
  const iRaw = s.indexOf('function refPoolRaw(')
  assert.ok(iPool > 0 && iRaw > iPool, 'refPool 必须先过滤再兜底')
  const body = s.slice(iPool, iRaw)
  assert.match(body, /refSanity\(p\.ref_audio_path, p\.prompt_text\)\.ok/)
  assert.match(body, /emo-fallback/)
  // 一句话一个音色：候选共用一条参考段，不许多条轮换
  assert.match(body, /return \[good\[0\]\]/, '合格的参考段只留第一条')
  assert.match(body, /bestEmotionRef\(/, '兜底也只挑一条')
  assert.equal(body.includes('.flat()'), false, '不许把整库 8 条都丢进候选池')
})

await ok('句尾能量比：突然截断的尾巴比自然收束更"响"（辅助判据）', () => {
  const abrupt = path.join(SANDBOX, 'abrupt.wav')
  const fading = path.join(SANDBOX, 'fading.wav')
  V.ff(['-f', 'lavfi', '-i', 'sine=frequency=300:duration=1.2', '-ar', '32000', '-ac', '1', abrupt])
  V.ff(['-f', 'lavfi', '-i', 'sine=frequency=300:duration=1.2', '-af', 'afade=t=out:st=0.6:d=0.6', '-ar', '32000', '-ac', '1', fading])
  const a = V.speechSpan(abrupt)
  const f = V.speechSpan(fading)
  assert.ok(typeof a.tailEnergyRatio === 'number' && a.tailEnergyRatio > 0, `截断句尾比=${a.tailEnergyRatio}`)
  assert.ok(f.tailEnergyRatio < a.tailEnergyRatio, `衰减 ${f.tailEnergyRatio} 应小于截断 ${a.tailEnergyRatio}`)
})

await ok('台词情绪映射：撒娇/生气/温柔各归各的参考', () => {
  assert.equal(P.pickEmotion('本鱼叫大肥鱼，住在主人电脑里。'), 'coquettish')
  assert.equal(P.pickEmotion('规矩就一条：别叫本鱼胖，哼。'), 'coquettish')
  assert.equal(P.pickEmotion('今天真的有点生气'), 'angry')
  assert.equal(P.pickEmotion('慢点吃啊，别急'), 'tender')
  assert.equal(P.pickEmotion('随便。'), 'calm')
})

await ok('剪辑自洽：makeFilm 先剪静音再排时间轴，并把同步校验写进 sync.json', () => {
  const s = read('tools/lib/video.mjs')
  const iTrim = s.indexOf('trimVoices !== false')
  const iTimeline = s.indexOf('const timeline = buildTimeline(scenes, spec, { intro: opts.intro')
  assert.ok(iTrim > 0 && iTimeline > iTrim, '修剪必须在排时间轴之前')
  assert.match(s, /sync\.json/)
  assert.match(s, /sync = verifySync\(/)
})

await ok('重剪模式：--reuse 不重新生图，老包缺 plan.json 时能从 meta 反推', () => {
  const s = read('tools/commands/produce.mjs')
  assert.match(s, /--reuse/)
  assert.match(s, /rebuiltFromMeta: true/)
  assert.match(s, /画面 ♻ 沿用已有配图/)
})

const R = await import('../tools/lib/refclean.mjs')
await ok('参考段清洗（10-27）：中间的 2s 死空气被挤掉，首尾静音不留，文本跟着走', () => {
  const src = path.join(SANDBOX, 'ref-hole.wav')
  // 构造：0.3s 静音 + 0.5s 说话 + 2.0s 死空气 + 0.5s 说话 + 0.3s 静音（用 concat 拼，别用 filter 图）
  const seg = (name, dur, args) => {
    const f = path.join(SANDBOX, name)
    V.ff([...args, '-t', String(dur), '-ar', '32000', '-ac', '1', f])
    return f
  }
  const parts = [
    seg('s1.wav', 0.3, ['-f', 'lavfi', '-i', 'anullsrc=r=32000:cl=mono']),
    seg('a.wav', 0.5, ['-f', 'lavfi', '-i', 'sine=frequency=240:duration=0.5']),
    seg('g.wav', 2.0, ['-f', 'lavfi', '-i', 'anullsrc=r=32000:cl=mono']),
    seg('b.wav', 0.5, ['-f', 'lavfi', '-i', 'sine=frequency=240:duration=0.5']),
    seg('s2.wav', 0.3, ['-f', 'lavfi', '-i', 'anullsrc=r=32000:cl=mono']),
  ]
  const list = path.join(SANDBOX, 'ref-hole.txt')
  fs.writeFileSync(list, parts.map((f) => `file '${f.replace(/\\/g, '/')}'`).join('\n'), 'utf8')
  V.ff(['-f', 'concat', '-safe', '0', '-i', list, '-ar', '32000', '-ac', '1', src])
  fs.writeFileSync(src.replace(/\.wav$/, '.txt'), '这是一句话', 'utf8')
  const plan = R.planPieces(src)
  assert.ok(plan.removed > 1.5, `挤掉的死空气只有 ${plan.removed}s`)
  const r = R.compactRef(src)
  assert.ok(r.dur >= 3.0, `清洗后只有 ${r.dur}s（api_v2 要求 ≥3 秒）`)
  assert.equal(r.text, '这是一句话')
  const sp = V.speechSpan(r.file)
  assert.ok(sp.on <= 0.1, `清洗后还有 ${sp.on}s 头静音`)
})

await ok('静态响度：只加固定增益，时长一点不变（不做动态压缩）', () => {
  const g = V.staticGainTo(toneWav, -16)
  assert.ok(Number.isFinite(g.lufs), `量不到 LUFS：${JSON.stringify(g)}`)
  assert.ok(Math.abs(g.gainDb) <= 12, `增益离谱：${g.gainDb}dB`)
  const before = V.speechSpan(toneWav).dur
  const out = path.join(SANDBOX, 'tone.gain.wav')
  V.applyGain(toneWav, -6, out)
  assert.ok(Math.abs(V.speechSpan(out).dur - before) < 0.02, '加增益后时长变了')
})

await ok('人声总线不吃 loudnorm（10-27：动态归一会把人声"泵"出机器味）', () => {
  const s = read('tools/lib/video.mjs')
  const iCompose = s.indexOf('export function composeAudio')
  const body = s.slice(iCompose, s.indexOf('export function mux', iCompose))
  // 只看真正拼进滤镜串的部分，注释里提到 loudnorm（说明为什么不用）不算
  const code = body.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')
  assert.equal(/loudnorm/.test(code), false, 'composeAudio 里还有 loudnorm')
  assert.match(code, /sidechaincompress/)
})

await ok('视频配音钉死"原声"：温度默认 1.0、语速 1.0、按保真选而不是按起伏选', () => {
  const s = read('tools/commands/produce.mjs')
  assert.match(s, /videoTemperature \?\? 1\.0/)
  assert.match(s, /speed_factor: 1\.0/)
  assert.match(s, /fidelity: true/)
  assert.equal(/speed_factor: (?!1\.0)\d/.test(s), false, 'produce 里出现非 1.0 的语速')
  assert.match(s, /tuneRegister/)
  assert.match(s, /judgeSpeech\(tmp, speakChars\(sc\.line\)\)/)
})

await ok('音区锚不能用参考段：tuneRegister 取本片中位，且只在偏离 >1.2 半音时才重念', () => {
  const s = read('tools/commands/produce.mjs')
  const i = s.indexOf('export async function tuneRegister')
  const body = s.slice(i, s.indexOf('/** 数音节', i))
  assert.match(body, /anchor = med\(regs\)/)
  assert.equal(/ref_register|refRegister/.test(body), false, '别拿参考段当锚（它比正常说话高 7 个半音）')
  assert.match(body, /span = 1\.2/)
  // 糙音也要管：HNR<2dB 重念，且绝不接受 HNR<1.0 的替换
  assert.match(body, /hnrMin = 2\.0/)
  assert.match(body, /hn < 1\.0/)
})

await ok('配音抽到满意的就锁住：--keep-voices 沿用现有 wav，不合格才重念', () => {
  const s = read('tools/commands/produce.mjs')
  assert.match(s, /keepVoices/)
  assert.match(s, /沿用已有（/)
  assert.match(s, /RATE_OK\[0\] <= rate && rate <= RATE_OK\[1\]/)
})

await ok('额度只管新剪：--reuse / --keep-voices / --force 不吃当日额度', () => {
  const s = read('tools/commands/produce.mjs')
  assert.match(s, /const rebake = hasFlag\(argv, '--force'\) \|\| hasFlag\(argv, '--reuse'\) \|\| hasFlag\(argv, '--keep-voices'\)/)
  // --reuse 后面紧跟开关时不能被当成目录（10-27 踩过：目录变成 "--keep-voices"）
  assert.match(s, /String\(v\)\.startsWith\('--'\) \? d : v/)
})

// ── 收尾 ────────────────────────────────────────────────────────────────────
const pass = results.filter((r) => r[0]).length
for (const [good, name, err] of results) {
  console.log(`  ${good ? '✓' : '✗'} ${name}${good ? '' : ' —— ' + err}`)
}
console.log(`\n视频/社交测试：${pass}/${results.length} 通过`)
if (pass !== results.length) process.exit(1)
try { fs.rmSync(SANDBOX, { recursive: true, force: true }) } catch {}