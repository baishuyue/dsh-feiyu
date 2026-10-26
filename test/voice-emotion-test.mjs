// 情绪语音三层（L0 参数+择优 / L1 情绪标签 / L2 情绪参考段）回归测试
//
// 三轮实验的数字是这三层的存在理由（10-26）：
//   线上默认参数          F0 起伏 3.02 / 音域 9.06
//   只放开切句+温度 1.35   4.82 / 15.29
//   同参数连合 8 条        3.51 ~ 5.20（抽奖，所以要择优）
//   真·人声参考           4.78 / 14.88
// 测的是"契约"，不是音质：标签解析、分段、参考段池、分块、拼接、提示语注入、源码防线。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 先把 dataPath 指到临时目录 —— 情绪参考段清单不能读主人真实的那份
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-emo-test-'))
process.env.DSH_HOME = sandbox
process.env.USERPROFILE = sandbox
process.env.HOME = sandbox
process.env.FEIYU_HOME = path.join(sandbox, '.feiyu-ai')

const E = await import('../tools/lib/emotion.mjs')
const tts = await import('../tools/lib/tts.mjs')
const prosody = await import('../tools/lib/prosody.mjs')

let passed = 0
function ok(name, fn) {
  fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}
async function okAsync(name, fn) {
  await fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}

console.log('情绪标签（L1）')
ok('[[撒娇]] 认得出，而且剥干净', () => {
  const r = E.parseEmotionTag('[[撒娇]]主人你怎么才回我呀～')
  assert.equal(r.emotion, 'coquettish')
  assert.equal(r.text, '主人你怎么才回我呀～')
})
ok('【情绪：困】这种写法也认', () => {
  const r = E.parseEmotionTag('【情绪：困】别吵，我再睡五分钟。')
  assert.equal(r.emotion, 'sleepy')
  assert.equal(r.text, '别吵，我再睡五分钟。')
})
ok('生造词 [[火大]] 也认（别名兜住）', () => {
  assert.equal(E.parseEmotionTag('[[火大]]你又不吃饭').emotion, 'angry')
})
ok('[表情:开心] 不许被当成情绪标签吃掉', () => {
  const r = E.parseEmotionTag('主人[表情:开心] 我吃完了！')
  assert.equal(r.emotion, '')
  assert.equal(r.text, '主人[表情:开心] 我吃完了！')
})
ok('B站表情码 [doge] 原样保留', () => {
  assert.equal(E.stripEmotionTags('[doge]这条是表情码'), '[doge]这条是表情码')
})
ok('未知情绪名的双括号也要删掉（不能漏给主人看）', () => {
  assert.equal(E.stripEmotionTags('[[莫名]]喂').includes('[['), false)
})
ok('情绪 → 参数：都能查到，语速/温度在合理区间', () => {
  for (const label of ['平静', '开心', '撒娇', '委屈', '生气', '困倦', '害羞', '温柔', '惊讶']) {
    const p = E.emotionProfile(label)
    assert.notEqual(p.key, '', label + ' 没查到')
    assert.ok(p.temperature >= 1.0 && p.temperature <= 1.6, label + ' 温度越界')
    assert.ok(p.speed >= 0.85 && p.speed <= 1.15, label + ' 语速越界')
    assert.ok(p.pause >= 0.1 && p.pause <= 0.6, label + ' 停顿越界')
  }
})
ok('未知情绪回落 calm（不抛错）', () => {
  assert.equal(E.emotionProfile('莫名其妙').key, 'calm')
})

