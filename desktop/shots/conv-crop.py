"""从自检截图里裁一小块并放大：用来肉眼确认按钮真的画在气泡外面。

用法：python shots/conv-crop.py 图.png 出图.png x0 y0 x1 y1 [放大倍数]
坐标按 CSS px 给（截图是 1.5 倍设备像素，脚本自己换算）。
"""
import sys

from PIL import Image

src, dst, x0, y0, x1, y1 = sys.argv[1], sys.argv[2], *[int(v) for v in sys.argv[3:7]]
scale = int(sys.argv[7]) if len(sys.argv) > 7 else 1
dpr = 1.5

im = Image.open(src).convert('RGB')
box = (round(x0 * dpr), round(y0 * dpr), round(x1 * dpr), round(y1 * dpr))
crop = im.crop(box)
if scale != 1:
    crop = crop.resize((crop.width * scale, crop.height * scale), Image.NEAREST)
crop.save(dst)
print(f'{dst} {crop.size} 来自 {src} 的 CSS 区域 {box}')
