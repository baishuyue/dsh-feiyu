/**
 * 表情包 / 颜文字约定的测试。
 * 跑法：node test/stickers-test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { splitSticker, toPlain, pickSticker, availableTags, stickerPrompt, DEFAULT_TAGS, STICKER_DIR } from '../tools/lib/stickers.mjs'

// 1) 摘表情标记
assert.deepEqual(splitSticker('好呀(๑•̀ㅂ•́)و✧ [表情:开心]'), { text: '好呀(๑•̀ㅂ•́)و✧', tag: '开心' })
assert.deepEqual(splitSticker('[表情:困]'), { text: '', tag: '困' })
assert.deepEqual(splitSticker('没表情'), { text: '没表情', tag: null })
// 全角括号、中文冒号也要认
assert.deepEqual(splitSticker('嗯【表情：无语】'), { text: '嗯', tag: '无语' })
// 只认第一个，多的丢掉
assert.equal(splitSticker('[表情:开心][表情:生气]').tag, '开心')

// 2) 评论区只留文字
assert.equal(toPlain('真的笑死 [表情:开心]'), '真的笑死')
assert.equal(toPlain('没有标记'), '没有标记')

// 3) 图库扫描（本机目录可能为空 → 返回 null 而不是抛错）
const tags = availableTags()
assert.ok(Array.isArray(tags) && tags.length > 0)
if (!fs.existsSync(STICKER_DIR)) assert.deepEqual(tags, DEFAULT_TAGS)
assert.equal(pickSticker('不存在的标签'), null)

// 4) prompt 分平台：QQ 可写标记，评论区不行
const qqPrompt = stickerPrompt('qq')
assert.ok(qqPrompt.includes('[表情:'), 'QQ 的 prompt 应该教她写表情标记')
assert.ok(qqPrompt.includes('颜文字'))
const biliPrompt = stickerPrompt('bilibili')
assert.ok(!biliPrompt.includes('[表情:标签]'), '评论区不该教她发表情标记')
assert.ok(biliPrompt.includes('不要写'), '评论区要明确禁止写标记')

console.log('stickers ✓  标记解析/评论剥离/prompt 分平台/空图库兜底 全部通过')
console.log('  当前可用标签：', tags.join('/'), '· 目录：', path.relative(process.cwd(), STICKER_DIR) || STICKER_DIR)