console.log('语音分段（L1）')
ok('一条长回复切成 ≤2 条语音，剩下的走文字', () => {
  const p = E.splitVoiceParts('你都不回我消息，我等到现在。饭都凉了，我一口没吃。你忙完了记得说一声。', { maxChars: 20, maxParts: 2 })
  assert.equal(p.parts.length, 2)
  for (const s of p.parts) assert.ok(s.length <= 22, '分段超长：' + s)
  assert.ok(p.rest.includes('忙完'), '剩余文字丢了：' + p.rest)
})
ok('短回复只有一条语音、没有剩余', () => {
  const p = E.splitVoiceParts('主人我回来了。', { maxChars: 60, maxParts: 2 })
  assert.equal(p.parts.length, 1)
  assert.equal(p.rest, '')
})
ok('超长单句硬切也不会超预算', () => {
  const long = '啊'.repeat(150)
  const p = E.splitVoiceParts(long, { maxChars: 30, maxParts: 2 })
  assert.equal(p.parts.length, 2)
  for (const s of p.parts) assert.ok(s.length <= 30)
})

console.log('参考段池（L2）')
ok('没建情绪库时只有配置那一段', () => {
  const pool = tts.refPool('coquettish', { ref_audio_path: 'X:/a.wav', prompt_text: '甲' })
  assert.equal(pool.length, 1)
  assert.equal(pool[0].from, 'config')
})
ok('情绪库有就用"情绪段 + 默认段"两段都上（谁合出来像人用谁）', () => {
  const dir = path.join(sandbox, '.feiyu-ai', 'voice-emo', 'angry')
  fs.mkdirSync(dir, { recursive: true })
  const wav = path.join(dir, 'ref.wav')
  fs.writeFileSync(wav, 'x')
  fs.writeFileSync(path.join(dir, 'ref.txt'), '你怎么又不吃饭啊！', 'utf8')
  const man = path.join(sandbox, '.feiyu-ai', 'voice-emo', 'manifest.json')
  fs.writeFileSync(man, JSON.stringify({ angry: { wav, text: '你怎么又不吃饭啊！', sd: 4.8, rng: 14.6 } }), 'utf8')
  const pool = tts.refPool('angry', { ref_audio_path: 'X:/default.wav', prompt_text: '乙' })
  assert.equal(pool.length, 2)
  assert.equal(pool[0].from, 'emotion:angry')
  assert.equal(pool[0].prompt_text, '你怎么又不吃饭啊！')  // 参考文本取 ref.txt，不信配置
  assert.equal(pool[1].from, 'config')
})
ok('显式指定参考音频时只用那一段', () => {
  const pool = tts.refPool('angry', {}, { ref_audio_path: 'Y:/z.wav' })
  assert.equal(pool.length, 1)
  assert.equal(pool[0].from, 'override')
})

console.log('分块与拼接（L0）')
ok('80 字以内不分块', () => {
  assert.deepEqual(tts.splitForTts('主人我回来啦。'), ['主人我回来啦。'])
})
ok('长文本按句分块，每块不超预算', () => {
  const t = '第一句说完了。'.repeat(30)
  const chunks = tts.splitForTts(t, 80)
  assert.ok(chunks.length > 1)
  for (const c of chunks) assert.ok(c.length <= 80, '块超长：' + c.length)
  assert.equal(chunks.join(''), t)
})
await okAsync('两段 wav 拼接 = 两段之和 + 间隔静音', async () => {
  const dir = path.join(sandbox, 'wav')
  fs.mkdirSync(dir, { recursive: true })
  const mk = (name, samples) => {
    const data = Buffer.alloc(samples * 2)
    for (let i = 0; i < samples; i++) data.writeInt16LE(1000, i * 2)
    const h = Buffer.alloc(44)
    h.write('RIFF', 0, 'ascii'); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8, 'ascii')
    h.write('fmt ', 12, 'ascii'); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22)
    h.writeUInt32LE(8000, 24); h.writeUInt32LE(16000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34)
    h.write('data', 36, 'ascii'); h.writeUInt32LE(data.length, 40)
    const f = path.join(dir, name)
    fs.writeFileSync(f, Buffer.concat([h, data]))
    return f
  }
  const a = mk('a.wav', 800)   // 0.1s
  const b = mk('b.wav', 800)
  const out = path.join(dir, 'ab.wav')
  tts.concatWav([a, b], out, 0.1)   // 0.1s 间隔 = 800 采样
  const buf = fs.readFileSync(out)
  assert.equal(buf.toString('ascii', 0, 4), 'RIFF')
  assert.equal(buf.length, 44 + (800 + 800 + 800) * 2)
  // 间隔那段应该是静音
  const gapStart = 44 + 800 * 2
  assert.equal(buf.readInt16LE(gapStart), 0)
})
await okAsync('只给一段时不拼接（直接复制）', async () => {
  const dir = path.join(sandbox, 'wav2')
  fs.mkdirSync(dir, { recursive: true })
  const src = path.join(dir, 'one.wav')
  fs.copyFileSync(path.join(sandbox, 'wav', 'a.wav'), src)
  const out = path.join(dir, 'out.wav')
  tts.concatWav([src], out, 0.1)
  assert.equal(fs.statSync(out).size, fs.statSync(src).size)
})

