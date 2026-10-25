// rvc —— 她自己的声音：数据集生成 → RVC 训练 → 推理换声 → 人声分离。
//
// 唱歌的专业路线（10-25 拍板）：翻唱管线——真歌的人声干声（旋律/气息/技巧都是专业歌手的）
// 经 RVC 换成她的音色，再混回伴奏。这就是"AI 孙燕姿"同款管线，效果是专业歌手级。
// RVC 新版训练链（照 webui.py 的 cmd 格式逐条复刻，cwd 必须是仓库根）：
//   preprocess → extract_f0(cuda rmvpe) → extract_hubert → filelist+config+mute → train → train_index
// 环境（10-25 装好）：仓库 D:/rvc/RVC，venv D:/rvc/venv（torch 2.7.1+cu128），底模 assets/ 全齐。
import fs from 'node:fs'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { config } from './config.mjs'
import { dataPath, homePath } from './paths.mjs'

const RVC_ROOT = () => config().rvc?.root || 'D:/rvc/RVC'
const RVC_PY = () => config().rvc?.python || 'D:/rvc/venv/Scripts/python.exe'
const SR = '48k'
const FEAT_DIM = 768          // v2 = 768
const RUN_FILE = () => dataPath('rvc-voice.json')

export function rvcReady() {
  return fs.existsSync(RVC_PY()) && fs.existsSync(path.join(RVC_ROOT(), 'train', 'train.py'))
    && fs.existsSync(path.join(RVC_ROOT(), 'assets', 'pretrained_v2', `f0G${SR}.pth`))
}

function readRun() { try { return JSON.parse(fs.readFileSync(RUN_FILE(), 'utf8')) } catch { return {} } }
function writeRun(o) { try { fs.mkdirSync(path.dirname(RUN_FILE()), { recursive: true }); fs.writeFileSync(RUN_FILE(), JSON.stringify(o, null, 1)) } catch {} }

export function listVoiceModels() {
  const run = readRun()
  return { current: run.current || '', models: run.models || {} }
}
export function currentVoice() { return readRun().current || '' }
export function setCurrentVoice(name) {
  const run = readRun()
  if (!run.models?.[name]) throw new Error(`没有叫「${name}」的音色模型（voice models 看看）`)
  run.current = name
  writeRun(run)
}
function recordModel(name, pth, index) {
  const run = readRun()
  run.models = run.models || {}
  run.models[name] = { pth, index, sr: SR, updatedAt: Date.now() }
  run.current = name
  writeRun(run)
}

/** 长任务日志：训练全程写 ~/.feiyu-ai/rvc/train-<name>.log，随时可翻。 */
function logFile(name) { return dataPath('rvc', `train-${name}.log`) }
const stamp = () => new Date().toISOString().slice(11, 19)
function appendLog(name, line) {
  try { fs.mkdirSync(path.dirname(logFile(name)), { recursive: true }); fs.appendFileSync(logFile(name), `${stamp()} ${line}\n`) } catch {}
}

/** 跑一条 RVC 子命令（cwd=仓库根），实时把 stdout 进日志。返回退出码。 */
function runRvc(args, { onLine } = {}) {
  return new Promise((resolve, reject) => {
    const root = RVC_ROOT()
    const logPath = path.join(root, '.feiyu-run.log')
    fs.appendFileSync(logPath, `\n$ ${args.join(' ')}\n`)
    // PYTHONPATH=仓库根：train/*.py 里 from infer.audio import ... 需要根目录在 sys.path
    // （webui 靠便携 runtime 的 .pth 才没炸，我们自己的 venv 得显式给）
    // PATH 前插 ffmpeg/ffprobe 所在目录：infer/audio.py 用 ffmpeg-python 解码音频，
    // 二进制必须能被找到（GPT-SoVITS runtime 有 ffmpeg.exe，ffprobe 在 D:/rvc/bin）
    const extraPath = [config().rvc?.binPath || 'D:/rvc/bin', path.dirname(config().rvc?.ffmpeg || 'D:/GPT-SoVITS/runtime/ffmpeg.exe')]
      .filter((p) => fs.existsSync(p)).join(path.delimiter)
    const child = spawn(RVC_PY(), args, { cwd: root, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONPATH: root, PYTORCH_CUDA_ALLOC_CONF: 'expandable_segments:True', ...(extraPath ? { PATH: extraPath + path.delimiter + (process.env.PATH || '') } : {}) } })
    let tail = []
    const feed = (buf) => {
      for (const line of String(buf).split(/\r?\n/)) {
        if (!line.trim()) continue
        tail.push(line)
        if (tail.length > 8) tail.shift()
        fs.appendFileSync(logPath, line + '\n')
        try { onLine?.(line) } catch {}
      }
    }
    child.stdout.on('data', feed)
    child.stderr.on('data', feed)
    child.on('error', reject)
    child.on('exit', (code) => resolve({ code, tail }))
  })
}

