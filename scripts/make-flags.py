# -*- coding: utf-8 -*-
"""
言語選択などで使う国旗を SVG で描き起こす。
絵文字の国旗は Windows の標準フォントに入っておらず「JP」「US」等の2文字になるため、
画像に置き換える。外部からの取得はせず、各国旗の公式の寸法比に沿って自前で描く。
すべて 3:2（60×40）に統一する（並べたときに大きさが揃うため）。
"""
import io
import math
import os

OUT = u"/Users/akiramiyata/Library/CloudStorage/Dropbox/Mac/Desktop/Dev/04_semi-self/semi-self-app/public/flags/"
W, H = 60.0, 40.0

os.makedirs(OUT, exist_ok=True)


def star(cx, cy, r_out, angle_deg=-90.0):
    """5稜星の points 文字列。angle_deg は最初の頂点の向き（既定は真上）。"""
    r_in = r_out * math.sin(math.radians(18)) / math.sin(math.radians(126))
    pts = []
    for i in range(10):
        r = r_out if i % 2 == 0 else r_in
        a = math.radians(angle_deg + i * 36.0)
        pts.append("%.3f,%.3f" % (cx + r * math.cos(a), cy + r * math.sin(a)))
    return " ".join(pts)


def wrap(body):
    # 白い国旗が白背景で消えないよう、内側に薄い枠を重ねる
    border = ('<rect x="0.5" y="0.5" width="%.1f" height="%.1f" fill="none" '
              'stroke="rgba(0,0,0,0.18)" stroke-width="1"/>' % (W - 1, H - 1))
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %g %g" width="%g" height="%g">'
            '%s%s</svg>') % (W, H, W, H, body, border)


def save(name, body):
    path = OUT + name + ".svg"
    io.open(path, "w", encoding="utf-8").write(wrap(body))
    print(u"  %s.svg (%d バイト)" % (name, os.path.getsize(path)))


# ── 日本 ───────────────────────────────────────────────────────────────
# 白地に日章。直径は縦の 3/5、中央に置く。
save("ja",
     '<rect width="60" height="40" fill="#fff"/>'
     '<circle cx="30" cy="20" r="12" fill="#BC002D"/>')

# ── アメリカ ───────────────────────────────────────────────────────────
# 13条（赤7・白6）＋ union（縦 7/13・横 2/5）に50星（6個と5個の9段）。
stripes = "".join(
    '<rect y="%.4f" width="60" height="%.4f" fill="%s"/>' % (i * H / 13.0, H / 13.0, "#B22234" if i % 2 == 0 else "#fff")
    for i in range(13))
cw, ch = W * 0.4, H * 7.0 / 13.0
stars = []
for row in range(9):
    n = 6 if row % 2 == 0 else 5
    for col in range(n):
        x = cw / 12.0 * (1 + 2 * col if row % 2 == 0 else 2 + 2 * col)
        y = ch / 10.0 * (1 + row)
        stars.append('<polygon points="%s" fill="#fff"/>' % star(x, y, ch * 0.0555))
save("en",
     stripes +
     '<rect width="%.3f" height="%.3f" fill="#3C3B6E"/>' % (cw, ch) +
     "".join(stars))

# ── 中国（簡体） ───────────────────────────────────────────────────────
# 赤地。大星は中心(1/6,1/6)・外径は縦の3/20。小星4つは大星を向く。
big = (W * 5.0 / 30.0, H * 5.0 / 20.0, H * 3.0 / 20.0)
smalls = [(10, 2), (12, 4), (12, 7), (10, 9)]
cn = ['<rect width="60" height="40" fill="#EE1C25"/>',
      '<polygon points="%s" fill="#FFDE00"/>' % star(big[0], big[1], big[2])]
for sx, sy in smalls:
    x, y = W * sx / 30.0, H * sy / 20.0
    ang = math.degrees(math.atan2(big[1] - y, big[0] - x))  # 一稜を大星へ向ける
    cn.append('<polygon points="%s" fill="#FFDE00"/>' % star(x, y, H * 1.0 / 20.0, ang))
save("zh", "".join(cn))

# ── 台湾（繁体） ───────────────────────────────────────────────────────
# 赤地・左上に青の canton（縦横とも 1/2）、白日は12条の光芒。
sun_cx, sun_cy = W * 0.25, H * 0.25
rays = []
for i in range(12):
    a = math.radians(i * 30.0)
    half = math.radians(7.5)
    r1, r2 = H * 0.075, H * 0.16
    p1 = (sun_cx + r1 * math.cos(a - half), sun_cy + r1 * math.sin(a - half))
    p2 = (sun_cx + r2 * math.cos(a), sun_cy + r2 * math.sin(a))
    p3 = (sun_cx + r1 * math.cos(a + half), sun_cy + r1 * math.sin(a + half))
    rays.append('<polygon points="%.3f,%.3f %.3f,%.3f %.3f,%.3f" fill="#fff"/>' % (p1 + p2 + p3))
