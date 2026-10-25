// vision —— 视觉理解探针：拿一张/几张图问多模态模型（provider 配齐才启用）。
// 用户填好 vision 配置后，先用这里验通再开 watch 采样。
//
//   node feiyu.mjs vision --image <图片路径> [--query "图里有什么"]
import path from 'node:path'
import { visionOn, visionCfg, describeFrames } from '../lib/vision.mjs'

function arg(argv, name, d) { const i = argv.indexOf(name); return i >= 0 ? String(argv[i + 1] ?? d) : d }

export async function run(argv = []) {
  const sub = argv[0] || 'status'

  if (sub === 'status') {
    const v = visionCfg()
    console.log(`视觉理解：provider=${v.provider} · model=${v.model || '(未填)'} · base_url=${v.base_url || '(未填)'} · key=${v.api_key ? '已填' : '(未填)'}`)
    console.log(visionOn()
      ? '✓ 已点亮：watch 自主观看会自动截帧描述（vision.maxFrames 帧内）'
      : '✗ 未启用：四样（provider/base_url/model/api_key）配齐才开 —— 没配时 watch 静默跳过，不影响老流程')
    return
  }

  if (sub === 'probe') {
    const img = arg(argv, '--image')
    if (!img) { console.log('用法：vision probe --image <图片路径> [--query "问题"]'); process.exit(2) }
    if (!visionOn()) {
      console.error('✗ 视觉未启用：先在 feiyu.config.json 配 vision.provider/base_url/model/api_key（见 config.mjs DEFAULTS 注释）')
      process.exit(1)
    }
    console.log('👁 描述中…')
    const desc = await describeFrames([path.resolve(img)], { query: arg(argv, '--query') })
    if (!desc) { console.error('✗ 描述失败（key/网络/模型名，vision probe status 看配置）'); process.exit(1) }
    console.log(desc)
    return
  }

  console.log('用法：vision status | vision probe --image <图片路径> [--query "问题"]')
}

if (process.argv[1] && process.argv[1].endsWith('vision.mjs')) {
  await run(process.argv.slice(2))
}