// ── ① 数据集生成：LLM 写稿 → GPT-SoVITS 逐句合成 ───────────────────────────
/** 默认独白选题：日常/情绪/爱好/讲故事，句子长短交错（音色多样性比字数重要）。 */
const SCRIPT_TOPICS = [
  '自我介绍和今天的心情', '爱吃的东西讲三句', '讲一个小时候的想象', '夸一夸主人但别太腻',
  '吐槽一件小事', '讲讲今天刷到的有意思的视频', '学猫叫两句再自己笑场', '温柔的睡前晚安语',
  '给自己打气的口号', '假装在直播间和观众互动', '描述海边和游泳的感觉', '讲一个冷笑话并自己揭底',
]
export async function genDataset({ name, sentences, refAudio, promptText, log = () => {} }) {
  const { synth } = await import('./tts.mjs')
  const { chat } = await import('./llm.mjs')
  let lines = sentences
  if (!lines || !lines.length) {
    // LLM 一次写满 60 句（约 10~12 分钟语音），长短交错、口语、带情绪起伏
    const resp = await chat([
      { role: 'system', content: '你是"大肥鱼"——一条圆滚滚的蓝鲸鱼娘，爱吃白饭、会撒娇、有点傲娇、爱刷视频。现在为她的声音克隆生成朗读语料。只输出 JSON：{"lines":["句子", ...]}，共 60 句：覆盖这些主题并均匀分布——' + SCRIPT_TOPICS.join('；') + '。每句 8~30 字，口语化、有情绪起伏（兴奋/委屈/困/俏皮/温柔都有），别押韵别排比，像真人随口说的。' },
      { role: 'user', content: '写语料：' },
    ], { temperature: 1.0, max_tokens: 2500 })
    const m = String(resp ?? '').match(/\{[\s\S]*\}/)
    lines = m ? (JSON.parse(m[0]).lines || []) : []
  }
  lines = (lines || []).map((s) => String(s).trim()).filter((s) => s.length >= 4).slice(0, 80)
  if (lines.length < 10) throw new Error(`语料只有 ${lines.length} 句，太少（LLM 写稿失败？）`)
  const dir = dataPath('rvc-datasets', name)
  fs.mkdirSync(dir, { recursive: true })
  let ok = 0
  for (let i = 0; i < lines.length; i++) {
    const out = path.join(dir, `line-${String(i).padStart(3, '0')}.wav`)
    if (fs.existsSync(out) && fs.statSync(out).size > 20000) { ok++; continue }   // 断点续跑
    try {
      const f = await synth(lines[i], out, refAudio ? { ref_audio_path: refAudio, prompt_text: promptText || '', prompt_lang: 'zh' } : {})
      if (fs.existsSync(f)) ok++
      log(`  [${i + 1}/${lines.length}] ✓ ${lines[i].slice(0, 20)}`)
    } catch (e) {
      log(`  [${i + 1}/${lines.length}] ✗ ${String(e.message).slice(0, 60)}`)
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  if (ok < 10) throw new Error(`合成成功 ${ok} 句，太少（SoVITS(9880) 活着吗？）`)
  const totalSec = Math.round(fs.readdirSync(dir).filter((f) => f.endsWith('.wav')).reduce((n, f) => n + fs.statSync(path.join(dir, f)).size, 0) / (32000 * 2) / 60)
  return { dir, count: ok, approxMinutes: totalSec }
}

// ── ② 训练链（六步）───────────────────────────────────────────────────────
function buildMuteFiles(root) {
  const muteDir = path.join(root, 'logs', 'mute')
  const wav = path.join(muteDir, '0_gt_wavs', `mute${SR}.wav`)
  const feat = path.join(muteDir, `3_feature${FEAT_DIM}`, 'mute.npy')
  const f0a = path.join(muteDir, '2a_f0', 'mute.wav.npy')
  const f0b = path.join(muteDir, '2b-f0nsf', 'mute.wav.npy')
  if (fs.existsSync(wav) && fs.existsSync(feat) && fs.existsSync(f0a) && fs.existsSync(f0b)) return
  fs.mkdirSync(path.dirname(wav), { recursive: true })
  fs.mkdirSync(path.dirname(feat), { recursive: true })
  fs.mkdirSync(path.dirname(f0a), { recursive: true })
  fs.mkdirSync(path.dirname(f0b), { recursive: true })
  // 1 秒 48k 静音 wav（纯 node 写 RIFF，不依赖 numpy）
  const n = 48000
  const buf = Buffer.alloc(44 + n * 2)
  buf.write('RIFF', 0, 'ascii'); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8, 'ascii')
  buf.write('fmt ', 12, 'ascii'); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(48000, 24); buf.writeUInt32LE(96000, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34)
  buf.write('data', 36, 'ascii'); buf.writeUInt32LE(n * 2, 40)
  fs.writeFileSync(wav, buf)
  // 三个零 npy（帧数给 2，训练端会自动对齐/截断）
  const py = `import numpy as np,os\nos.makedirs(r'${path.dirname(feat)}',exist_ok=True)\nnp.save(r'${feat}',np.zeros((2,${FEAT_DIM}),dtype=np.float32))\nnp.save(r'${f0a}',np.zeros((2,),dtype=np.int64))\nnp.save(r'${f0b}',np.zeros((2,),dtype=np.float32))`
  execFileSync(RVC_PY(), ['-c', py], { windowsHide: true, timeout: 60000 })
}

/** 生成 filelist.txt + config.json（照 webui.py run_train_model 的逻辑复刻）。 */
function buildTrainInputs(root, exp) {
  const expDir = path.join(root, 'logs', exp)
  const gt = path.join(expDir, '0_gt_wavs')
  const feat = path.join(expDir, `3_feature${FEAT_DIM}`)
  const f0a = path.join(expDir, '2a_f0')
  const f0b = path.join(expDir, '2b-f0nsf')
  // 名字归一化：gt 是 <n>.wav，feature 是 <n>.npy，f0 是 <n>.wav.npy —— 全剥到 <n> 再求交集
  const names = (dir, ext) => new Set(fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith(ext)).map((f) => f.replace(/\.wav\.npy$/, '').replace(/\.(npy|spec\.pt|wav)$/, ''))
    : [])
  const common = [...names(gt, '.wav')].filter((n) => names(feat, '.npy').has(n) && names(f0a, '.npy').has(n) && names(f0b, '.npy').has(n))
  if (common.length < 5) throw new Error(`有效样本只有 ${common.length} 个（切分/特征提取没跑完？）`)
  const P = (s) => s.replace(/\\/g, '/')
  const lines = common.map((n) => `${P(path.join(gt, n))}.wav|${P(path.join(feat, n))}.npy|${P(path.join(f0a, n))}.wav.npy|${P(path.join(f0b, n))}.wav.npy|0`)
  const muteWav = P(path.join(root, 'logs', 'mute', '0_gt_wavs', `mute${SR}.wav`))
  const muteFeat = P(path.join(root, 'logs', 'mute', `3_feature${FEAT_DIM}`, 'mute.npy'))
  const muteF0a = P(path.join(root, 'logs', 'mute', '2a_f0', 'mute.wav.npy'))
  const muteF0b = P(path.join(root, 'logs', 'mute', '2b-f0nsf', 'mute.wav.npy'))
  for (let i = 0; i < 2; i++) lines.push(`${muteWav}|${muteFeat}|${muteF0a}|${muteF0b}|0`)
  // shuffle
  for (let i = lines.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[lines[i], lines[j]] = [lines[j], lines[i]] }
  fs.writeFileSync(path.join(expDir, 'filelist.txt'), lines.join('\n') + '\n')
  // config.json：直接用官方 v2/48k 超参
  const cfgSrc = JSON.parse(fs.readFileSync(path.join(root, 'configs', 'v2', `${SR}.json`), 'utf8'))
  fs.writeFileSync(path.join(expDir, 'config.json'), JSON.stringify(cfgSrc, null, 4))
  return { samples: common.length }
}

