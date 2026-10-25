// vision 离线测试 —— 不出网：默认未启用不挡路 / dataUri 格式 / describeFrames 关闭时返回 null。
// 实机点亮验证：填好 vision 配置后 node feiyu.mjs vision probe --image <图>
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert'
import { visionOn, visionCfg, dataUri, describeFrames } from '../tools/lib/vision.mjs'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-test-'))
try {
  // ① 视觉启用状态与配置一致（用户 10-25 点亮后此断言走"已配置"分支）
  const v = visionCfg()
  assert.strictEqual(typeof visionOn(), 'boolean', 'visionOn 应返回布尔')
  if (!visionOn()) {
    assert.strictEqual(await describeFrames([]), null, '未启用时 describeFrames 应返回 null，不上抛')
    console.log('vision ✓ 默认未启用（静默跳过不挡路）')
  } else {
    assert.ok(v.base_url && v.model && v.api_key, '已启用则四样必齐')
    console.log('vision ✓ 已配置点亮（跳过离线空转断言）')
  }

  // ② dataUri：JPEG/PNG 前缀正确、base64 可解
  const jpg = path.join(tmp, 'a.jpg')
  fs.writeFileSync(jpg, Buffer.from([0xff, 0xd8, 0xff, 0xe1, 1, 2, 3]))
  const uri = dataUri(jpg)
  assert.ok(uri.startsWith('data:image/jpeg;base64,'), 'JPEG 应带 jpeg MIME 前缀')
  const raw = Buffer.from(uri.split(',')[1], 'base64')
  assert.deepStrictEqual([...raw.subarray(0, 4)], [0xff, 0xd8, 0xff, 0xe1], 'base64 解回应等于原字节')
  console.log('vision ✓ dataUri 编码往返一致')

  console.log('vision ✓ 全部通过')
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}
