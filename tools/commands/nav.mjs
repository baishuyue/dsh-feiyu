// nav —— 登录验证 / 我是谁（唯一会真打一次 /nav 的只读命令）。
//
//   node feiyu.mjs nav
import { apiGet, makeHeaders } from '../lib/bili-api.mjs'
import { loadCred } from '../lib/cred.mjs'

export async function run() {
  const cred = loadCred()
  const H = makeHeaders(cred)
  const res = await apiGet('https://api.bilibili.com/x/web-interface/nav', H)
  if (Number(res?.code) !== 0 || !res?.data) {
    console.log(`✗ 未登录或 cookie 无效：${res?.message ?? 'nav 读取失败'}`)
    process.exit(1)
  }
  const d = res.data
  if (!d.isLogin) { console.log('✗ cookie 无效（未登录态）—— F12 重新复制一次'); process.exit(1) }
  console.log(`✓ 已登录：${d.uname}（mid ${d.mid}）· 等级 ${d.level_info?.current_level ?? '?'} · 硬币 ${d.money ?? '?'} · VIP ${d.vipStatus ? '是' : '否'}`)
}
