"""把手对齐的像素级取证：在 tf-handle.png 上找出那根 2px 高亮竖条落在哪一列像素，
再和 .chat-inner 左右缘（DOM 读数 × 屏幕缩放）比，并出一张放大标注图。

为什么要它：验收口径是「把手中心与正文列左右缘的 x 差 ≤2px」，DOM 读数在
tf-handle.log / tf-handle.result.json 里；这份脚本不信 DOM，直接从渲染出来的像素里找那根
竖条，两条读数对上了才算数。竖条用的是滚动条那个灰（--dsc-scrollbar-thumb），很淡，
所以标注图把对应的一条裁出来放大 2 倍并画上红线（红线的位置 = DOM 量到的列缘）。

用法：python tf-handle-zoom.py
"""
import json
from pathlib import Path

from PIL import Image, ImageDraw

SHOTS = Path(r"D:\dsc\desktop\shots")
SRC = SHOTS / "tf-handle.png"
RESULT = SHOTS / "tf-handle.result.json"
DST = SHOTS / "tf-handle-zoom.png"

# 截图是 1.5 倍 DPI 的（窗口 CSS px → 图像 px）
SCALE = 1.5
HALF = 40
TOP, BOTTOM = 200, 1000
ZOOM = 2

img = Image.open(SRC).convert("RGB")
pixels = img.load()
at_default = json.loads(RESULT.read_text(encoding="utf-8"))["atDefault"]
edges = {"left": round(at_default["inner"]["l"] * SCALE), "right": round(at_default["inner"]["r"] * SCALE)}


def profile(edge_x: int) -> dict:
    """在列缘两侧各 4px 的窗口里逐列量平均亮度。

    为什么只取这么窄一条：正文列的内容左缘在 24px 内缩之后，离列缘还有 36px（截图像素），
    这个窗口里除了那根 2px 高亮竖条就只有底色，量出来的峰值就是竖条自己。
    """
    rows = range(TOP, BOTTOM)
    means = {}
    for x in range(edge_x - 6, edge_x + 7):
        total = 0
        for y in rows:
            r, g, b = pixels[x, y]
            total += r + g + b
        means[x] = round(total / (len(rows) * 3), 2)
    peak_x = max(means, key=lambda x: means[x])
    return {
        "columnEdgePx": edge_x,
        "profile": means,
        "peakColumnPx": peak_x,
        "deltaPx": peak_x - edge_x,
        "deltaCssPx": round((peak_x - edge_x) / SCALE, 2),
        "backgroundMean": round(sum(means.values()) / len(means), 2),
        "peakMean": means[peak_x],
    }


report = {"scale": SCALE, "atDefault": at_default, "band": [TOP, BOTTOM]}
crops = []
for name, edge_x in edges.items():
    report[name] = profile(edge_x)
    box = (edge_x - HALF, TOP, edge_x + HALF, BOTTOM)
    crop = img.crop(box).resize(((HALF * 2) * ZOOM, (BOTTOM - TOP) * ZOOM), Image.NEAREST)
    draw = ImageDraw.Draw(crop)
    marker_x = HALF * ZOOM
    for y in range(0, crop.height, 10):
        draw.point((marker_x, y), fill=(255, 80, 80))
        draw.point((marker_x - 1, y), fill=(255, 80, 80))
    crops.append(crop)

GAP = 24
out = Image.new("RGB", (crops[0].width + GAP + crops[1].width, crops[0].height), (24, 26, 32))
out.paste(crops[0], (0, 0))
out.paste(crops[1], (crops[0].width + GAP, 0))
out.save(DST)

report["note"] = "红线 = .chat-inner 的左右缘（DOM 读数 ×1.5）；左图是左缘、右图是右缘"
(SHOTS / "tf-handle-pixels.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps(report, ensure_ascii=False))
print(f"wrote {DST} ({out.width}x{out.height})")
