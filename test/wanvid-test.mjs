// wanvid 离线测试（10-27）—— 不出网：本地起一个假的中转站，把"提交/轮询/下载/掐音轨/套时间轴"全跑一遍。
//
// 为什么非要起假服务器：这条链路最贵的两个错误都在真实调用里 ——
//   ① 模型自带的那条音轨漏进成片（人声就变成"AI 念的"了，还跟 SoVITS 打架）；
//   ② 片段时长和时间轴对不上（成片音画不同步，最难排查的那种）。
// 所以这里用一条**带音轨的假成片**当素材：如果 output 里还有 audio 流，测试就该红。
//
// 隔离：USERPROFILE / DSH_HOME / FEIYU_CONFIG 全指到临时目录，绝不碰主人真的 ~/.feiyu-ai。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import assert from 'node:assert/strict'

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-wanvid-'))
process.env.USERPROFILE = SANDBOX
process.env.HOME = SANDBOX
process.env.DSH_HOME = path.join(SANDBOX, '.dsh')

const ROOT = path.resolve(import.meta.dirname, '..')
const url = (rel) => 'file:///' + path.join(ROOT, rel).replace(/\\/g, '/')

// ── 假中转站 ────────────────────────────────────────────────────────────────
const SRC = path.join(SANDBOX, 'fake-gen.mp4')     // 带音轨的"模型成片"（3s / 360×640）
const IMG = path.join(SANDBOX, 'still.jpg')
const seen = { submits: 0, polls: 0, badAsync: 0, noAuth: 0 }
let BASE = ''
const polls = new Map()

const server = http.createServer(async (req, res) => {
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)) }
  if (req.url === '/out.mp4') {
    res.writeHead(200, { 'Content-Type': 'video/mp4' })
    res.end(fs.readFileSync(SRC))
    return
  }
  if (req.method === 'POST' && req.url === '/api/v1/services/aigc/video-generation/video-synthesis') {
    let body = ''
    for await (const c of req) body += c
    seen.submits++
    if (!String(req.headers.authorization || '').startsWith('Bearer ')) seen.noAuth++
    if (req.headers['x-dashscope-async'] !== 'enable') { seen.badAsync++; return send(400, { code: 'AccessDenied', message: 'current user api does not support asynchronous calls' }) }
    let j = {}
    try { j = JSON.parse(body) } catch { return send(400, { code: 'InvalidParameter', message: 'bad json' }) }
    const media = j?.input?.media?.[0]?.url || ''
    if (!media.startsWith('data:image/')) return send(400, { code: 'InvalidParameter', message: 'Field required: input.media' })
    if (String(j?.input?.prompt || '').includes('BAD')) return send(400, { code: 'InvalidParameter', message: 'prompt 不合规（假服务器故意拦）' })
    const dur = Number(j?.parameters?.duration)
    if (!Number.isInteger(dur) || dur < 2 || dur > 15) return send(400, { code: 'InvalidParameter', message: `duration 只能是 2~15 的整数，收到 ${dur}` })
    const id = `task-${seen.submits}`
    polls.set(id, 0)
    return send(200, { output: { task_id: id, task_status: 'PENDING' }, request_id: 'r' })
  }
  if (req.method === 'GET' && req.url.startsWith('/api/v1/tasks/')) {
    const id = decodeURIComponent(req.url.split('/').pop())
    seen.polls++
    const n = (polls.get(id) || 0) + 1
    polls.set(id, n)
    // 故意让第一条任务先 RUNNING 一次：验证状态流转不会误判
    if (n === 1 && id === 'task-1') return send(200, { output: { task_id: id, task_status: 'RUNNING' } })
    return send(200, { output: { task_id: id, task_status: 'SUCCEEDED', video_url: `${BASE}/out.mp4` } })
  }
  send(404, { code: 'NotFound', message: req.url })
})

await new Promise((r) => server.listen(0, '127.0.0.1', r))
BASE = `http://127.0.0.1:${server.address().port}`

// 配置：让它指向假服务器（key 随便，假服务器只认 Bearer 头在不在）
fs.mkdirSync(path.join(SANDBOX, '.dsh'), { recursive: true })
fs.writeFileSync(path.join(SANDBOX, '.dsh', 'feiyu.config.json'), JSON.stringify({
  llm: { base_url: `${BASE}/compatible-mode/v1`, api_key: 'sk-fake-for-test', model: 'x' },
  video: { animate: { enabled: true, resolution: '720P', pollSec: 1, maxWaitSec: 30, retries: 0, pricePerSecond: 0.5 } },
}))

const V = await import(url('tools/lib/video.mjs'))
const W = await import(url('tools/lib/wanvid.mjs'))

const results = []
async function ok(name, fn) {
  try { await fn(); results.push([true, name]) } catch (e) { results.push([false, name, e?.message || String(e)]) }
}

