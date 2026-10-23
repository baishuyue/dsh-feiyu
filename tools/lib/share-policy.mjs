// 分享标尺：评论 @ 与（将来的）私信共用同一套校验。
// 复用 dsh-bili-whale 的 tools/lib/share-policy.mjs（MIT）。
// 评分不够 = 今天没有值得发的 —— 这是合法结果，不是失败 ✓
export function validateShare(cfg, { reason, score, rank = 1 }) {
  if (cfg.share?.enabled === false) throw new Error('分享已关闭（share.enabled=false）')
  if (typeof reason !== 'string' || reason.trim().length < 8) throw new Error('分享需要 --reason（至少 8 字）')
  const n = Number(score), threshold = Number(cfg.share?.minScore ?? 13)
  if (score === undefined || score === '' || typeof score === 'boolean' || !Number.isFinite(n) || n < 0 || n > 20)
    throw new Error('分享需要 --score（0–20）')
  if (!Number.isFinite(threshold) || n < threshold) throw new Error(`评分 ${n} 未达到阈值 ${threshold}`)
  if (typeof rank === 'boolean' || Number(rank) !== 1) throw new Error('分享只允许 --rank 1')
  return { score: n, reason: reason.trim(), rank: 1 }
}
