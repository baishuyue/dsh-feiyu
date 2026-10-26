// 参考文本对齐 + GBK 清洗 回归测试（10-26）
//
// 主人报：「说话包括做视频都重复出现了几句话：说好等手伤痊愈了就一起打游戏」
//
// 真因（实测证据）：
//   · ref_audio_path 指向 yinlang（真实内容「战斗体验该优化了，哼就这速度太慢了。」7.9 秒）
//   · 但 voice.prompt_text 还留着旧音色（银狼）的「在无视规则这一点上，卡夫卡和我很有共鸣，
//     说好等手伤痊愈了就一起打游戏。」—— 参考文本和参考音频不是同一段话
//   · GPT-SoVITS 拿错文本对齐，每次合成都会把参考文本念出来
//   · A/B 实测（同一句 42 字）：错文本 30.66 秒 / 正文本 8.62 秒，多出来的 22 秒就是泄漏
//     → 语音条和视频旁白都变成了"那句不相干的话 + 勉强说的话"，听起来像记忆错乱
//
// 修法：① 配置改成真实转写；② synth() 以模型目录的 .txt 为准（配置是人手填的，换音色容易忘），
//       显式 override 仍然优先（音色工坊/唱歌逐句覆盖要用）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const REPO = path.dirname(new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const { refTextOf, sanitizeForTts } = await import(pathToFileURL(path.join(REPO, 'tools', 'lib', 'tts.mjs')).href)

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`) }
}

// 造一个假音色目录：wav + 同名 .txt（= 真实转写）
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-ref-'))
const modelDir = path.join(tmp, 'yinlang')
fs.mkdirSync(modelDir)
const wav = path.join(modelDir, 'yinlang.wav')
fs.writeFileSync(wav, Buffer.alloc(2048))
fs.writeFileSync(path.join(modelDir, 'yinlang.txt'), '战斗体验该优化了，哼就这速度太慢了。')

// ① 能读到同名 .txt
ok('refTextOf 读到同名转写', refTextOf(wav) === '战斗体验该优化了，哼就这速度太慢了。', refTextOf(wav))
ok('转写里不该出现旧音色那句', !refTextOf(wav).includes('手伤'))

// ② 没有同名文件时退一步读目录里任意 .txt
const dir2 = path.join(tmp, 'rose')
fs.mkdirSync(dir2)
const wav2 = path.join(dir2, 'voice.wav')
fs.writeFileSync(wav2, Buffer.alloc(2048))
fs.writeFileSync(path.join(dir2, 'ref.txt'), 'Everything I need is on the ground though.')
ok('没有同名 .txt 时用目录里的', refTextOf(wav2).startsWith('Everything'), refTextOf(wav2))

// ③ 找不到转写 / 路径不存在 → 空串（交给配置）
ok('目录没有 txt → 空串', refTextOf(path.join(tmp, 'nope', 'a.wav')) === '')
ok('空路径 → 空串', refTextOf('') === '')

// ④ 源码守卫：synth 必须以转写覆盖配置，且显式 override 优先
const tts = fs.readFileSync(path.join(REPO, 'tools', 'lib', 'tts.mjs'), 'utf8')
ok('synth 会核对转写', tts.includes('refTextOf(refAudio)') && tts.includes('prompt = truth'))
ok('参考文本不符会报一声', tts.includes('参考文本与'))
ok('显式 override 仍然优先', tts.includes('override.prompt_text === undefined'))
ok('配置里的旧值会被盖掉', tts.includes('if (override.prompt_text === undefined && prompt) body.prompt_text = prompt'))

// ⑤ 顺带守住 GBK 清洗（语音 400 那个坑）
ok('颜文字仍被洗掉', !sanitizeForTts('好 (・_・;)').includes('・'))

// ⑥ 现场配置必须已经对齐（防止有人手改回去）
const cfgPath = path.join(process.env.USERPROFILE || os.homedir(), '.dsh', 'feiyu.config.json')
if (fs.existsSync(cfgPath)) {
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
  const truth = refTextOf(cfg.voice?.ref_audio_path || '')
  const conf = String(cfg.voice?.prompt_text || '').trim()
  ok('现场配置的参考文本与音频一致', !truth || truth === conf, `配置「${conf.slice(0, 20)}」实际「${truth.slice(0, 20)}」`)
} else {
  console.log('  · 没有现场配置，跳过')
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log(fail ? `\n✗ ${fail} 条没过（通过 ${pass}）` : `\n✓ 全部 ${pass} 条通过`)
process.exit(fail ? 1 : 0)