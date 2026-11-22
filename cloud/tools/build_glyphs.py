#!/usr/bin/env python3
"""Pre-render Noto Sans glyphs into one binary atlas for the Worker (Kindle display).

Output: src/glyphs.bin (all bitmaps, 8-bit coverage) + src/glyphs.json (metrics).
Noto Sans is licensed under the SIL Open Font License 1.1.
"""
import json, os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
FONTS = {"b": os.path.join(ROOT, "fonts", "NotoSans-Bold.ttf"),
         "r": os.path.join(ROOT, "fonts", "NotoSans-Regular.ttf")}
SIZES = {"b": [18, 20, 22, 24, 26, 28, 30, 32, 34, 36, 40, 44, 48, 52, 56, 62, 72],
         "r": [18, 20, 22, 24, 26, 28, 30, 32, 34, 38, 42, 48]}
BIG = {"b": [110, 140, 220]}  # display sizes: limited character set
CHARS = "".join(chr(c) for c in range(32, 127)) + "".join(chr(c) for c in range(160, 256)) + "–—…‘’“”€•·"
BIG_CHARS = {110: "".join(chr(c) for c in range(32, 127)) + "ÄÖÜäöüß",
             140: "0123456789-−°", 220: "0123456789-−°"}

def build():
    blob = bytearray()
    meta = {}
    def add(weight, size, chars):
        f = ImageFont.truetype(FONTS[weight], size)
        asc, desc = f.getmetrics()
        g = {}
        for ch in chars:
            adv = f.getlength(ch)
            x0, y0, x1, y1 = f.getbbox(ch, anchor="ls")
            w, h = max(0, x1 - x0), max(0, y1 - y0)
            off = len(blob)
            if w and h:
                im = Image.new("L", (w, h), 0)
                ImageDraw.Draw(im).text((-x0, -y0), ch, font=f, fill=255, anchor="ls")
                blob.extend(im.tobytes())
            g[ch] = [round(adv, 2), w, h, x0, y0, off]
        meta[f"{weight}{size}"] = {"asc": asc, "desc": desc, "g": g}
    for w, sizes in SIZES.items():
        for s in sizes:
            add(w, s, CHARS)
    for w, sizes in BIG.items():
        for s in sizes:
            add(w, s, BIG_CHARS[s])
    with open(os.path.join(ROOT, "src", "glyphs.bin"), "wb") as f:
        f.write(blob)
    with open(os.path.join(ROOT, "src", "glyphs.json"), "w") as f:
        json.dump(meta, f, separators=(",", ":"), ensure_ascii=False)
    print(len(blob), "bytes of bitmaps,", len(meta), "sizes")

build()
