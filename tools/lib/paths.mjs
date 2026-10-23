// 统一路径解析 —— dafeiyu 私享版。
// 设计来自 dsh-bili-whale 的 tools/lib/paths.mjs（MIT），路径前缀改为 feiyu。
//
// 两个 home 的语义（与 bili-whale 一致，避免分叉）：
//   · DSH_HOME  —— DSH 的根（配置、会话、night 状态）
//   · HOME      —— 用户主目录（凭据、账本、记忆、情绪等"随人走"的东西放 ~/.feiyu-ai）
import os from 'node:os'
import path from 'node:path'

/** 用户主目录（Windows 优先 USERPROFILE）。 */
export const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir() || '.'

/** DSH home：与宿主半边 (lib/index.js) 完全一致的解析顺序。 */
export const DSH_HOME = process.env.DSH_HOME || path.join(HOME, '.dsh')

/** DSH home 下的路径。 */
export const dshPath = (...parts) => path.join(DSH_HOME, ...parts)

/** 用户主目录下的路径。 */
export const homePath = (...parts) => path.join(HOME, ...parts)

/** 插件配置文件（FEIYU_CONFIG 可覆盖）。不含凭据。 */
export const configPath = process.env.FEIYU_CONFIG || dshPath('feiyu.config.json')

/** 数据目录：凭据 / 账本 / 记忆 / 情绪（换机器时整个拷走）。 */
export const dataDir = homePath('.feiyu-ai')
export const dataPath = (...parts) => path.join(dataDir, ...parts)

/** 凭据（与配置分离；0600；永不回显）。 */
export const credentialsPath = dataPath('credentials.json')

/** 她的会话工作目录（专用小目录，别用用户主目录 ✗ —— bili-whale Issue #6 的教训）。 */
export const WORK_DIR = dshPath('feiyu-work')

/** 生物钟状态文件。 */
export const nightStatePath = dshPath('feiyu-night.json')

/** 两本日记（工作目录下，人随时能打开看）。 */
export const diaryPath = (book) => path.join(WORK_DIR, book === 'private' ? 'feiyu-diary-private.md' : 'feiyu-diary.md')
