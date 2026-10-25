// imggen 离线测试 —— 不出网：prompt 兜底 / 图片魔数校验 / 额度账本 / 标签图上限清理。
// 真正的出网生成用实机命令验：node feiyu.mjs sticker gen "本鱼饿了" --tag 生气
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert'
import { buildImagePrompt, isImageFile, genQuotaOk, genQuotaRecord, capTagFiles } from '../tools/lib/imggen.mjs'

const STYLE = 'cute chibi anime whale-girl mascot'
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'imggen-test-'))
try {
  // ① buildImagePrompt：没 LLM → 模板兜底；LLM 正常 → STYLE + 翻译；LLM 抛错 → 兜底
  const p1 = await buildImagePrompt('本鱼饿了', null)
  assert.ok(p1.startsWith(STYLE) && p1.includes('本鱼饿了'), '模板兜底应含固定画风+原文案')
  const p2 = await buildImagePrompt('太搞笑了', async () => '  laughing hard with tears, rolling on the floor  ')
  assert.ok(p2.startsWith(STYLE) && p2.includes('laughing hard'), 'LLM 翻译应拼接在固定画风后')
  const p3 = await buildImagePrompt('生气鼓成球', async () => { throw new Error('网络挂了') })
  assert.ok(p3.startsWith(STYLE) && p3.includes('生气鼓成球'), 'LLM 挂了应退模板，不抛出')
  console.log('imggen ✓ prompt 三条路（模板/翻译/兜底）')

  // ② isImageFile：JPEG/PNG 魔数过，HTML 拦截页/空文件/不存在拒（文件都要 >2KB，过大小下限）
  const pad = Buffer.alloc(2600, 0)
  const jpg = path.join(tmp, 'a.jpg'), png = path.join(tmp, 'b.png'), html = path.join(tmp, 'c.jpg')
  Buffer.from([0xff, 0xd8, 0xff, 0xe1]).copy(pad)
  fs.writeFileSync(jpg, pad)
  Buffer.from([0x89, 0x50, 0x4e, 0x47]).copy(pad)
  fs.writeFileSync(png, pad)
  fs.writeFileSync(html, Buffer.from('<html>412 Forbidden</html>'))
  assert.ok(isImageFile(jpg) && isImageFile(png), '真图应通过魔数校验')
  assert.ok(!isImageFile(html) && !isImageFile(path.join(tmp, 'nope.jpg')), 'HTML/不存在应被拒')
  console.log('imggen ✓ 魔数校验（拦 HTML 假图）')

  // ③ 额度账本：0=不限；记账累加；跨天清零靠 dayKey（不模拟时钟，只验逻辑通路）
  const q = path.join(tmp, 'imggen.json')
  assert.ok(genQuotaOk(2, q), '空账本应放行')
  genQuotaRecord(q); genQuotaRecord(q)
  assert.ok(!genQuotaOk(2, q), '记满 2 张后额度 2 应拦下')
  assert.ok(genQuotaOk(0, q), '0 = 不限应放行')
  console.log('imggen ✓ 日额度账本（0=不限）')

  // ④ 标签图上限：ai-* 只留最新 N 张，非 ai- 的内置图不动
  const tagDir = path.join(tmp, '生气')
  fs.mkdirSync(tagDir, { recursive: true })
  fs.writeFileSync(path.join(tagDir, 'keep.png'), 'builtin')
  for (let i = 0; i < 15; i++) {
    const f = path.join(tagDir, `ai-${String(i).padStart(2, '0')}.jpg`)
    fs.writeFileSync(f, 'x')
    fs.utimesSync(f, new Date(Date.now() + i * 1000), new Date(Date.now() + i * 1000))
  }
  capTagFiles('生气', 12, tmp)
  const left = fs.readdirSync(tagDir).sort()
  assert.strictEqual(left.filter(f => f.startsWith('ai-')).length, 12, 'ai- 图应裁到 12 张')
  assert.ok(left.includes('keep.png'), '内置图不许动')
  assert.ok(left.includes('ai-14.jpg') && !left.includes('ai-00.jpg'), '应保留最新的、删最老的')
  console.log('imggen ✓ 标签图上限清理（只删自己生成的）')

  console.log('imggen ✓ 全部通过')
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}
