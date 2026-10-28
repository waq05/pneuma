"""走查用：把用户截图右上/右下角裁出来放大（看状态面板胶囊在不在）。"""
import sys
from pathlib import Path
from PIL import Image

src = Path(r"C:\Users\waq\.zcode\cli\image-cache\sess_7ac1ee65-76ff-4256-a087-5714a6af4f82")
out = Path(r"D:\dsc\desktop\shots")

pairs = [
    ("i1", "image-fe3dd02a561f9b9f01d205766ae542da.png"),
    ("i2", "image-661fd52f3e40a4a16c559128931e44fe.png"),
    ("i3", "image-967d45e42bb97aee9945ebc360aaa79b.png"),
]

for tag, name in pairs:
    im = Image.open(src / name).convert("RGB")
    w, h = im.size
    print(tag, w, h)
    boxes = {
        "topright": (int(w * 0.82), 0, w, int(h * 0.22)),
        "botright": (int(w * 0.78), int(h * 0.62), w, h),
    }
    for label, box in boxes.items():
        crop = im.crop(box)
        crop = crop.resize((crop.width * 3, crop.height * 3), Image.LANCZOS)
        crop.save(out / f"b9-crop-{tag}-{label}.png")
print("ok")