try {
  // 素材：3 秒、360×640、**带 AAC 音轨**的假"模型成片"
  V.ff(['-f', 'lavfi', '-i', 'color=c=0x1b2b4b:s=360x640:d=3:r=30',
    '-f', 'lavfi', '-i', 'sine=frequency=300:duration=3:sample_rate=48000',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', SRC])
  V.ff(['-f', 'lavfi', '-i', 'color=c=0xdd4466:s=1000x1500:d=1', '-frames:v', '1', '-q:v', '3', IMG])
  const srcInfo = W.inspectClip(SRC)
  assert.ok(srcInfo?.hasAudio, '素材必须带音轨，否则测不出"掐音轨"这一步')

  // ── ① 切段算术 ───────────────────────────────────────────────────────────
  await ok('切段：22s → 两段且和恰好 22（不许出现 <2 的尾巴）', () => {
    const segs = W.planSegments(22, 15)
    assert.equal(segs.length, 2)
    assert.equal(segs.reduce((a, b) => a + b, 0), 22)
    assert.ok(segs.every((d) => d >= 2 && d <= 15), `每段必须 2~15：${segs}`)
  })
  await ok('切段：5s 一段搞定；40s → 三段且每段 ≤15', () => {
    assert.deepEqual(W.planSegments(5, 15), [5])
    const segs = W.planSegments(40, 15)
    assert.equal(segs.length, 3)
    assert.equal(segs.reduce((a, b) => a + b, 0), 40)
    assert.ok(segs.every((d) => d <= 15 && d >= 2))
  })

  // ── ② 开关判定：缺 key / 关掉，都不许偷偷花钱 ────────────────────────────
  await ok('开关：enabled=false / 没 key / 没地址 → available() 全 false', () => {
    assert.equal(W.available({ video: { animate: { enabled: false } }, llm: { api_key: 'k', base_url: BASE } }), false)
    assert.equal(W.available({ video: { animate: {} }, llm: { api_key: '', base_url: BASE } }), false)
    assert.equal(W.available({ video: { animate: {} }, llm: { api_key: 'k', base_url: '' } }), false)
    assert.equal(W.available(), true, '沙箱配置齐全时应为 true')
  })
  await ok('地址：从 llm.base_url 剥出中转站根地址', () => {
    assert.equal(W.dashscopeBase({ llm: { base_url: 'https://maas.example.com/compatible-mode/v1' } }), 'https://maas.example.com')
    assert.equal(W.dashscopeBase({ video: { animate: { baseUrl: 'https://dashscope.aliyuncs.com/' } }, llm: { base_url: 'x' } }), 'https://dashscope.aliyuncs.com')
  })

  // ── ③ 首帧预处理：裁成平台规格（输出宽高比跟着首帧走）────────────────────
  const still = path.join(SANDBOX, 'first.jpg')
  await ok('首帧预处理：1000×1500 的图 → 裁成 360×640', () => {
    W.prepareFirstFrame({ src: IMG, out: still, w: 360, h: 640 })
    const i = W.inspectClip(still)   // 图片也能被 ffprobe 读出宽高
    assert.equal(i.width, 360)
    assert.equal(i.height, 640)
  })

  // ── ④ 一条片段：提交 → 轮询 → 下载 → 掐音轨 ──────────────────────────────
  const one = path.join(SANDBOX, 'one.mp4')
  await ok('animate：出片、时长对、**音轨被掐掉**、原片留底（原片有音轨）', async () => {
    const r = await W.animate({ firstFrame: still, prompt: '她轻轻眨眼', seconds: 3, out: one })
    assert.ok(r.taskId, '应拿到 task_id')
    const i = W.inspectClip(one)
    assert.equal(i.hasAudio, false, '模型自带的音轨必须掐掉')
    assert.equal(i.width, 360)
    assert.ok(Math.abs(i.dur - 3) < 0.2, `时长应≈3s，实际 ${i.dur}`)
    assert.ok(fs.existsSync(r.raw), '原片应留底')
    assert.equal(W.inspectClip(r.raw).hasAudio, true, '留底的原片应保留模型音轨（便于对比）')
  })
  await ok('animate：服务端报错要抛出来（不能静默当成功）', async () => {
    await assert.rejects(
      () => W.animate({ firstFrame: still, prompt: 'BAD 这句会被假服务器拦', seconds: 3, out: path.join(SANDBOX, 'bad.mp4') }),
      /万相提交失败.*InvalidParameter/s,
    )
  })
  await ok('animate：少 X-DashScope-Async 的请求会被服务端拒（我们是带上的）', () => {
    assert.equal(seen.badAsync, 0, '不该有缺 header 的请求')
    assert.equal(seen.noAuth, 0, '不该有缺 Authorization 的请求')
  })

  // ── ⑤ 一幕多段：切段 + 段间用末帧续首帧 + concat ─────────────────────────
  const sceneDir = path.join(SANDBOX, 'clips')
  await ok('animateScene：20s 一幕 → 自动切 2 段并拼成一条（无音轨）', async () => {
    const r = await W.animateScene({ still, seconds: 20, prompt: '她对着镜头说话', dir: sceneDir, index: 0 })
    assert.deepEqual(r.segments, [10, 10])
    assert.equal(r.spent, 20)
    assert.equal(r.tasks.length, 2)
    const i = W.inspectClip(r.file)
    assert.equal(i.hasAudio, false)
    assert.ok(i.dur > 5.5, `两段 3s 素材拼起来应 ≈6s，实际 ${i.dur}`)
    assert.ok(fs.existsSync(path.join(sceneDir, 'anim-0-0.last.jpg')), '第二段的首帧应来自第一段的末帧')
  })

  // ── ⑥ 套时间轴：截 / 放慢 / 回旋循环 三条路 ─────────────────────────────
  await ok('conformClip：素材够长 → 直接截到目标时长', () => {
    const out = path.join(SANDBOX, 'cut.mp4')
    V.conformClip({ src: SRC, out, dur: 2, w: 360, h: 640, fps: 30 })
    const i = W.inspectClip(out)
    assert.ok(Math.abs(i.dur - 2) < 0.15, `应≈2s，实际 ${i.dur}`)
    assert.equal(i.hasAudio, false)
    assert.equal(i.width, 360)
  })
  await ok('conformClip：差一点 → 轻微放慢补齐（3s → 4s）', () => {
    const out = path.join(SANDBOX, 'slow.mp4')
    V.conformClip({ src: SRC, out, dur: 4, w: 360, h: 640, fps: 30 })
    const i = W.inspectClip(out)
    assert.ok(Math.abs(i.dur - 4) < 0.2, `应≈4s，实际 ${i.dur}`)
  })
  await ok('conformClip：差很多 → 回旋循环补齐（3s → 8s）', () => {
    const out = path.join(SANDBOX, 'loop.mp4')
    V.conformClip({ src: SRC, out, dur: 8, w: 360, h: 640, fps: 30 })
    const i = W.inspectClip(out)
    assert.ok(Math.abs(i.dur - 8) < 0.25, `应≈8s，实际 ${i.dur}`)
    assert.equal(fs.existsSync(out.replace(/\.mp4$/, '.pp.mp4')), false, '回旋中间文件要清掉')
  })

  // ── ⑦ 端到端：3 幕真片段进 makeFilm，成片音轨只有我们自己的 ──────────────
  await ok('makeFilm：三幕都用真片段，成片时长/规格对、音轨只有一条（人手混的）', async () => {
    const dir = path.join(SANDBOX, 'film')
    fs.mkdirSync(dir, { recursive: true })
    const spec = { key: 't', label: '测试', w: 360, h: 640, fps: 30, ov: 0.4, crf: 30, lead: 0.3, tail: 0.5, intro: 0, outro: 0 }
    const scenes = []
    for (let i = 0; i < 3; i++) {
      const wav = path.join(dir, `v${i}.wav`)
      V.ff(['-f', 'lavfi', '-i', `sine=frequency=${200 + i * 40}:duration=1.5:sample_rate=48000`, wav])
      const clip = path.join(dir, `c${i}.mp4`)
      fs.copyFileSync(SRC, clip)               // 3s 带音轨的"模型片段"
      scenes.push({ img: IMG, clip, voice: wav, voiceDur: 1.5, line: `第${i + 1}句台词` })
    }
    const res = await V.makeFilm({
      scenes, spec, dir, text: { title: '测试片', brand: '大肥鱼' },
      opts: { trimVoices: false, bgm: null, intro: 0, outro: 0 }, log: () => {},
    })
    const info = V.inspect(res.final)
    assert.ok(info.dur > 3, `成片应有时长，实际 ${info.dur}`)
    assert.equal(info.width, 360)
    assert.equal(info.hasAudio, true, '人声轨要在')
    const visual = V.inspect(path.join(dir, 'visual.mp4'))
    assert.equal(visual.hasAudio, false, '画面轨不许带任何音轨（模型音轨一旦漏进来就是这里红）')
    for (let i = 0; i < 3; i++) {
      const shot = V.inspect(path.join(dir, 'clips', `shot-${i}.mp4`))
      assert.ok(shot, `第 ${i + 1} 幕的镜头应存在`)
      assert.equal(shot.hasAudio, false, `第 ${i + 1} 幕镜头不许带音轨`)
    }
  })

  // ── ⑧ 自检函数 ───────────────────────────────────────────────────────────
  await ok('inspectClip：读得出宽高/时长/有无音轨', () => {
    const i = W.inspectClip(SRC)
    assert.equal(i.width, 360)
    assert.equal(i.height, 640)
    assert.equal(i.hasAudio, true)
    assert.ok(i.dur > 2.5)
    assert.equal(W.inspectClip(path.join(SANDBOX, 'nope.mp4')), null)
  })

  const bad = results.filter(([o]) => !o)
  for (const [o, name, err] of results) console.log(`${o ? '✓' : '✗'} ${name}${o ? '' : '\n    ' + err}`)
  console.log(`\nwanvid ${results.length - bad.length}/${results.length} 通过`)
  if (bad.length) process.exitCode = 1
} finally {
  server.close()
  fs.rmSync(SANDBOX, { recursive: true, force: true })
}