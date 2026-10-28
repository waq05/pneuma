"""把「图标按钮放大前 / 后」两张自检截图裁成侧栏局部并排对比。

用法：python shots/btn-compare.py
输入：shots/btn-icons-before-dark.png、shots/btn-icons-after-dark.png
输出：shots/btn-icons-compare.png（左=改前，右=改后，同一块区域）
"""
from PIL import Image, ImageDraw

SHOTS = r'D:\dsc\desktop\shots'
# 侧栏宽度约 237 CSS px，截图是 1.5 倍 DPR → 355px；上下取品牌行 + 前几条会话行
BOX = (0, 0, 372, 480)
SCALE = 2  # 放大两倍，好把 24px → 26/28px 的差别看出来

before = Image.open(f'{SHOTS}\\btn-icons-before-dark.png').convert('RGB').crop(BOX)
after = Image.open(f'{SHOTS}\\btn-icons-after-dark.png').convert('RGB').crop(BOX)

w, h = before.size
gap, label = 16, 34
canvas = Image.new('RGB', (w * 2 + gap, h + label), (24, 24, 28))
canvas.paste(before, (0, label))
canvas.paste(after, (w + gap, label))
canvas = canvas.resize(((w * 2 + gap) * SCALE, (h + label) * SCALE), Image.LANCZOS)

draw = ImageDraw.Draw(canvas)
draw.text((8 * SCALE, 10 * SCALE), 'BEFORE  icon-btn 24px  row-btn 24px', fill=(255, 210, 120))
draw.text(((w + gap + 8) * SCALE, 10 * SCALE), 'AFTER  icon-btn 26px  row-btn 28px', fill=(130, 230, 160))
# 两条分割线：侧栏右缘
draw.line([(w * SCALE, 0), (w * SCALE, canvas.size[1])], fill=(70, 70, 80))
draw.line([((w + gap) * SCALE, 0), ((w + gap) * SCALE, canvas.size[1])], fill=(70, 70, 80))

out = f'{SHOTS}\\btn-icons-compare.png'
canvas.save(out)
print(f'wrote {out} {canvas.size}')
