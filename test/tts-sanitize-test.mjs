// 语音 400 回归测试（10-26）
//
// 现象：qq-server 日志里每一句「语音失败，降级文字：GPT-SoVITS HTTP 400」——
//       她的回复几乎每条都带颜文字/emoji，于是语音**从来没成功过**。
// 真因（实测抓到的原始异常）：
//   {"message":"tts failed","Exception":"'gbk' codec can't encode character '\\u30fb' in position 47"}
//   {"message":"tts failed","Exception":"'gbk' codec can't encode character '\\U0001f41f' in position 32"}
//   Windows 上的 api_v2.py 用 GBK 编码 → 「・」(U+30FB) 和 🐟(U+1F41F) 塞不进去就整条 400。
//   同一份配置、纯中文 → 200 OK。所以修在客户端：合成前把 GBK 装不下的字符洗掉。
import { sanitizeForTts } from '../tools/lib/tts.mjs'

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`) }
}

const KAOMOJI = '主人，你说人看见好看的东西就挪不开眼，是不是跟饿的时候看见吃的差不多？我这算饿急了乱想吧 (・_・;)'
const EMOJI = '主人，都五点半了，我肚子一直在叫……你是不是又打王者忘了吃饭啊 🐟'

// ① 元凶字符必须洗掉
const k = sanitizeForTts(KAOMOJI)
ok('洗掉颜文字里的 ・(U+30FB)', !k.includes('\u30FB'), k)
ok('颜文字括号残骸整段丢掉', !k.includes('(_;)') && !k.includes('(_'), k)
ok('正文一个字不少', k.startsWith('主人，你说人看见好看的东西'), k)
ok('洗掉 emoji 🐟', !sanitizeForTts(EMOJI).includes('🐟'))
ok('emoji 版正文完整', sanitizeForTts(EMOJI).endsWith('忘了吃饭啊'), sanitizeForTts(EMOJI))

// ② 该留的必须留
ok('中文标点保留', sanitizeForTts('嗯，好……。（不想动）') === '嗯，好……。（不想动）')
ok('有字的括号不误删', sanitizeForTts('看完了（蓝鲸那段）') === '看完了（蓝鲸那段）')
ok('英文数字保留', sanitizeForTts('BV1xrnz6gEVD 不错 2026') === 'BV1xrnz6gEVD 不错 2026')

// ③ 边界
ok('全是符号 → 空串（调用方降级文字）', sanitizeForTts('(・_・;) 🐟 【】') === '')
ok('null 不炸', sanitizeForTts(null) === '')
ok('空串不炸', sanitizeForTts('') === '')

// ④ 幂等（洗过的不该再变）
const once = sanitizeForTts(KAOMOJI)
ok('幂等', sanitizeForTts(once) === once, JSON.stringify(sanitizeForTts(once)))

console.log(fail ? `\n✗ ${fail} 条没过（通过 ${pass}）` : `\n✓ 全部 ${pass} 条通过`)
process.exit(fail ? 1 : 0)