save("zh-TW",
     '<rect width="60" height="40" fill="#FE0000"/>'
     '<rect width="30" height="20" fill="#000095"/>' +
     "".join(rays) +
     '<circle cx="%.3f" cy="%.3f" r="%.3f" fill="#fff"/>' % (sun_cx, sun_cy, H * 0.0875) +
     '<circle cx="%.3f" cy="%.3f" r="%.3f" fill="#000095"/>' % (sun_cx, sun_cy, H * 0.075) +
     '<circle cx="%.3f" cy="%.3f" r="%.3f" fill="#fff"/>' % (sun_cx, sun_cy, H * 0.0625))

# ── 韓国 ───────────────────────────────────────────────────────────────
# 白地・中央に太極（赤／青）、四隅に卦。太極と卦は対角線に合わせて傾ける。
R = H * 0.25
tilt = math.degrees(math.atan2(H, W))   # 3:2 の対角 ≒ 33.69度
taegeuk = (
    '<g transform="rotate(%.2f 30 20)">' % (-tilt) +
    '<circle cx="30" cy="20" r="%.3f" fill="#0047A0"/>' % R +
    '<path d="M %.3f,20 A %.3f,%.3f 0 0,1 %.3f,20 A %.3f,%.3f 0 0,0 30,20 A %.3f,%.3f 0 0,1 %.3f,20 Z" fill="#CD2E3A"/>'
    % (30 - R, R, R, 30 + R, R / 2, R / 2, R / 2, R / 2, 30 - R) +
    '</g>')

# 卦（3本の棒）。True=陽（1本）／False=陰（2本に割る）
TRIGRAMS = {
    "geon": [True, True, True],      # ☰ 左上
    "gam":  [False, True, False],    # ☵ 右上
    "ri":   [True, False, True],     # ☲ 左下
    "gon":  [False, False, False],   # ☷ 右下
}
bar_w, bar_h, gap = R * 1.5, R * 0.22, R * 0.16
corners = [("geon", -1, -1), ("gam", 1, -1), ("ri", -1, 1), ("gon", 1, 1)]
tri = []
for name, sx, sy in corners:
    cx, cy = 30 + sx * W * 0.30, 20 + sy * H * 0.30
    # 棒は中心へ向かう線に直交させる
    rot = math.degrees(math.atan2(cy - 20, cx - 30)) + 90
    g = ['<g transform="translate(%.3f %.3f) rotate(%.2f)">' % (cx, cy, rot)]
    for i, solid in enumerate(TRIGRAMS[name]):
        y = (i - 1) * (bar_h + gap) - bar_h / 2
        if solid:
            g.append('<rect x="%.3f" y="%.3f" width="%.3f" height="%.3f" fill="#000"/>'
                     % (-bar_w / 2, y, bar_w, bar_h))
        else:
            half = bar_w * 0.42
            g.append('<rect x="%.3f" y="%.3f" width="%.3f" height="%.3f" fill="#000"/>'
                     % (-bar_w / 2, y, half, bar_h))
            g.append('<rect x="%.3f" y="%.3f" width="%.3f" height="%.3f" fill="#000"/>'
                     % (bar_w / 2 - half, y, half, bar_h))
    g.append('</g>')
    tri.append("".join(g))
save("ko", '<rect width="60" height="40" fill="#fff"/>' + taegeuk + "".join(tri))

# ── フランス ───────────────────────────────────────────────────────────
save("fr",
     '<rect width="20" height="40" fill="#002395"/>'
     '<rect x="20" width="20" height="40" fill="#fff"/>'
     '<rect x="40" width="20" height="40" fill="#ED2939"/>')

# ── スペイン（国民旗・紋章なし） ───────────────────────────────────────
save("es",
     '<rect width="60" height="40" fill="#AA151B"/>'
     '<rect y="10" width="60" height="20" fill="#F1BF00"/>')

# ── タイ ───────────────────────────────────────────────────────────────
# 赤・白・紺・白・赤（1:1:2:1:1）
u = H / 6.0
save("th",
     '<rect width="60" height="40" fill="#A51931"/>'
     '<rect y="%.3f" width="60" height="%.3f" fill="#F4F5F8"/>' % (u, u) +
     '<rect y="%.3f" width="60" height="%.3f" fill="#2D2A4A"/>' % (2 * u, 2 * u) +
     '<rect y="%.3f" width="60" height="%.3f" fill="#F4F5F8"/>' % (4 * u, u))

print(u"国旗SVGを %s に出力しました" % OUT)