/**
 * 全链路训练。onLine 逐行收日志；跑完自动登记模型（assets/weights 最新 pth + added_*.index）。
 * @returns {{pth, index, minutes}} 
 */
export async function trainVoice({ name, datasetDir, epochs = 150, batch = 8, saveEvery = 50, log = () => {} }) {
  if (!rvcReady()) throw new Error('RVC 环境不齐（python/train.py/48k 底模），先跑 voice doctor')
  const root = RVC_ROOT()
  const abs = (p) => path.resolve(String(p).replace(/\//g, path.sep))
  const ds = abs(datasetDir)
  if (!fs.existsSync(ds)) throw new Error('数据集目录不存在：' + ds)
  const onLine = (l) => log(l)
  appendLog(name, `==== 训练开始 name=${name} epochs=${epochs} ====`)
  fs.mkdirSync(path.join(root, 'logs', name), { recursive: true })   // preprocess 直接 open 日志文件，目录得先有（webui 同款前置）
  const steps = [
    // 全部 -m 模块方式跑：脚本方式会把 sys.path[0]=脚本目录（train/ 里有 train.py，遮蔽同名包 → 循环导入）。
    // -m 时 sys.path[0]=cwd（仓库根），train 作为包解析（train/__init__.py 已补）。
    ['数据切分', ['-m', 'train.preprocess', ds, '48000', '4', abs(path.join(root, 'logs', name)), 'False', '3.5']],
    ['f0提取', ['-m', 'train.dataset.extract_f0', 'cuda', '1', '0', '0', abs(path.join(root, 'logs', name)), 'False']],
    ['特征提取', ['-m', 'train.dataset.extract_hubert_feature', 'cuda', '1', '0', abs(path.join(root, 'logs', name)), 'v2', 'False']],
  ]
  for (const [label, args] of steps) {
    log(`▶ ${label}…`)
    const r = await runRvc(args, { onLine })
    if (r.code !== 0) throw new Error(`${label}失败(code ${r.code})：${r.tail.join(' | ').slice(-300)}`)
  }
  buildMuteFiles(root)
  const { samples } = buildTrainInputs(root, name)
  log(`▶ filelist 就绪（${samples} 段），开始训练 ${epochs} 轮（4060 约 ${(epochs * 0.35).toFixed(0)} 分钟）…`)
  const train = await runRvc([
    '-m', 'train.train', '-e', name, '-sr', SR, '-f0', '1', '-bs', String(batch), '-g', '0',
    '-te', String(epochs), '-se', String(saveEvery),
    '-pg', `assets/pretrained_v2/f0G${SR}.pth`, '-pd', `assets/pretrained_v2/f0D${SR}.pth`,
    '-l', '1', '-c', '0', '-sw', '1', '-v', 'v2',
  ], { onLine })
  if (train.code !== 0) throw new Error(`训练失败(code ${train.code})：${train.tail.join(' | ').slice(-300)}`)
  log('▶ 建索引…')
  await runRvc(['-m', 'train.train_index', name, 'v2', abs(root), '4'], { onLine })
  // 登记产物：assets/weights 里这个实验最新的 pth + logs/<name>/added_*.index
  const wDir = path.join(root, 'assets', 'weights')
  const pth = fs.readdirSync(wDir).filter((f) => f.startsWith(name) && f.endsWith('.pth'))
    .map((f) => ({ f, mt: fs.statSync(path.join(wDir, f)).mtimeMs })).sort((a, b) => b.mt - a.mt)[0]
  if (!pth) throw new Error('训练完成但 assets/weights 里没找到模型文件')
  const lDir = path.join(root, 'logs', name)
  const index = fs.existsSync(lDir) ? (fs.readdirSync(lDir).filter((f) => f.startsWith('added_') && f.endsWith('.index'))[0] || '') : ''
  const out = { pth: path.join(wDir, pth.f).replace(/\\/g, '/'), index: index ? path.join(lDir, index).replace(/\\/g, '/') : '' }
  recordModel(name, out.pth, out.index)
  appendLog(name, `==== 完成：${out.pth} ====`)
  return out
}

// ── ③ 推理换声（infer/cli.py）──────────────────────────────────────────────
function ffprobe(path_) {
  try {
    const exe = 'D:/rvc/bin/ffprobe.exe'
    if (!fs.existsSync(exe)) return 0
    return Number(execFileSync(exe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', String(path_).replace(/\//g, path.sep)], { encoding: 'utf8', timeout: 20000 }).trim()) || 0
  } catch { return 0 }
}

export async function convertVoice({ input, output, name, pitch = 0, indexRate = 0.75, protect = 0.33, log = () => {} }) {
  const run = readRun()
  const model = run.models?.[name || run.current]
  if (!model) throw new Error(`音色模型没登记：${name || '(current)'}（voice models 看看）`)
  const out = String(output).replace(/\//g, path.sep)
  fs.mkdirSync(path.dirname(out), { recursive: true })
  const base = ['infer/cli.py', '--model', model.pth, '--pitch', String(pitch), '--f0-method', 'rmvpe',
    '--index-rate', String(indexRate), '--protect', String(protect), '--overwrite']
  if (model.index) base.push('--index', model.index)
  const convertOne = (inp, o) => new Promise((resolve, reject) => {
    runRvc([...base, '--input', String(inp).replace(/\//g, path.sep), '--output', String(o).replace(/\//g, path.sep)], { onLine: log })
      .then((r) => (r.code === 0 && fs.existsSync(o) ? resolve(o) : reject(new Error('换声失败：' + r.tail.join(' | ').slice(-300)))))
  })
  // 长音频切块：8GB 卡整条 4 分钟会 CUDA OOM —— 30s 一段各换各的，再 ffmpeg concat 拼回去
  const dur = ffprobe(input)
  const CHUNK = 30
  if (dur > CHUNK + 10) {
    const tmp = path.join(path.dirname(out), `.rvc-chunks-${Date.now()}`)
    fs.mkdirSync(tmp, { recursive: true })
    try {
      const ffmpegExe = 'D:/rvc/bin/ffmpeg.exe'
      execFileSync(ffmpegExe, ['-hide_banner', '-loglevel', 'error', '-y', '-i', String(input).replace(/\//g, path.sep),
        '-f', 'segment', '-segment_time', String(CHUNK), '-ac', '1', '-ar', '44100', path.join(tmp, 'seg%04d.wav').replace(/\//g, path.sep)],
        { timeout: 120000, windowsHide: true })
      const segs = fs.readdirSync(tmp).filter((f) => f.startsWith('seg') && f.endsWith('.wav')).sort()
      log(`  长音频 ${Math.round(dur)}s → 切 ${segs.length} 段换声`)
      const outs = []
      for (let i = 0; i < segs.length; i++) {
        const o = path.join(tmp, `c${segs[i].slice(3)}`)
        await convertOne(path.join(tmp, segs[i]), o)
        outs.push(`file '${o.replace(/\\/g, '/')}'`)
        log(`  [${i + 1}/${segs.length}] ✓`)
      }
      fs.writeFileSync(path.join(tmp, 'list.txt'), outs.join('\n'))
      // 重编码拼接（防各段采样率/声道不一致炸 copy）
      execFileSync(ffmpegExe, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0',
        '-i', path.join(tmp, 'list.txt').replace(/\//g, path.sep), '-c:a', 'pcm_s16le', out], { timeout: 120000, windowsHide: true })
      return out
    } finally { try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {} }
  }
  await convertOne(String(input).replace(/\//g, path.sep), out)
  return out
}

// ── ④ 人声分离（pymss worker 协议：request.json → stdout JSON 事件）────────
export async function separateVocals({ input, outDir, model = 'vocals-bs-roformer-368' }) {
  const root = RVC_ROOT()
  const tmpReq = path.join(dataPath('rvc'), `sep-${Date.now()}.json`)
  const vocalRoot = path.join(outDir, 'vocals').replace(/\//g, path.sep)
  const insRoot = path.join(outDir, 'instrumental').replace(/\//g, path.sep)
  fs.mkdirSync(vocalRoot, { recursive: true })
  fs.mkdirSync(insRoot, { recursive: true })
  fs.mkdirSync(path.dirname(tmpReq), { recursive: true })
  fs.writeFileSync(tmpReq, JSON.stringify({
    model_id: model,
    input_paths: [String(input).replace(/\//g, path.sep)],
    desired_root: vocalRoot,
    secondary_root: insRoot,
    output_format: 'wav',
    model_dtype: 'fp32',
    allow_fp32_retry: true,
  }))
  const code = "import sys;request_path=sys.argv[1];sys.argv[:]=[sys.argv[0]];from tools.pymss_webui import _pymss_worker_main;raise SystemExit(_pymss_worker_main(request_path))"
  const r = await runRvc(['-u', '-c', code, tmpReq], {})
  try { fs.rmSync(tmpReq, { force: true }) } catch {}
  const vocal = findWav(vocalRoot), instrumental = findWav(insRoot)
  if (!vocal) throw new Error('人声分离失败：' + r.tail.join(' | ').slice(-250))
  return { vocal, instrumental }
}
function findWav(dir) {
  try { return fs.readdirSync(dir).filter((f) => f.endsWith('.wav')).map((f) => path.join(dir, f))[0] || '' } catch { return '' }
}
