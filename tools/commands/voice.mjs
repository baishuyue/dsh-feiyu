// voice —— 音色工坊：list / try / tryall / use / import
// "她自己学新声音"的入口：从 URL 导入任意参考音频即得新音色（GPT-SoVITS v4 零样本），
// 逐个试听发到主人 QQ，主人或鱼自己拍板切换。
//
//   node feiyu.mjs voice list
//   node feiyu.mjs voice try --name <音色名>            # 用该音色合成自我介绍发主人QQ
//   node feiyu.mjs voice tryall                          # 全部音色逐个试听
//   node feiyu.mjs voice use --name <音色名>             # 切换默认音色（写配置）
//   node feiyu.mjs voice import --url <wav直链> --name <名字> --text <参考文本>
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { config } from '../lib/config.mjs'
import { synth } from '../lib/tts.mjs'
import { dataPath, configPath } from '../lib/paths.mjs'

const MODELS_DIR = 'D:/GPT-SoVITS/models'
const INTRO = '主人，这是我现在的声音，好听吗？我是大肥鱼，这条声音你觉得适合我就换上吧。'

function arg(argv, name, d) { const i = argv.indexOf(name); return i >= 0 ? String(argv[i + 1] ?? d) : d }

function listVoices() {
  const out = []
  try {
    for (const name of fs.readdirSync(MODELS_DIR)) {
      const dir = path.join(MODELS_DIR, name)
      try {
        if (!fs.statSync(dir).isDirectory()) continue
        const files = fs.readdirSync(dir)
        const wav = files.find(f => f.toLowerCase().endsWith('.wav'))
        const txt = files.find(f => f.toLowerCase().endsWith('.txt'))
        if (wav) out.push({ name, wav: path.join(dir, wav).replace(/\\/g, '/'), text: txt ? fs.readFileSync(path.join(dir, txt), 'utf8').trim() : '' })
      } catch {}
    }
  } catch {}
  return out
}

async function sendQQ(file) {
  const cfg = config()
  const ownerQQ = String(cfg.owner?.qq || '')
  const napcat = String(cfg.qq?.napcat_http || 'http://127.0.0.1:3000').replace(/\/+$/, '')
  if (!ownerQQ) throw new Error('owner.qq 未配置')
  const r = await fetch(`${napcat}/send_private_msg`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: Number(ownerQQ), message: [{ type: 'record', data: { file } }] }),
    signal: AbortSignal.timeout(15000),
  })
  return r.ok
}

