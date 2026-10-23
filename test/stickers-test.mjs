/**
 * 表情包 / 颜文字约定的测试。
 * 跑法：node test/stickers-test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import {
  splitSticker, toPlain, sanitizeFor, pickSticker, availableTags, stickerPrompt,
  ensureSelfSticker, DEFAULT_TAGS, BILI_FACES, STICKER_DIR,
} from '../tools/lib/stickers.mjs'

// 1) 摘表情标记（图库标签 / 自制文案 / 没有）
assert.deepEqual(splitSticker('好呀(๑•̀ㅂ•́)و✧ [表情:开心]'),
  { text: '好呀(๑•̀ㅂ•́)و✧', tag: '开心', caption: null })
assert.deepEqual(splitSticker('[表情:困]'), { text: '', tag: '困', caption: null })
assert.deepEqual(splitSticker('没表情'), { text: '没表情', tag: null, caption: null })
assert.deepEqual(splitSticker('嗯【表情：无语】'), { text: '嗯', tag: '无语', caption: null })
assert.equal(splitSticker('[表情:开心][表情:生气]').tag, '开心')
// 自制：允许空格/标点
assert.deepEqual(splitSticker('我先睡了 [自制表情:困死了 网络还没好]'),
  { text: '我先睡了', tag: null, caption: '困死了 网络还没好' })

// 2) 评论区剥离
assert.equal(toPlain('真的笑死 [表情:开心]'), '真的笑死')

// 3) 分平台清洗
const bili = sanitizeFor('bilibili', '笑不活了 [大笑] [歪嘴] 真的')
assert.ok(bili.includes('[大笑]'), 'B站白名单表情码应该保留：' + bili)
assert.ok(!bili.includes('[歪嘴]'), '白名单外的表情码应该剥掉：' + bili)
assert.ok(!bili.includes('[表情:'), '图片表情标记必须剥掉')
const dy = sanitizeFor('douyin', '笑死 [大笑] [doge] 😂')
assert.ok(!dy.includes('['), '抖音不认方括号表情码：' + dy)
assert.ok(dy.includes('😂'), '抖音保留 unicode emoji：' + dy)
assert.equal(sanitizeFor('qq', '好 [表情:开心]'), '好')

// 4) 图库扫描
const tags = availableTags()
assert.ok(Array.isArray(tags) && tags.length > 0)
if (!fs.existsSync(STICKER_DIR)) assert.deepEqual(tags, DEFAULT_TAGS)
assert.equal(pickSticker('不存在的标签'), null)

// 5) prompt 分平台
const qqPrompt = stickerPrompt('qq')
assert.ok(qqPrompt.includes('[表情:'), 'QQ 的 prompt 应该教她写表情标记')
assert.ok(qqPrompt.includes('[自制表情:'), 'QQ 的 prompt 应该告诉她可以自制')
assert.ok(qqPrompt.includes('颜文字'))
const biliPrompt = stickerPrompt('bilibili')
assert.ok(!biliPrompt.includes('[表情:标签]'), '评论区不该教她发图片表情')
assert.ok(biliPrompt.includes('[' + BILI_FACES[0] + ']'), 'B站 prompt 应给出表情码白名单')
const dyPrompt = stickerPrompt('douyin')
assert.ok(dyPrompt.includes('emoji'), '抖音 prompt 应说明只认 emoji')

// 6) 自制表情：没配置 python 时优雅返回 null（不抛错）
assert.equal(ensureSelfSticker('困死了', null), null)
assert.equal(ensureSelfSticker('', {}), null)

console.log('stickers ✓  标记解析/自制标记/评论剥离/分平台清洗/prompt/空图库兜底 全部通过')
console.log('  图库标签：', tags.join('/'), '· B站表情码：', BILI_FACES.slice(0, 4).join(' '))
