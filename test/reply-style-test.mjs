// 评论区「发什么都行」（10-27 主人的第二条要求）——
//   文字 / 颜文字 / emoji / 表情包 / 图片（抖音再加语音），
//   而且**自己作品下**和**刷到的别人视频下**都要能发。
//
// 这条测试盯死五件事：
//   ① chooseKind 按平台给得出类型：抖音有官方表情(emoji-pack)，B站 没有；语音只给抖音；
//   ② 配比拉 4000 次，抖音/B站 都真的出现各自那几种，且不会越界；
//   ③ decorateText 只会"加料"，绝不重复加（已经有 emoji/颜文字的句子原样返回）；
//   ④ 图片素材按平台扩展名过滤（抖音不吃 .gif，B站 不吃 .bmp）；
//   ⑤ 命令层真的把类型接线了：抖音 comment/comment-reply 有 --image/--emoji-pack、
//      engage 走 useUi、私信有 --file + 确认框发送；B站 postReply 带 pictures。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chooseKind, decorateText, pickCommentImage, describeKind, voiceNoteArgs, EXTS, KAOMOJI, EMOJI } from '../tools/lib/reply-style.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => fs.readFileSync(path.isAbsolute(p) ? p : path.join(ROOT, p), 'utf8')
let n = 0
const ok = async (name, fn) => { await fn(); n++; console.log(`  ✓ ${name}`) }

await ok('类型中文名：日志里说人话', () => {
  assert.equal(describeKind('text'), '文字')
  assert.equal(describeKind('emoji-pack'), '官方表情')
  assert.equal(describeKind('sticker'), '表情包')
  assert.equal(describeKind('image'), '图片')
  assert.equal(describeKind('voice'), '语音')
  assert.equal(describeKind('unknown-x'), '文字')
})

await ok('抖音：文字/官方表情/表情包/图片四种都可能出现', () => {
  const seen = new Set()
  for (let i = 0; i < 4000; i++) seen.add(chooseKind({ platform: 'douyin' }))
  for (const k of ['text', 'emoji-pack', 'sticker', 'image']) assert.ok(seen.has(k), `抖音 4000 次里没出现 ${k}`)
  assert.ok(!seen.has('voice'), '语音默认概率是 0，不该自己冒出来')
})

await ok('B站：没有官方表情、没有语音', () => {
  const seen = new Set()
  for (let i = 0; i < 4000; i++) seen.add(chooseKind({ platform: 'bilibili' }))
  assert.ok(seen.has('text'))
  assert.ok(!seen.has('emoji-pack'), 'B站 没有官方表情面板')
  assert.ok(!seen.has('voice'), 'B站 评论没有语音')
})

await ok('关掉 auto 就只发文字（主人可以一键收手）', () => {
  for (let i = 0; i < 200; i++) assert.equal(chooseKind({ platform: 'douyin', styles: { auto: false, sticker: 1 } }), 'text')
})

await ok('明确配了 voice 才会出语音', () => {
  const seen = new Set()
  const onlyVoice = { text: 0, emoji: 0, kaomoji: 0, sticker: 0, emojiPack: 0, image: 0, voice: 1 }
  for (let i = 0; i < 500; i++) seen.add(chooseKind({ platform: 'douyin', styles: onlyVoice }))
  assert.deepEqual([...seen], ['voice'])
  // 没素材时（只配了图/表情包，但这一轮不许发图）必须老老实实退回文字
  for (let i = 0; i < 50; i++) {
    const k = chooseKind({ platform: 'douyin', styles: { text: 0, emoji: 0, kaomoji: 0, emojiPack: 0, sticker: 1, image: 1 }, allowImage: false })
    assert.equal(k, 'text')
  }
})

await ok('颜文字/emoji 都归到 text（它们本来就是文字的一部分）', () => {
  const base = { text: 0, emoji: 0, kaomoji: 0, sticker: 0, emojiPack: 0, image: 0, voice: 0 }
  for (const st of [{ kaomoji: 1 }, { emoji: 1 }, { emoji: 1, kaomoji: 1 }]) {
    for (let i = 0; i < 50; i++) assert.equal(chooseKind({ platform: 'douyin', styles: { ...base, ...st } }), 'text')
  }
})

await ok('decorateText：加的是真 emoji / 颜文字', () => {
  let withEmoji = 0, withKaomoji = 0
  for (const s of KAOMOJI) assert.ok(typeof s === 'string' && s.length > 2)
  for (const s of EMOJI) assert.ok(typeof s === 'string' && s.length > 0)
  for (let i = 0; i < 400; i++) {
    const t = decorateText('这个饭看着真香', { emojiChance: 1, kaomojiChance: 0 })
    if (EMOJI.some((e) => t.includes(e))) withEmoji++
    const u = decorateText('这个饭看着真香', { emojiChance: 0, kaomojiChance: 1 })
    if (KAOMOJI.some((k) => u.includes(k))) withKaomoji++
  }
  assert.ok(withEmoji > 380, `emoji 命中率太低：${withEmoji}/400`)
  assert.ok(withKaomoji > 380, `颜文字命中率太低：${withKaomoji}/400`)
})

