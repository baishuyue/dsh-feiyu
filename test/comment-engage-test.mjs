// 评论区"任何类型都能回"（10-27 主人报的 bug）——
//   抖音那边她只回了主人的文字评论，别人发的表情包一条没回；
//   B站 那边压根没有"回自己作品评论区"这条路。
//
// 根因（抖音）：纯表情包/图片评论的 text 是空串，上层 `if (!c.text) continue` 把整条丢了。
// 这条测试盯死三件事：
//   ① classifyComment 把 文字/只有表情/表情包/图片/空 分清楚，除"空"以外都能回；
//   ② 抖音 engage 不许再按"有没有文字"筛评论，且表情包要用昵称定位（--user）；
//   ③ B站 有"自己作品评论区"路径（listOwnVideos + listCommentsOf + replies ⓪）。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { classifyComment, replyable, stickerFallback, plainText } from '../tools/lib/comment-kind.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => fs.readFileSync(path.isAbsolute(p) ? p : path.join(ROOT, p), 'utf8')
let n = 0
const ok = async (name, fn) => { await fn(); n++; console.log(`  ✓ ${name}`) }

await ok('文字评论：原样交给 LLM', () => {
  const k = classifyComment({ text: '这个饭看起来真好吃' })
  assert.equal(k.kind, 'text')
  assert.equal(k.label, '这个饭看起来真好吃')
  assert.ok(replyable(k.kind))
})

await ok('只有 [大笑] 这种表情占位：算评论，不是空', () => {
  const k = classifyComment({ text: '[大笑]' })
  assert.equal(k.kind, 'emote')
  assert.equal(k.label, '[大笑]')
  assert.ok(replyable(k.kind), '只有表情的评论也必须能回')
})

await ok('抖音表情包（text 为空、有 sticker）：认得出来', () => {
  const k = classifyComment({ text: '', sticker: 'doge' })
  assert.equal(k.kind, 'sticker')
  assert.match(k.label, /表情包/)
  assert.ok(replyable(k.kind))
})

await ok('表情包名字是 URL 时不要把链接念出来', () => {
  const k = classifyComment({ text: '', sticker: 'https://p3.douyinpic.com/obj/x.webp' })
  assert.equal(k.kind, 'sticker')
  assert.ok(!/https?:/.test(k.label), `label 里带链接了：${k.label}`)
})

await ok('B站 图片评论（只有 pictures）：算评论', () => {
  const k = classifyComment({ text: '', pictures: [{ img_src: 'a' }, { img_src: 'b' }] })
  assert.equal(k.kind, 'image')
  assert.match(k.label, /2 张图/)
  assert.ok(replyable(k.kind))
})

await ok('真空评论（连表情都没有）：不建议硬凑', () => {
  const k = classifyComment({ text: '  ' })
  assert.equal(k.kind, 'empty')
  assert.equal(replyable(k.kind), false)
})

await ok('文字里夹表情：仍算文字', () => {
  const k = classifyComment({ text: '[微笑]今天下雨了[大哭]' })
  assert.equal(k.kind, 'text')
  assert.equal(k.plain, '今天下雨了')
})

await ok('兜底话术按类型分池，且会轮换（不老是同一句）', () => {
  const a = stickerFallback('（发了张表情包：doge）', 0)
  const b = stickerFallback('（发了张表情包：doge）', 1)
  assert.notEqual(a, b, '两次兜底不该一模一样')
  assert.match(stickerFallback('（发了 2 张图，没有文字）', 0), /图/)
})

await ok('plainText 把占位/零宽/空白都剥掉', () => {
  assert.equal(plainText('[大笑] 你好\u200b 呀'), '你好呀')
})

await ok('抖音 engage 不再按"有没有文字"筛评论，并把类型带下去', () => {
  // 注释里会引用旧代码（`if (!c.text) continue`），所以先把注释行剔掉再查
  const s = read('tools/commands/douyin.mjs').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  assert.ok(!/if \(!c\.text\) continue/.test(s), '还有 if (!c.text) continue —— 表情包评论又会被丢掉')
  assert.match(s, /classifyComment/)
  assert.match(s, /replyable\(/)
  // 表情包没有文本可 match → 必须能用昵称定位
  assert.match(s, /--user['"], String\(n\.user/)
  assert.match(s, /stickerFallback/)
})

await ok('抖音 comment-reply 支持按昵称/序号定位（纯表情包评论没有文本）', () => {
  const py = read('D:/social-auto-upload/douyin_interact.py')
  assert.match(py, /--user/, 'python 少了 --user')
  assert.match(py, /--index/, 'python 少了 --index')
  assert.match(py, /def _nick_of/, '缺按昵称认人的实现')
  // 评论数据必须带 kind/label，否则上层不知道这是表情包
  assert.match(py, /"kind": kind/)
  assert.match(py, /def _shape/)
})

await ok('B站 有"自己作品评论区"的读接口，且不筛空文本', () => {
  const s = read('tools/lib/bili-write.mjs')
  assert.match(s, /export async function listOwnVideos/)
  assert.match(s, /export async function listCommentsOf/)
  assert.match(s, /classifyComment/)
  assert.ok(!/if \(!String\(c\.message/.test(s), '别在底层筛空评论')
  // 楼中楼也要收（不然答过一轮对方再说话就看不见）
  assert.match(s, /for \(const sub of r\.replies \|\| \[\]\)/)
})

await ok('B站 replies 有 ⓪ 自己作品评论区这一档，且表情/图片评论有兜底', () => {
  const s = read('tools/commands/replies.mjs')
  assert.match(s, /async function ownWorks/)
  assert.match(s, /ownOnly/)
  assert.match(s, /stickerFallback/)
  assert.match(s, /listOwnVideos\(/)
  assert.match(s, /listCommentsOf\(/)
})

await ok('B站 投稿列表有归属校验（别人的 BV 不许回）+ space 接口默认关', () => {
  const s = read('tools/lib/bili-write.mjs')
  assert.match(s, /不属于自己的 BV/, '缺归属校验提示')
  assert.match(s, /info\.ownerMid/, '没有比对 ownerMid')
  // space 接口一碰就 412 且会熔断整条通道 → 默认不调，要开得显式配置
  assert.match(s, /cfg\.useSpaceList === true/)
  // 回评必须能直传 aid，别为查 aid 去撞 /x/web-interface/view
  assert.match(s, /aid = 0, title = ''/, 'postReply 没有 aid 直传口')
})

await ok('首条发布后把 bvid 落进投稿包（replies 靠它认投稿，不啃 space 接口）', () => {
  const s = read('tools/commands/produce.mjs')
  assert.match(s, /bvid\.txt/)
})

console.log(`\n评论区测试：${n}/${n} 通过`)