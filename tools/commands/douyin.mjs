// douyin —— 抖音发布（social-auto-upload，简称 sau）。
// 个人号没有官方 API，sau 用 Playwright + cookie 半自动发布。
//
//   node feiyu.mjs douyin login                    # 扫码登录一次（cookie 存本地）
//   node feiyu.mjs douyin publish --file out/final.mp4 --title "…" --desc "…#大肥鱼"
//   node feiyu.mjs douyin images --dir out/imgs --desc "…"      # 图文
//   node feiyu.mjs douyin check                   # 检查登录态
//
// 评论互动：个人号要 Playwright 自动化（风控高），暂留接口位，见 README v0.3。
import { execFileSync } from 'node:child_process'
import { config } from '../lib/config.mjs'

function arg(argv, name) {
  const i = argv.indexOf(name)
  return i >= 0 ? String(argv[i + 1] ?? '') : ''
}

function sau(argv, cfg) {
  const bin = cfg.douyin?.sau_cmd || 'sau'
  try {
    return execFileSync(bin, argv, { encoding: 'utf8', timeout: 300000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    console.error(`✗ sau 执行失败：${String(e.stderr ?? e.message).slice(0, 400)}`)
    process.exit(1)
  }
}

export function run(argv = []) {
  const cmd = argv[0] || 'help'
  const cfg = config()
  const account = cfg.douyin?.account || 'creator'

  if (cmd === 'login') {
    console.log(sau(['douyin', 'login', '--account', account], cfg))
    return
  }
  if (cmd === 'check') {
    // sau 的登录态检查不同版本命令可能不同；先跑 login 看报错即可判断
    try {
      console.log(sau(['douyin', 'check', '--account', account], cfg))
    } catch { console.log('（check 命令可能不被当前 sau 版本支持，改用 login 验证）') }
    return
  }
  if (cmd === 'publish') {
    const file = arg(argv, '--file')
    const title = arg(argv, '--title') || ''
    const desc = arg(argv, '--desc') || ''
    if (!file) { console.error('用法：node feiyu.mjs douyin publish --file <视频> --title "…" --desc "…"'); process.exit(2) }
    if (cfg.guard?.dryRun) {
      console.log(`【干跑 ✓】不发布：${file}\n  标题：${title}\n  描述：${desc}`)
      return
    }
    const args = ['douyin', 'upload-video', '--account', account, '--file', file]
    if (title) args.push('--title', title)
    if (desc) args.push('--desc', desc)
    console.log(sau(args, cfg))
    console.log('✓ 已提交发布（频繁发布 >3 条/天易限流，建议 1~2 条/天 + 固定时段）')
    return
  }
  if (cmd === 'note' || cmd === 'images') {
    // sau 图文：upload-note --images 图1 图2 --title --note
    const images = []
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === '--image') images.push(argv[i + 1])
    }
    const title = arg(argv, '--title') || ''
    const note = arg(argv, '--note') || arg(argv, '--desc') || ''
    if (!images.length) { console.error('用法：node feiyu.mjs douyin note --image 图1.png --image 图2.png --title "…" --note "…"'); process.exit(2) }
    if (cfg.guard?.dryRun) { console.log(`【干跑 ✓】不发布图文：${images.length} 张\n  标题：${title}\n  正文：${note}`); return }
    console.log(sau(['douyin', 'upload-note', '--account', account, '--images', ...images, '--title', title, '--note', note], cfg))
    return
  }
  if (cmd === 'comments') {
    console.error('评论互动暂未实现：个人号要 Playwright 自动化（风控高）。')
    console.error('可选：企业号开放平台「评论管理」能力（需企业资质），或等 v0.3 做 Playwright 方案。')
    process.exit(1)
  }
  console.log('用法：login | publish --file --title --desc | images --dir --desc | check | comments')
}
