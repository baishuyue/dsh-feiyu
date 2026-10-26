# 韵律打分器 —— 给"这条语音像不像活人在说"打分
#
# 由来（10-26）：主人说"语音只有略微的语气变化，没有人类情感"。
# 实测发现 GPT-SoVITS 的能力其实够：
#   线上默认参数      F0 起伏 3.02 半音 / 音域 9.06 半音
#   只放开切句+热度     4.82 / 15.29
#   同参数连合 8 条     3.51 ~ 5.20（抽奖，波动 1.9 半音）
#   真·人声参考         4.78 / 14.88
# 所以策略是"多合几条、按起伏挑最好的一条"。本文件就是那个"挑"的眼睛。
#
# 用法：
#   echo '{"items":[{"path":"a.wav","chars":42},{"path":"b.wav","chars":42}]}' > in.json
#   python prosody.py in.json            → 打印 JSON 结果
# 指标：
#   sd   F0 标准差（半音，相对各自中位数）—— 起伏
#   rng  音域 P5~P95（半音）            —— 能拉开多大
#   rms  音量起伏（归一化标准差）        —— 强弱对比
#   rate 语速（字/秒）                   —— 太快太慢都扣分
#   score 综合分                         —— 越大越"活"
#   ok   是否可用（语速合理、浊音比正常、没有缺字/念糊）
import json
import sys

import numpy as np


def analyse(path, chars, sr_target=16000, rate_min=4.2, rate_max=6.4):
    import librosa
    import soundfile as sf

    y, sr = sf.read(path)
    if y.ndim > 1:
        y = y.mean(axis=1)
    y = np.asarray(y, dtype='float32')
    dur = float(len(y)) / sr
    if dur <= 0.05:
        return dict(dur=0, sd=0, rng=0, rms=0, rate=0, voiced=0, score=0, ok=False, why='音频太短')

    y16 = librosa.resample(y, orig_sr=sr, target_sr=sr_target)
    # pyin（带 Viterbi 平滑）比 yin 稳得多：实测 hop=512 的值与 hop=256 只差 0.1~0.3 半音，
    # 但快一倍（4 个文件 1.7s vs 3.6s）。用 yin 的话噪声会被估成倍频，起伏虚高 2~3 倍，
    # 挑候选就会挑到"抖得厉害但不像人"的那条。
    f0, _, _ = librosa.pyin(y16, fmin=70, fmax=500, sr=sr_target, frame_length=1024, hop_length=512)
    f0 = np.asarray(f0, dtype='float32')
    f0 = f0[~np.isnan(f0)]
    f0 = f0[(f0 > 70) & (f0 < 500)]
    if len(f0) < 10:
        return dict(dur=round(dur, 2), sd=0, rng=0, rms=0, rate=0, voiced=0, score=0, ok=False, why='没测到人声')

    semis = 12 * np.log2(f0 / np.median(f0))
    sd = float(np.std(semis))
    rng = float(np.percentile(semis, 95) - np.percentile(semis, 5))

    rms = librosa.feature.rms(y=y16, frame_length=1024, hop_length=256)[0]
    active = rms[rms > rms.max() * 0.08]
    rms_std = float(np.std(active) / (np.mean(active) + 1e-9)) if len(active) else 0.0
    frames = int(np.ceil(len(y16) / 512))          # pyin 的帧数（hop=512）
    voiced = float(min(1.0, len(f0) / max(1, frames)))

    rate = (chars / dur) if chars else 0.0
    # 权重来自 10-26 的三轮实测：音域最能区分"念稿"和"说话"（平 9.5 / 活 15.2），
    # 其次 F0 起伏，音量起伏作为辅助。
    score = rng * 0.5 + sd * 1.2 + rms_std * 3.0
    why = []
    if chars:
        expect = chars / 5.2
        if abs(dur - expect) / expect > 0.35:
            score -= 1.5
            why.append(f'时长偏离预期（{dur:.1f}s vs {expect:.1f}s，可能缺字/念糊）')
        if rate < rate_min or rate > rate_max:
            score -= min(2.0, max(rate_min - rate, rate - rate_max) * 0.8)
            why.append(f'语速 {rate:.1f} 字/秒 不在 {rate_min:g}~{rate_max:g}')
    if voiced < 0.20:
        score -= 2.0
        why.append(f'浊音比偏低 {voiced:.2f}')
    if sd < 3.4 or rng < 11.5:
        why.append(f'语调偏平（起伏 {sd:.1f} / 音域 {rng:.1f}）')

    return dict(dur=round(dur, 2), sd=round(sd, 2), rng=round(rng, 2), rms=round(rms_std, 2),
                rate=round(rate, 2), voiced=round(voiced, 2), score=round(score, 2),
                ok=not why, why='；'.join(why))


def main():
    arg = sys.argv[1] if len(sys.argv) > 1 else ''
    if arg and arg != '-':
        with open(arg, 'r', encoding='utf-8-sig') as f:
            payload = json.load(f)
    else:
        payload = json.load(sys.stdin)
    items = payload.get('items') or []
    out = []
    for it in items:
        try:
            out.append(dict(path=it.get('path'), **analyse(
                it.get('path'), int(it.get('chars') or 0),
                rate_min=float(it.get('rateMin') or 4.2), rate_max=float(it.get('rateMax') or 6.4))))
        except Exception as e:  # 单个失败不影响其他候选
            out.append(dict(path=it.get('path'), ok=False, score=0, why=str(e)[:120]))
    print(json.dumps({'items': out}, ensure_ascii=False))


if __name__ == '__main__':
    main()