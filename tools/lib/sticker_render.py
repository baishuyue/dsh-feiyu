#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""按一句话现做一张表情贴纸（无需联网、不花额度）。

用法：
    python sticker_render.py "困死了" out.png

设计：圆角卡片 + 从文案哈希取色的柔和底色 + 居中大字 + 右下角一只小鲸鱼。
字用微软雅黑（Windows 自带），没有就退回黑体/宋体。
"""
import hashlib
import os
import sys

from PIL import Image, ImageDraw, ImageFont

FONTS = [
    r"C:\Windows\Fonts\msyhbd.ttc",
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
    r"C:\Windows\Fonts\simsun.ttc",
]

# 柔和底色（浅色系，配深色字）
PALETTE = [
    (255, 244, 214), (255, 231, 233), (226, 243, 255), (232, 240, 255),
    (235, 247, 233), (246, 236, 255), (255, 240, 226), (226, 246, 244),
]
INK = (38, 42, 52)
WHALE = (150, 200, 240)


def pick_font(size):
    for p in FONTS:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                continue
    return ImageFont.load_default()


def wrap(text, font, draw, max_w):
    """按像素宽度折行，最多 3 行。"""
    lines, cur = [], ""
    for ch in text:
        probe = cur + ch
        if draw.textlength(probe, font=font) <= max_w:
            cur = probe
        else:
            if cur:
                lines.append(cur)
            cur = ch
            if len(lines) >= 2:
                break
    if cur and len(lines) < 3:
        lines.append(cur)
    return lines


def draw_whale(d, x, y, s):
    """右下角的小鲸鱼：身体 + 尾巴 + 眼睛，纯色块。"""
    d.ellipse([x, y, x + s, y + s * 0.78], fill=WHALE, outline=INK, width=max(2, s // 22))
    # 尾巴
    d.polygon([(x + s * 0.02, y + s * 0.30), (x - s * 0.26, y + s * 0.16),
               (x - s * 0.20, y + s * 0.52)], fill=WHALE, outline=INK)
    # 眼睛
    r = max(2, s // 20)
    d.ellipse([x + s * 0.30 - r, y + s * 0.30 - r, x + s * 0.30 + r, y + s * 0.30 + r], fill=INK)
    # 水柱（贴着气孔画，别飘在空中）
    d.arc([x + s * 0.34, y - s * 0.13, x + s * 0.58, y + s * 0.04], 195, 345, fill=WHALE, width=max(2, s // 24))


def render(text, out_path, size=640):
    text = (text or "").strip()[:16] or "…"
    bg = PALETTE[int(hashlib.md5(text.encode("utf-8")).hexdigest(), 16) % len(PALETTE)]

    img = Image.new("RGB", (size, size), (250, 250, 248))
    d = ImageDraw.Draw(img)
    pad = int(size * 0.055)
    d.rounded_rectangle([pad, pad, size - pad, size - pad], radius=int(size * 0.12), fill=bg)

    max_w = size - pad * 2 - int(size * 0.10)
    fs = int(size * 0.20)
    while fs > 28:
        font = pick_font(fs)
        lines = wrap(text, font, d, max_w)
        line_h = fs * 1.28
        if len(lines) * line_h <= size * 0.52:
            break
        fs -= 6

    total_h = len(lines) * line_h
    # 两行以上时整体上移，给右下角的小鲸鱼让位
    y = (size - total_h) / 2 - size * (0.03 if len(lines) == 1 else 0.075)
    for line in lines:
        w = d.textlength(line, font=font)
        d.text(((size - w) / 2, y), line, font=font, fill=INK)
        y += line_h

    draw_whale(d, size - pad - int(size * 0.215), size - pad - int(size * 0.205), int(size * 0.155))
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    img.save(out_path, "PNG")
    return out_path


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("用法：sticker_render.py \"文案\" out.png", file=sys.stderr)
        sys.exit(2)
    print(render(sys.argv[1], sys.argv[2]))
