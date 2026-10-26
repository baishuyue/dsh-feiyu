// 空壳页判定测试（10-26）
//
// 背景：她说自己在"上网学习"，但今天把同一个知乎落地页读了 11 次 ——
// fetchWeb 抓到的是站点模板（"知乎，让每一次点击都充满意义 —— 欢迎来到知乎…"），
// 正文一个字都没有。她以为"读完了没记住"，下一轮又去读同一页，
// 记忆里于是堆了 11 条一模一样的"读了…"。空壳页必须当场识别，让她换链接。
import { shellPageReason } from '../tools/commands/web.mjs'

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`) }
}

// ① 真·空壳页（今天实际抓到的那段）
const zhihu = '知乎，让每一次点击都充满意义 —— 欢迎来到知乎，发现问题背后的世界。登录知乎 登录后你可以提问、回答、写文章。'
ok('知乎模板页被识别', !!shellPageReason(zhihu), shellPageReason(zhihu))
ok('原因里点明"站点模板"', shellPageReason(zhihu).includes('站点模板'), shellPageReason(zhihu))

// ② 登录墙/JS 墙/404
ok('请开启JavaScript 被识别', !!shellPageReason('请开启JavaScript 后再访问本页面'))
ok('登录墙被识别', !!shellPageReason('扫码登录 登录后你可以查看更多内容'))
ok('内容已删除被识别', !!shellPageReason('该内容已被删除'))
ok('404 被识别', !!shellPageReason('404 Not Found'))

// ③ 正常文章不能误杀
const article = '大肥鱼是一种深海生物。'.repeat(40) + '今天讲的是鸭血粉丝汤的做法：先吊汤，再把鸭血切片下锅，最后撒一把香菜。'
ok('正常长文不报错', shellPageReason(article) === '', shellPageReason(article))
// 含模板词但正文很长的页面（比如知乎专栏正文页）也要放行
ok('知乎正文页（带正文）放行', shellPageReason('登录知乎' + '正文'.repeat(600)) === '', shellPageReason('登录知乎' + '正文'.repeat(600)))

// ④ 边界
ok('空串 → 报正文太少', !!shellPageReason(''))
ok('null → 不崩', typeof shellPageReason(null) === 'string')
ok('纯空白 → 报正文太少', !!shellPageReason('   \n\t '))

console.log(fail ? `\n✗ ${fail} 条没过（通过 ${pass}）` : `\n✓ 全部 ${pass} 条通过`)
process.exit(fail ? 1 : 0)