await ok('decorateText：已经带表情的句子不再叠（不画蛇添足）', () => {
  const already = ['好耶 😆', '哼 (・_・;)', '笑死 (๑•̀ㅂ•́)و✧']
  for (const s of already) {
    for (let i = 0; i < 30; i++) {
      assert.equal(decorateText(s, { emojiChance: 1, kaomojiChance: 1 }), s, `不该改动：${s}`)
    }
  }
})

await ok('decorateText：空文本原样返回，不炸', () => {
  assert.equal(decorateText(''), '')
  assert.equal(decorateText(null), '')
  assert.equal(decorateText(undefined), '')
})

await ok('图片素材：抖音不吃 gif、B站 不吃 bmp', () => {
  assert.ok(EXTS.douyin.includes('.jpg') && !EXTS.douyin.includes('.gif'))
  assert.ok(EXTS.bilibili.includes('.gif') && !EXTS.bilibili.includes('.bmp'))
  for (let i = 0; i < 200; i++) {
    const d = pickCommentImage({ platform: 'douyin' })
    if (d) assert.ok(EXTS.douyin.includes(path.extname(d).toLowerCase()), `抖音挑到了 ${d}`)
    const b = pickCommentImage({ platform: 'bilibili' })
    if (b) assert.ok(EXTS.bilibili.includes(path.extname(b).toLowerCase()), `B站 挑到了 ${b}`)
  }
})

await ok('语音条：封面+音轨合成 mp4 的参数对得上', () => {
  const a = voiceNoteArgs({ audioPath: 'a.wav', coverPath: 'c.jpg', outPath: 'o.mp4' })
  const s = a.join(' ')
  assert.match(s, /-loop 1/)
  assert.match(s, /c\.jpg/)
  assert.match(s, /a\.wav/)
  assert.match(s, /libx264/)
  assert.match(s, /aac/)
  assert.match(s, /-shortest/)
  assert.match(s, /-movflags \+faststart/)
  assert.equal(a[a.length - 1], 'o.mp4', '输出路径要在最后')
})

// ── 命令层接线 ────────────────────────────────────────────────────────────
const dy = read('tools/commands/douyin.mjs')
const rep = read('tools/commands/replies.mjs')
const py = read('D:/social-auto-upload/douyin_interact.py')
const bw = read('tools/lib/bili-write.mjs')

await ok('抖音 comment：带上 --image / --emoji-pack', () => {
  assert.match(dy, /emojiPack\s*=\s*-1|emojiPack: -1|emojiPack = style/)
  assert.match(dy, /'--emoji-pack'/)
  assert.match(dy, /'--image'/)
})

await ok('抖音 engage：带图/官方表情时走 UI 那条路（useUi）', () => {
  assert.match(dy, /const useUi = /)
  assert.match(dy, /if \(styleImage\) args\.push\('--image'/)
  assert.match(dy, /if \(styleEmojiPack\) args\.push\('--emoji-pack'/)
  assert.match(dy, /const out = useUi/)
})

await ok('B站 postReply：能带 pictures 发图', () => {
  assert.match(bw, /pictures: pics/)
  assert.match(bw, /uploadImage\(image\)/)
  assert.match(bw, /bilibili\?\.replies\?\.image/)
})

await ok('B站 replies：⓪①② 三条路都过了一遍 styleReply', () => {
  const hits = rep.match(/styleReply\(/g) || []
  assert.ok(hits.length >= 3, `只接线了 ${hits.length} 处，应该 ≥3（自己作品/被动回复/主动搭话）`)
})

await ok('抖音私信：支持 --file，且认准确认框的「发送」按钮', () => {
  assert.match(dy, /'--file'/)
  assert.match(py, /MsgInputSendFileModal/)
  assert.match(py, /file_path: str = ""/)
})

await ok('抖音语音条命令在（网页版评论区没有录音控件，只能走 mp4）', () => {
  assert.match(dy, /cmd === 'voice-note'/)
  assert.match(dy, /voiceNoteArgs/)
})

await ok('抖音 comment-delete 在（发错能自己删掉）', () => {
  assert.match(py, /async def cmd_comment_delete/)
  assert.match(py, /"comment-delete"/)
  assert.match(py, /删除评论/)
})

await ok('发送防呆：框里没东西就不发（防止空评论 + 谎报已发送）', () => {
  assert.match(py, /框里什么都没有/)
  assert.match(py, /emoji_text/)
})

console.log(`\n任意类型评论测试：${n}/${n} 通过`)