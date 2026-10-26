# 从 DSH 会话日志里统计 token 用量（她的账本 = 真实用量，不靠猜）
#
# DSH 把每个会话写成 session.v4.jsonl.zstd：**每行一个独立的 zstd 帧**，
# 所以 node 的 zlib.zstdDecompressSync 只能解出第一帧（后面报 prefix_unknown）。
# python 的 zstandard 用 stream_reader 能一次读穿所有帧。
#
# 用量藏在 type=assistant/message 的 data.usage 里：
#   {inputTokens, outputTokens, cacheReadTokens, totalTokens}
# 注意 totalTokens = input + output + cacheRead（缓存命中单算），别重复加。
#
# 用法：python ledger_usage.py [--sessions DIR] [--mine 工作区子串]
# 输出：JSON（stdout），键：days / lifetime / sessions / files / scannedBytes
import collections
import glob
import json
import os
import sys

import zstandard as zstd


def arg(name, default=None):
    a = sys.argv
    return a[a.index(name) + 1] if name in a else default


def main():
    sessions_dir = arg('--sessions', os.path.join(os.environ['USERPROFILE'], '.dsh', 'sessions'))
    mine_key = arg('--mine', 'feiyu-work')

    # 目录层级是 sessions/<工作区>/<会话目录>/session.v4.jsonl.zstd，
    # 会话目录名**不一定**是 session-<uuid>（她的主会话就叫 feiyu），所以别用 session-* 过滤
    files = sorted(glob.glob(os.path.join(sessions_dir, '*', '*', 'session.v*.jsonl.zst*')))
    dctx = zstd.ZstdDecompressor()
    per_day = collections.defaultdict(lambda: {'mine': _empty(), 'other': _empty()})
    lifetime = {'mine': _empty(), 'other': _empty()}
    scanned = 0
    parsed = 0
    bad = 0

    for path in files:
        mine = mine_key in path
        bucket = 'mine' if mine else 'other'
        try:
            scanned += os.path.getsize(path)
            with open(path, 'rb') as fh:
                text = dctx.stream_reader(fh).read().decode('utf-8', 'replace')
        except Exception:
            bad += 1
            continue
        for line in text.split('\n'):
            if not line.strip():
                continue
            try:
                o = json.loads(line)
            except Exception:
                continue
            if o.get('type') != 'assistant/message':
                continue
            u = (o.get('data') or {}).get('usage')
            if not isinstance(u, dict):
                continue
            inp = int(u.get('inputTokens') or 0)
            out = int(u.get('outputTokens') or 0)
            cache = int(u.get('cacheReadTokens') or 0)
            total = int(u.get('totalTokens') or (inp + out + cache))
            day = _day_of(o.get('time'))
            if not day:
                continue
            parsed += 1
            for tgt in (per_day[day][bucket], lifetime[bucket]):
                tgt['input'] += inp
                tgt['output'] += out
                tgt['cache'] += cache
                tgt['total'] += total
                tgt['calls'] += 1

    days = []
    for day in sorted(per_day):
        d = per_day[day]
        days.append({
            'day': day,
            'mine': d['mine'],
            'other': d['other'],
            'all': _add(d['mine'], d['other']),
        })

    print(json.dumps({
        'days': days,
        'lifetime': {'mine': lifetime['mine'], 'other': lifetime['other'],
                     'all': _add(lifetime['mine'], lifetime['other'])},
        'sessions': len(files),
        'unreadable': bad,
        'messages': parsed,
        'scannedBytes': scanned,
        'mineKey': mine_key,
    }, ensure_ascii=False))


def _empty():
    return {'input': 0, 'output': 0, 'cache': 0, 'total': 0, 'calls': 0}


def _add(a, b):
    return {k: a[k] + b[k] for k in a}


def _day_of(ms):
    """时间戳（毫秒）→ 本地日期 YYYY-MM-DD。"""
    if not isinstance(ms, (int, float)):
        return None
    import datetime
    return datetime.datetime.fromtimestamp(ms / 1000).strftime('%Y-%m-%d')


if __name__ == '__main__':
    main()