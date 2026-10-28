"""从用户给的 dsh 设置截图里取样配色（PNG 无损，取到的是真实像素值）。

坐标系：截图原始尺寸见下；下面这些点是按预览图（1624 宽）标注后换算到原始的。
只做取样与打印，不改任何东西。
"""
from PIL import Image

SRC = r"C:\Users\waq\.dsh\attachments\v1\objects\38\38a139a8ef3d3377135628058646bce16f6f14747d2569028b6fa4274f6826e8"
PREVIEW_W = 1624.0

img = Image.open(SRC).convert("RGB")
W, H = img.size
scale = W / PREVIEW_W
print(f"原始尺寸 {W}x{H}，预览换算比例 {scale:.4f}")

# (名字, 预览图 x, 预览图 y)
POINTS = [
    ("设置卡片底（空白区）", 700, 760),
    ("左侧导航栏底", 420, 760),
    ("导航选中行底（通用设置）", 420, 281),
    ("导航未选行底（账号与余额）", 420, 232),
    ("行间分隔线", 900, 330),
    ("下拉控件底（仅可查看）", 1200, 228),
    ("分段控件选中（深色）", 930, 447),
    ("分段控件未选（浅色）", 690, 447),
    ("对话框外窗口底（dsh 主界面）", 1560, 60),
    ("左侧边栏底（dsh 会话列表）", 120, 700),
    ("标题字（设置）", 366, 118),
    ("说明字（选择新会话的默认权限模式）", 660, 247),
    ("按钮底（打开配置文件）", 1197, 121),
    ("开关滑块（显示代码工作视图）", 1256, 888),
]


def hexof(x: int, y: int) -> str:
    r, g, b = img.getpixel((x, y))
    return f"#{r:02x}{g:02x}{b:02x}"


print("\n点采样：")
for name, px, py in POINTS:
    x, y = int(px * scale), int(py * scale)
    print(f"  {name:<28} ({px},{py}) → {hexof(x, y)}")

print("\n区域统计（每个区域取平均与最常见色）：")
REGIONS = [
    ("设置卡片底", 600, 700, 900, 780),
    ("左侧导航栏", 340, 700, 460, 780),
    ("导航选中行", 350, 265, 500, 296),
    ("主窗口底", 1500, 40, 1600, 90),
    ("下拉控件底", 1150, 215, 1250, 245),
]
for name, x1, y1, x2, y2 in REGIONS:
    box = (int(x1 * scale), int(y1 * scale), int(x2 * scale), int(y2 * scale))
    crop = img.crop(box)
    pixels = list(crop.getdata())
    n = len(pixels)
    avg = tuple(sum(p[i] for p in pixels) // n for i in range(3))
    common = max(set(pixels), key=pixels.count)
    print(f"  {name:<12} 平均 #{avg[0]:02x}{avg[1]:02x}{avg[2]:02x} / 最常见 #{common[0]:02x}{common[1]:02x}{common[2]:02x}")

# 找出对话框区域里出现最多的若干颜色（用来确认底色与面板色的主调）
print("\n对话框区域颜色频次前 12：")
box = (int(300 * scale), int(80 * scale), int(1310 * scale), int(1000 * scale))
crop = img.crop(box).convert("RGB")
small = crop.resize((crop.width // 2, crop.height // 2))
counts = {}
for p in small.getdata():
    counts[p] = counts.get(p, 0) + 1
for color, times in sorted(counts.items(), key=lambda kv: -kv[1])[:12]:
    print(f"  #{color[0]:02x}{color[1]:02x}{color[2]:02x}  ×{times}")
