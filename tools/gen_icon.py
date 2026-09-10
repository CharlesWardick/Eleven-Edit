"""
Generates Eleven Edit's app icon — "Rack Rails" concept (two vertical
brushed-silver rails standing in for "1 1", one amber LED, rack-ear screw
dots at the corners) — drawn NATIVELY at each target size rather than
downsampled from one large image, so the rails stay crisp instead of
blurring at 16px (the exact legibility concern raised when picking this
concept).

Output: assets/icon.ico (multi-size: 16/32/48/256) and assets/icon.png
(512, for Linux/README use).
"""
from PIL import Image, ImageDraw
import math
import os

# Paths are relative to this script (was a hardcoded /home/user path — fixed
# 2026-09-10 so it runs anywhere; gen_icns.py also imports make_icon from here).
HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.normpath(os.path.join(HERE, "..", "assets"))

BG_TOP    = (58, 58, 58, 255)
BG_BOTTOM = (22, 22, 22, 255)
RAIL_TOP    = (201, 201, 201, 255)
RAIL_BOTTOM = (122, 122, 122, 255)
RAIL_EDGE   = (0, 0, 0, 70)
AMBER_CORE  = (240, 185, 85, 255)
AMBER_GLOW  = (232, 168, 60, 110)
SCREW       = (0, 0, 0, 90)


def rounded_mask(size, radius):
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return mask


def vgrad(size, top, bottom):
    """Vertical gradient RGBA image, size x size."""
    img = Image.new("RGBA", (size, size))
    px = img.load()
    for y in range(size):
        t = y / max(1, size - 1)
        r = int(top[0] + (bottom[0] - top[0]) * t)
        g = int(top[1] + (bottom[1] - top[1]) * t)
        b = int(top[2] + (bottom[2] - top[2]) * t)
        a = int(top[3] + (bottom[3] - top[3]) * t)
        for x in range(size):
            px[x, y] = (r, g, b, a)
    return img


def draw_rail(canvas, size, left_frac, top_frac, w_frac, h_frac, with_flag=True):
    """Draws one numeral-'1' silhouette (stem + base foot, plus a top flag
    at larger sizes) in the brushed-metal rail material — two plain
    identical bars read as 'II', not '11' (caught after the first render),
    so the shape itself now carries the numeral rather than relying on
    there being exactly two of them."""
    x0 = round(size * left_frac)
    y0 = round(size * top_frac)
    x1 = round(size * (left_frac + w_frac))
    y1 = round(size * (top_frac + h_frac))
    rail_w = x1 - x0
    rail_h = y1 - y0

    # Glyph outline as fractions of the LOCAL box (0..1 x, 0..1 y).
    stem_l, stem_r = 0.34, 0.68
    foot_top = 0.80
    if with_flag:
        pts_frac = [
            (stem_r, 0.0), (stem_l, 0.0),
            (0.02, 0.24), (stem_l, 0.36),
            (stem_l, foot_top), (0.04, foot_top),
            (0.04, 1.0), (0.96, 1.0),
            (0.96, foot_top), (stem_r, foot_top),
        ]
    else:
        # Smallest sizes: skip the flag notch (too fine to survive
        # downsampling) but KEEP the base foot — that alone is enough to
        # read as "1" rather than a plain bar, per size testing.
        pts_frac = [
            (stem_r, 0.0), (stem_l, 0.0),
            (stem_l, foot_top), (0.04, foot_top),
            (0.04, 1.0), (0.96, 1.0),
            (0.96, foot_top), (stem_r, foot_top),
        ]
    pts = [(px * rail_w, py * rail_h) for px, py in pts_frac]

    rail_img = vgrad(max(rail_w, rail_h), RAIL_TOP, RAIL_BOTTOM).resize((rail_w, rail_h))
    mask = Image.new("L", (rail_w, rail_h), 0)
    md = ImageDraw.Draw(mask)
    md.polygon(pts, fill=255)
    canvas.paste(rail_img, (x0, y0), mask)
    if size >= 48:
        d = ImageDraw.Draw(canvas)
        d.polygon([(x0 + px, y0 + py) for px, py in pts], outline=RAIL_EDGE, width=max(1, size // 170))


def draw_led(canvas, size, cx_frac, cy_frac, r_frac, glow=True):
    cx, cy = size * cx_frac, size * cy_frac
    r = size * r_frac
    if glow and size >= 32:
        glow_r = r * 2.1
        glow_img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        gd = ImageDraw.Draw(glow_img)
        gd.ellipse([cx - glow_r, cy - glow_r, cx + glow_r, cy + glow_r], fill=AMBER_GLOW)
        glow_img = glow_img.filter(__import__("PIL.ImageFilter", fromlist=["GaussianBlur"]).GaussianBlur(radius=max(1, size * 0.03)))
        canvas.alpha_composite(glow_img)
    d = ImageDraw.Draw(canvas)
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=AMBER_CORE)


def draw_screw(canvas, size, cx_frac, cy_frac, r_frac):
    cx, cy = size * cx_frac, size * cy_frac
    r = size * r_frac
    d = ImageDraw.Draw(canvas)
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=SCREW)


def make_icon(size):
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    radius = round(size * 0.22)
    mask = rounded_mask(size, radius)
    bg = vgrad(size, BG_TOP, BG_BOTTOM)
    canvas.paste(bg, (0, 0), mask)

    # centered "1 1" (fixed after the off-center catch: pair spans
    # 28.5%-71.5%); flag notch dropped below 32px, base foot always kept
    flag = size >= 32
    draw_rail(canvas, size, 0.285, 0.19, 0.19, 0.62, with_flag=flag)
    draw_rail(canvas, size, 0.525, 0.19, 0.19, 0.62, with_flag=flag)

    if size >= 24:
        draw_led(canvas, size, 0.84, 0.85, 0.045, glow=(size >= 32))
    else:
        draw_led(canvas, size, 0.84, 0.85, 0.06, glow=False)

    if size >= 64:
        for (cx, cy) in [(0.135, 0.135), (0.865, 0.135), (0.135, 0.865)]:
            draw_screw(canvas, size, cx, cy, 0.028)

    return canvas


def main():
    sizes = [16, 24, 32, 48, 64, 128, 256]
    imgs = {s: make_icon(s) for s in sizes}

    # Windows .ico — multi-size, each drawn natively (not resized from one master)
    imgs[256].save(
        os.path.join(ASSETS, "icon.ico"),
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
        append_images=[imgs[16], imgs[24], imgs[32], imgs[48], imgs[64], imgs[128]],
    )

    # 512 PNG for README / Linux / store listing use
    make_icon(512).save(os.path.join(ASSETS, "icon.png"))
    print("done")


if __name__ == "__main__":
    main()
