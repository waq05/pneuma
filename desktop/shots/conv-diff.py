"""对比两张自检截图的差异区域：用来确认「聚焦后编辑按钮浮出」真的画出来了，
以及差异是不是落在量到的按钮坐标上（CSS px × 设备缩放）。

用法：python shots/conv-diff.py a.png b.png
"""
import sys

from PIL import Image, ImageChops

a = Image.open(sys.argv[1]).convert('RGB')
b = Image.open(sys.argv[2]).convert('RGB')
print(f'{sys.argv[1]}: {a.size}, {sys.argv[2]}: {b.size}')
if a.size != b.size:
    print('尺寸不同，直接报差异')
    raise SystemExit(0)
diff = ImageChops.difference(a, b)
bbox = diff.getbbox()
print('差异区域(设备像素):', bbox)
# 设备缩放 1.5：换成 CSS px 更方便跟 getBoundingClientRect 对
if bbox is not None:
    print('差异区域(CSS px, ÷1.5):', tuple(round(v / 1.5) for v in bbox))
hist = diff.convert('L').histogram()
print('非零像素数:', sum(hist[1:]))
