# يفصل «خ» والسهم عن خلفية الشعار ليصنع طبقة الواجهة لأيقونة أندرويد المتكيّفة.
# شغّله بعد «tauri icon» لأن ذاك يكتب فوق ic_launcher_foreground.png:
#   python scripts/android-adaptive-icon.py public/logo.png src-tauri/gen/android/app/src/main/res preview.png
# يحتاج: pip install pillow numpy
"""Split the full-bleed logo into an Android adaptive-icon foreground (glyph only) + gradient colors."""
import sys
import numpy as np
from PIL import Image

src, res_dir, preview = sys.argv[1], sys.argv[2], sys.argv[3]
im = np.asarray(Image.open(src).convert("RGBA")).astype(np.float64)
H, W = im.shape[:2]
rgb, a = im[..., :3], im[..., 3]
ys, xs = np.mgrid[0:H, 0:W]

# Fit a linear gradient to plain background pixels (opaque, saturated teal: G clearly above R)
bgmask = (a > 250) & (rgb[..., 1] - rgb[..., 0] > 60) & (rgb[..., 2] < 200)
X = np.stack([np.ones(bgmask.sum()), xs[bgmask] / W, ys[bgmask] / H], 1)
coef, *_ = np.linalg.lstsq(X, rgb[bgmask], rcond=None)
B = coef[0] + (xs / W)[..., None] * coef[1] + (ys / H)[..., None] * coef[2]

# Foreground colors: white glyph; yellow arrow (sampled from the arrow shaft)
yellow = rgb[150:250, 540:556].reshape(-1, 3)
yellow = yellow[(yellow[:, 0] > 240) & (yellow[:, 2] < 140)].mean(0)
white = np.array([255.0, 255, 255])
is_arrow = (ys < 330)[..., None]
F = np.where(is_arrow, yellow, white)

# Unmix: P = alpha*F + (1-alpha)*B  ->  least-squares alpha over channels
d = F - B
alpha = ((rgb - B) * d).sum(-1) / np.maximum((d * d).sum(-1), 1e-6)
alpha = np.clip(alpha, 0, 1)
alpha[alpha < 0.06] = 0  # drop drop-shadows / noise
alpha[a < 250] = 0  # outside the rounded square
# Arrow: keep only yellowish pixels (blue channel much lower than red)
alpha = np.where(is_arrow[..., 0] & (rgb[..., 0] - rgb[..., 2] < 20) & (alpha < 0.98), 0, alpha)

fg = np.dstack([F, alpha * 255]).clip(0, 255).astype(np.uint8)
glyph = Image.fromarray(fg, "RGBA")
bbox = glyph.getbbox()
print("glyph bbox", bbox, "yellow", yellow.round(), "coef", coef.round(1))

# Place on 108dp canvas: visible area = 72/108 of canvas, keep glyph's proportion to the icon
scale = (72 / 108)
canvas = 1024
g = glyph.resize((round(W * scale), round(H * scale)), Image.LANCZOS)
out = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
off = (canvas - g.width) // 2
out.alpha_composite(g, (off, off))
nb = out.getbbox()
# safe-zone check: 66dp circle
cx = cy = canvas / 2
corners = [(nb[0], nb[1]), (nb[2], nb[1]), (nb[0], nb[3]), (nb[2], nb[3])]
print("max corner radius / safe radius:",
      round(max(((x - cx) ** 2 + (y - cy) ** 2) ** 0.5 for x, y in corners) / (canvas * 33 / 108), 3))

for dens, px in {"mdpi": 108, "hdpi": 162, "xhdpi": 216, "xxhdpi": 324, "xxxhdpi": 432}.items():
    out.resize((px, px), Image.LANCZOS).save(f"{res_dir}/mipmap-{dens}/ic_launcher_foreground.png", optimize=True)

# Gradient colors at the visible corners (top-left / bottom-right of the icon)
tl = (coef[0]).clip(0, 255).round().astype(int)
br = (coef[0] + coef[1] + coef[2]).clip(0, 255).round().astype(int)
hexc = lambda c: "#{:02X}{:02X}{:02X}".format(*c)
print("start", hexc(tl), "end", hexc(br))

# Preview: background gradient + foreground, masked with a squircle-ish rounded rect and a circle
bg = np.zeros((canvas, canvas, 3))
t = ((xs_c := np.mgrid[0:canvas, 0:canvas])[1] + xs_c[0]) / (2 * canvas)
bg = tl[None, None] * (1 - t[..., None]) + br[None, None] * t[..., None]
full = Image.fromarray(bg.astype(np.uint8)).convert("RGBA")
full.alpha_composite(out)
crop = full.crop((round(canvas * 18 / 108),) * 2 + (round(canvas * 90 / 108),) * 2)
m = Image.new("L", crop.size, 0)
from PIL import ImageDraw
ImageDraw.Draw(m).rounded_rectangle((0, 0, crop.width, crop.height), radius=crop.width // 4, fill=255)
p1 = Image.new("RGBA", crop.size, (40, 40, 40, 255)); p1.paste(crop, mask=m)
m2 = Image.new("L", crop.size, 0); ImageDraw.Draw(m2).ellipse((0, 0, crop.width, crop.height), fill=255)
p2 = Image.new("RGBA", crop.size, (40, 40, 40, 255)); p2.paste(crop, mask=m2)
sheet = Image.new("RGBA", (crop.width * 2 + 40, crop.height), (40, 40, 40, 255))
sheet.paste(p1, (0, 0)); sheet.paste(p2, (crop.width + 40, 0))
sheet.resize((sheet.width // 3, sheet.height // 3), Image.LANCZOS).save(preview)