console.log('打分器（L0）')
ok('评分器脚本存在且用的是 pyin + 起伏/音域公式', () => {
  const py = fs.readFileSync(new URL('../tools/lib/prosody.py', import.meta.url), 'utf8')
  assert.match(py, /librosa\.pyin/)
  assert.doesNotMatch(py, /librosa\.yin\(/)          // yin 会把噪声估成倍频，起伏虚高
  assert.match(py, /rng \* 0\.5 \+ sd \* 1\.2/)
  assert.match(py, /语速/)
})
ok('找不到音频时返回"不可用"而不是抛错（语音不能被评分器拖死）', () => {
  const r = prosody.scoreWavs([{ path: path.join(sandbox, 'nope.wav'), chars: 10 }])
  assert.equal(r.length, 1)
  assert.equal(r[0].ok, false)
})
ok('空输入返回空数组', () => {
  assert.deepEqual(prosody.scoreWavs([]), [])
})
ok('bestOf 优先选 ok 的那条', () => {
  const best = prosody.bestOf([
    { path: 'a', ok: false, score: 15.0 },
    { path: 'b', ok: true, score: 13.0 },
  ])
  assert.equal(best.path, 'b')
})

console.log('提示语注入（L1）')
ok('QQ 的提示里带语气暗号，B站/抖音不带', () => {
  const qq = E.emotionTagPrompt('qq')
  assert.match(qq, /语气的暗号/)
  assert.match(qq, /撒娇/)
  assert.equal(E.emotionTagPrompt('bilibili'), '')
  assert.equal(E.emotionTagPrompt('douyin'), '')
})
ok('她能看懂"方括号不会显示给主人"', () => {
  assert.match(E.emotionTagPrompt('qq'), /不会显示给主人/)
})

console.log('源码防线')
const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8')
ok('tts.mjs：默认 cut0、候选循环、参考段轮流上', () => {
  const src = read('tools/lib/tts.mjs')
  assert.match(src, /text_split_method: override\.text_split_method \|\| v\.text_split_method \|\| 'cut0'/)
  assert.match(src, /pool\[k % pool\.length\]/)
  assert.match(src, /scoreWavs/)
})
ok('qq-server：情绪标签先剥掉再发、语音按情绪合成、剩余文字补发', () => {
  const src = read('tools/commands/qq-server.mjs')
  assert.match(src, /parseEmotionTag\(out\)/)
  assert.match(src, /synth\(line, undefined, \{ emotion \}\)/)
  assert.match(src, /splitVoiceParts\(plain/)
  assert.match(src, /if \(!spokeParts\) restText = plain/)
})
ok('voice 命令有 emo 子命令（建/列/试听情绪参考段）', () => {
  const src = read('tools/commands/voice.mjs')
  assert.match(src, /if \(act === 'build'\)/)
  assert.match(src, /voice emo list \| build/)
})
ok('persona 只在语音开着时才教她写标签', () => {
  const src = read('tools/lib/persona.mjs')
  assert.match(src, /cfg\.qq\?\.voice_enabled !== false/)
  assert.match(src, /emotionTagPrompt\(platform\)/)
})

fs.rmSync(sandbox, { recursive: true, force: true })
console.log(`\n全部 ${passed} 项通过`)