export async function run(argv = []) {
  const sub = argv[0] || 'list'
  const voices = listVoices()

  if (sub === 'models') {
    const rvc = await import('../lib/rvc.mjs')
    const { current, models } = rvc.listVoiceModels()
    const names = Object.keys(models)
    console.log(`RVC 音色模型（她自己的声音，唱歌/换声用）共 ${names.length} 个：`)
    for (const n of names) console.log(`  ${n}${n === current ? ' ←当前' : ''} · ${models[n].pth.split(/[\\/]/).pop()}`)
    if (!names.length) console.log('  （还没有 —— voice train 训一个，10 分钟语音约 30-60 分钟）')
    return
  }

  if (sub === 'train') {
    const rvc = await import('../lib/rvc.mjs')
    const name = arg(argv, '--name', 'feiyu-sunshine')
    const epochs = Number(arg(argv, '--epochs', 150)) || 150
    const batch = Number(arg(argv, '--batch', 8)) || 8
    const saveEvery = Number(arg(argv, '--se', 50)) || 50
    if (!rvc.rvcReady()) {
      console.error('✗ RVC 环境不齐：D:/rvc/venv 要有 torch+依赖，D:/rvc/RVC/assets 要有 48k 底模（见 rvc.mjs 头注释）')
      process.exit(1)
    }
    console.log(`🎤 数据集准备…`)
    const cfg = config()
    const dsDir = arg(argv, '--dataset')
    let ds
    if (dsDir) {
      // 现成数据集直训（真歌声干声目录——音色进化/明星音色的正路，不走 TTS 合成）
      ds = { dir: dsDir, count: fs.readdirSync(dsDir).filter((f) => f.endsWith('.wav')).length, approxMinutes: 0 }
      console.log(`使用现成数据集：${ds.dir}（${ds.count} 个 wav）`)
    } else {
      ds = await rvc.genDataset({
        name,
        refAudio: arg(argv, '--ref') || cfg.voice?.ref_audio_path || '',
        promptText: arg(argv, '--prompt') || cfg.voice?.prompt_text || '',
        log: (l) => console.log(l),
      })
    }
    console.log(`✓ 数据集就绪：${ds.count} 句 / 约 ${ds.approxMinutes || '?'} 分钟 —— ${ds.dir}`)
    console.log(`🏋️ 开始训练 ${epochs} 轮（bs=${batch}，全程日志 ~/.feiyu-ai/rvc/train-${name}.log，挂后台别关机）…`)
    const t0 = Date.now()
    const out = await rvc.trainVoice({ name, datasetDir: ds.dir, epochs, batch, saveEvery, log: (l) => console.log('  ' + String(l).slice(0, 110)) })
    console.log(`✅ 训练完成（${Math.round((Date.now() - t0) / 60000)} 分钟）`)
    console.log(`  模型：${out.pth}`)
    console.log(`  索引：${out.index || '(无，index-rate 自动 0)'}`)
    console.log(`已设为当前音色。试唱：sing "白饭" --cover <人声音频路径或链接>`)
    return
  }

  if (sub === 'use-model') {
    const rvc = await import('../lib/rvc.mjs')
    rvc.setCurrentVoice(arg(argv, '--name'))
    console.log(`✓ 唱歌音色已切到「${arg(argv, '--name')}」`)
    return
  }

  if (sub === 'list') {
    console.log(`音色库（${MODELS_DIR}）共 ${voices.length} 个：`)
    const cur = config().voice?.ref_audio_path || ''
    for (const v of voices) console.log(`  ${v.name}${v.wav === cur.replace(/\\/g, '/') ? ' ←当前' : ''} · 参考：${v.text.slice(0, 30) || '(无文本)'}`)
    return
  }

  if (sub === 'try' || sub === 'tryall') {
    const targets = sub === 'tryall' ? voices : voices.filter(v => v.name === arg(argv, '--name'))
    if (!targets.length) { console.error(sub === 'try' ? '没这个音色（voice list 看看）' : '音色库是空的'); process.exit(1) }
    for (const v of targets) {
      try {
        const f = await synth(INTRO, dataPath('voice', `try-${v.name}-${Date.now()}.wav`), { ref_audio_path: v.wav, prompt_text: v.text, prompt_lang: 'zh' })
        const ok = await sendQQ(f)
        console.log(`${ok ? '✓ 已试听' : '✗ 发送失败（NapCat 没起？）'}：${v.name}${v.wav === (config().voice?.ref_audio_path || '').replace(/\\/g, '/') ? '（当前）' : ''}`)
      } catch (e) { console.error(`✗ ${v.name} 合成失败：${e.message}`) }
    }
    console.log('听完想换：node feiyu.mjs voice use --name <名字>')
    return
  }

  if (sub === 'use') {
    const name = arg(argv, '--name')
    const v = voices.find(x => x.name === name)
    if (!v) { console.error('没这个音色'); process.exit(1) }
    // 直接改配置文件（config() 是只读视图）；路径统一走 paths.mjs，
    // 认 $FEIYU_CONFIG / $DSH_HOME —— 以前读 config().configPath（不存在的字段）再硬编码 USERPROFILE。
    // configPath 在 paths.mjs 里导出的是**字符串常量**，当成函数调用必然 TypeError —— 10-26 修
    const cfgFile = configPath
    const j = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
    // 参考文本语言要跟音频一致（英文参考配 zh 会文本-音频错位，克隆质量崩）——粗判 ASCII 占比
    const asciiRatio = (v.text.match(/[\x20-\x7E]/g) || []).length / Math.max(1, v.text.length)
    const lang = arg(argv, '--lang') || (asciiRatio > 0.7 ? 'en' : 'zh')
    j.voice = { ...(j.voice || {}), ref_audio_path: v.wav, prompt_text: v.text, prompt_lang: lang }
    fs.writeFileSync(cfgFile, JSON.stringify(j, null, 2) + '\n')
    console.log(`✓ 默认音色已切换为「${v.name}」（prompt_lang=${lang}，即时生效，不用重启）`)
    return
  }

  if (sub === 'import') {
    const url = arg(argv, '--url'); const name = arg(argv, '--name'); const text = arg(argv, '--text')
    if (!url || !name || !text) { console.error('用法：voice import --url <wav直链> --name <名字> --text <这段音频说了什么（参考文本，越准效果越好）>'); process.exit(2) }
    const dir = path.join(MODELS_DIR, name)
    fs.mkdirSync(dir, { recursive: true })
    const wavFile = path.join(dir, `${name}.wav`)
    console.log('下载参考音频…')
    if (url.startsWith('http')) {
      const r = await fetch(url, { signal: AbortSignal.timeout(120000) })
      if (!r.ok) { console.error('下载失败 HTTP ' + r.status); process.exit(1) }
      fs.writeFileSync(wavFile, Buffer.from(await r.arrayBuffer()))
    } else { fs.copyFileSync(url, wavFile) }   // 也支持本地路径
    fs.writeFileSync(path.join(dir, `${name}.txt`), text, 'utf8')
    console.log(`✓ 音色「${name}」已导入（零样本，立即可用）`)
    console.log(`试听：node feiyu.mjs voice try --name ${name}`)
    console.log(`采用：node feiyu.mjs voice use --name ${name}`)
    return
  }

  if (sub === 'emo') {
    // 情绪参考音色库（L2）：参考音频的起伏就是输出的天花板 —— 实测 yinlang（起伏 4.78）带出来的
    // 语音 4.82；sunshine_girl（3.45）带出来只有 2.83。所以要给每种情绪准备一段"她自己的声音 +
    // 有情绪的韵律"当参考。做法：用同一句话多合几条（温度调高），按韵律分挑最活的那条存下来。
    const { EMOTIONS, emotionProfile } = await import('../lib/emotion.mjs')
    const { scoreWavs } = await import('../lib/prosody.mjs')
    const tts = await import('../lib/tts.mjs')
    const act = argv[1] || 'list'
    const EMO_DIR = tts.EMO_DIR()
    const MANIFEST = tts.EMO_MANIFEST()
    const readManifest = () => { try { return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) } catch { return {} } }

    const CARRIERS = {
      coquettish: '主人～人家等你等了好久嘛，你再不过来陪我，我可要生气了哦。',
      angry: '你怎么又不吃饭啊！说过多少次了！本鱼是真的生气了，不管你了！',
      wronged: '你都不理我……我等了一下午，饭也没吃，你就回我一句"忙"。',
      happy: '诶！真的吗！那太好了啊，我这就去看看，等我回来跟你讲！',
      sleepy: '嗯……好困啊，眼皮都抬不起来了，让我再躺一会儿……就一会儿。',
      tender: '慢点吃啊，别急，锅里还有呢，我给你留着，凉了就不好吃了。',
      surprise: '啊？你说什么？这事儿我怎么一点都不知道！你再说一遍？',
      shy: '你别、别这样看我啦，我脸都热了，说不出话了……',
    }

    if (act === 'list') {
      const j = readManifest()
      const keys = Object.keys(j)
      if (!keys.length) { console.log('还没有情绪参考音色。生成：node feiyu.mjs voice emo build'); return }
      console.log(`情绪参考音色（${EMO_DIR}）：`)
      for (const k of keys) {
        const e = j[k]
        const label = EMOTIONS[k]?.label || k
        console.log(`  ${label.padEnd(4)} ${k.padEnd(12)} 起伏 ${String(e.sd ?? '?').padStart(5)}  音域 ${String(e.rng ?? '?').padStart(5)}  「${String(e.text || '').slice(0, 24)}」`)
      }
      console.log('试听：node feiyu.mjs voice emo test   重做：voice emo build --force')
      return
    }

    if (act === 'test') {
      const j = readManifest()
      const probe = arg(argv, '--text') || '主人，我回来啦，今天想吃什么呀？'
      const only = arg(argv, '--emotion')
      const keys = Object.keys(j).filter(k => !only || k === only || EMOTIONS[k]?.label === only)
      if (!keys.length) { console.error('没有可试听的情绪音色（先 voice emo build）'); process.exit(1) }
      const dir = dataPath('voice', 'emo-test')
      fs.mkdirSync(dir, { recursive: true })
      for (const k of keys) {
        try {
          const f = await tts.synth(probe, path.join(dir, `${k}-${Date.now()}.wav`), { emotion: k, candidates: 3 })
          console.log(`✓ ${EMOTIONS[k]?.label || k} → ${f}`)
        } catch (e) { console.error(`✗ ${EMOTIONS[k]?.label || k} 失败：${e.message}`) }
      }
      console.log('目录：' + dir)
      return
    }

    if (act === 'build') {
      const force = argv.includes('--force')
      const perEmo = Number(arg(argv, '--candidates') || 6)
      const old = readManifest()
      const manifest = { ...old }
      console.log(`生成情绪参考音色：每种情绪合成 ${perEmo} 条候选，挑起伏最大的一条（参考段决定输出天花板）`)
      for (const [key, line] of Object.entries(CARRIERS)) {
        const label = EMOTIONS[key]?.label || key
        if (!force && manifest[key]?.wav && fs.existsSync(manifest[key].wav)) { console.log(`  · ${label} 已有（--force 重做）`); continue }
        const dir = path.join(EMO_DIR, key)
        fs.mkdirSync(dir, { recursive: true })
        const cands = []
        try {
          for (let i = 0; i < perEmo; i++) {
            const f = path.join(dir, `cand-${i}.wav`)
            // 造参考段要的是"韵律夸张"，温度往上放、不走情绪库（否则自己参考自己）
            await tts.synth(line, f, {
              candidates: 1, pick: 'first', temperature: 1.55, text_split_method: 'cut0',
              ref_audio_path: config().voice?.ref_audio_path, prompt_text: undefined,
            })
            cands.push(f)
          }
          const scores = scoreWavs(cands.map(f => ({ path: f, chars: line.length })))
          scores.sort((a, b) => (b.ok ? 1 : 0) - (a.ok ? 1 : 0) || b.score - a.score)
          const top = scores[0]
          if (!top) throw new Error('没有候选')
          const keep = path.join(dir, 'ref.wav')
          fs.copyFileSync(top.path, keep)
          fs.writeFileSync(path.join(dir, 'ref.txt'), line, 'utf8')
          for (const f of cands) if (f !== keep) { try { fs.rmSync(f, { force: true }) } catch {} }
          manifest[key] = { wav: keep, text: line, sd: top.sd, rng: top.rng, score: top.score, ok: !!top.ok, builtAt: new Date().toISOString() }
          console.log(`  ✓ ${label.padEnd(4)} 起伏 ${String(top.sd).padStart(5)} 音域 ${String(top.rng).padStart(5)} 分 ${String(top.score).padStart(6)}${top.ok ? '' : '（偏平，可 --force 重做）'}`)
        } catch (e) {
          console.log(`  ✗ ${label} 失败：${e.message}`)
          for (const f of cands) { try { fs.rmSync(f, { force: true }) } catch {} }
        }
      }
      fs.mkdirSync(EMO_DIR, { recursive: true })
      fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
      console.log('清单：' + MANIFEST)
      console.log('试听：node feiyu.mjs voice emo test')
      return
    }

    console.log('用法：voice emo list | build [--force] [--candidates 6] | test [--emotion 撒娇] [--text …]')
    return
  }

  console.log('用法：voice list | try --name | tryall | use --name | import --url --name --text | emo list/build/test')
}

if (process.argv[1] && process.argv[1].endsWith('voice.mjs')) {
  await run(process.argv.slice(2))
}
