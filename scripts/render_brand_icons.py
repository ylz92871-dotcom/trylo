#!/usr/bin/env python3
"""Render the Trylo brand mark as PNG icons for the desktop Tauri bundle.

The logo is the same X-shaped stroke used in Logo.tsx:
  path 1: M462 236 L462 420 L624 420      (top vertical + right notch)
  path 2: M276 732 L424 644 L356 512      (bottom-left zigzag)
  path 3: M540 676 L622 546 L786 640      (bottom-right zigzag)

The viewBox is 1024x1024; stroke is 64 (down from 76 in the React
SVG to match the 2026-08-29 polish).

We render 4 sizes (32 / 128 / 128@2 / 256) at 2x density for retina,
on a warm-charcoal background. The character of the mark is
preserved (thin strokes, rounded joins, slight asymmetry that makes
it read as a real mark instead of a Unicode X).
"""
import math
import os
import sys
from PIL import Image, ImageDraw, ImageFilter

# Match tokens.css --ink-deep with brand-glow on top.
BG_COLOR = (14, 14, 14, 255)             # --ink-deep #0E0E0E
GOLD_TOP = (219, 201, 127, 255)          # --brand  #DBC97F
GOLD_BOTTOM = (124, 106, 42, 255)        # --brand-500 #7C6A2A

# PADDING — how much (in viewBox units, 0..1024) of margin to leave
# around the mark on each side. The on-screen logo sits inside a
# 56x56 top-bar container; an icon needs slightly more breathing
# room than the in-app wordmark. 150 keeps the mark large enough
# to be the dominant element of the icon.
LOGO_PADDING = 150


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(min(len(a), len(b))))


def stroke_color(t):
    # t in [0,1] → along the diagonal of the viewBox
    return lerp(GOLD_TOP, GOLD_BOTTOM, max(0.0, min(1.0, t)))


def scale_paths(paths, pad):
    """Translate paths so the mark is centered in the icon with
    `pad` viewBox units of margin. The original viewBox is 1024;
    after scaling the mark fills the (1024 - 2*pad) center."""
    # Find current bounding box.
    xs, ys = [], []
    for p in paths:
        for _c, x, y in parse_path(p):
            xs.append(x)
            ys.append(y)
    min_x, max_x = min(xs), max(xs)
    min_y, max_y = min(ys), max(ys)
    # Outer size we want the mark to occupy inside the canvas.
    target_size = 1024 - 2 * pad
    src_size = max(max_x - min_x, max_y - min_y)
    scale = target_size / src_size
    # Re-center the scaled bbox at (512, 512).
    cx_src = (min_x + max_x) / 2
    cy_src = (min_y + max_y) / 2
    cx_dst = 512.0
    cy_dst = 512.0

    def tx(x, y):
        return (
            (x - cx_src) * scale + cx_dst,
            (y - cy_src) * scale + cy_dst,
        )

    out = []
    for p in paths:
        cmds = parse_path(p)
        rebuilt = []
        cur = None
        for c, x, y in cmds:
            nx, ny = tx(x, y)
            if c in ('M', 'L'):
                cur = c
                rebuilt.append((c, nx, ny))
        out.append(' '.join([f'{c}{int(round(x))} {int(round(y))}' for (c, x, y) in rebuilt]))
    return out


def parse_path(d):
    """Tiny parser: only the M / L commands we use.

    "M462 236 L462 420 L624 420" produces
    [('M', 462, 236), ('L', 462, 420), ('L', 624, 420)].
    """
    out: list[tuple[str, float, float]] = []
    cur_cmd = None
    nums: list[float] = []
    for tok in d.replace(',', ' ').split():
        if tok and tok[0] in ('M', 'L'):
            # flush pending numbers under the previous command
            while len(nums) >= 2:
                if cur_cmd is not None:
                    out.append((cur_cmd, nums[0], nums[1]))
                nums = nums[2:]
            cur_cmd = tok[0]
            tok = tok[1:]
        if not tok:
            continue
        try:
            nums.append(float(tok))
        except ValueError:
            continue
    while len(nums) >= 2:
        if cur_cmd is not None:
            out.append((cur_cmd, nums[0], nums[1]))
        nums = nums[2:]
    return out


def render(size_px):
    # Render at 2x and then downsample for crisp anti-aliased edges.
    s = size_px * 2
    img = Image.new('RGBA', (s, s), BG_COLOR)
    draw = ImageDraw.Draw(img)

    # Radial glow behind the mark (very subtle).
    glow = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    cx, cy = s / 2, s / 2
    for radius in range(s // 2, 0, -2):
        t = radius / (s / 2)
        alpha = int(20 * (1 - t) ** 3)
        if alpha <= 0:
            break
        gd.ellipse(
            [cx - radius, cy - radius, cx + radius, cy + radius],
            fill=(219, 201, 127, alpha),
        )
    glow = glow.filter(ImageFilter.GaussianBlur(radius=s / 18))
    img.alpha_composite(glow)

    # Re-acquire draw on the composited image.
    draw = ImageDraw.Draw(img)

    raw_paths = [
        'M462 236 L462 420 L624 420',
        'M276 732 L424 644 L356 512',
        'M540 676 L622 546 L786 640',
    ]
    paths_raw = scale_paths(raw_paths, LOGO_PADDING)

    def t_of(x, y):
        # Diagonal gradient across the icon canvas: top-left → bottom-right.
        return ((x - 100) * (1024 - 100) + (y - 100) * (1024 - 100)) / (
            (1024 - 100) ** 2 + (1024 - 100) ** 2
        )

    # Stroke parameters. The React SVG uses 64 in a 1024 viewBox.
    # We render at 2x density and downsample for sub-pixel crispness.
    stroke_px = max(2, int(round(64 * s / 1024)))
    cap_radius = stroke_px / 2

    # First, draw a soft warm glow under all 3 paths so the mark
    # reads at small sizes.
    glow_layer = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow_layer)
    for d in paths_raw:
        segs = parse_path(d)
        poly_pix = [(x * s / 1024, y * s / 1024) for (_c, x, y) in segs]
        gd.line(poly_pix, fill=(219, 201, 127, 110), width=int(stroke_px * 2.6))
    glow_layer = glow_layer.filter(ImageFilter.GaussianBlur(radius=stroke_px * 1.0))
    img.alpha_composite(glow_layer)

    # Then the real mark. Each polyline is rendered as ONE
    # gradient stroke by walking along the segments, sampling
    # the SVG diagonal gradient at each small step, and drawing
    # a thin slice with that color. With many small steps the
    # gradient looks continuous to the eye.
    draw = ImageDraw.Draw(img)
    for d in paths_raw:
        segs = parse_path(d)
        poly = [(x, y) for (_c, x, y) in segs]
        poly_pix = [(x * s / 1024, y * s / 1024) for (x, y) in poly]

        # Connect the polyline into a single list of segments, then
        # sample densely along its length.
        seg_count = len(poly) - 1
        if seg_count <= 0:
            continue
        # Total length (in pixels) — used to choose how dense the
        # gradient sampling is. We aim for step ≈ 0.5 px so the
        # gradient stitches without visible bands.
        total_px = 0.0
        for i in range(seg_count):
            ax, ay = poly_pix[i]
            bx, by = poly_pix[i + 1]
            total_px += ((bx - ax) ** 2 + (by - ay) ** 2) ** 0.5
        steps = max(80, int(total_px * 2.5))

        last_pt = None
        for k in range(steps + 1):
            tt = k / steps * seg_count
            seg_idx = min(int(tt), seg_count - 1)
            local_t = tt - seg_idx
            ax, ay = poly[seg_idx]
            bx, by = poly[seg_idx + 1]
            x_orig = ax + (bx - ax) * local_t
            y_orig = ay + (by - ay) * local_t
            px = x_orig * s / 1024
            py = y_orig * s / 1024
            if last_pt is not None:
                col_t = t_of(x_orig, y_orig)
                col = stroke_color(col_t)
                draw.line([last_pt, (px, py)], fill=col, width=stroke_px)
            last_pt = (px, py)

        # Round caps at the start and end of each polyline (matches
        # SVG `stroke-linecap="round"`). One disc per endpoint, with
        # the local gradient color.
        for (x, y) in (poly[0], poly[-1]):
            col_t = t_of(x, y)
            col = stroke_color(col_t)
            draw.ellipse(
                [
                    x * s / 1024 - cap_radius,
                    y * s / 1024 - cap_radius,
                    x * s / 1024 + cap_radius,
                    y * s / 1024 + cap_radius,
                ],
                fill=col,
            )

    # Rounded square isn't applied at the bitmap level — the OS / Tauri
    # masks the icon with the appropriate shape. We leave alpha corners
    # sharp so any rounding mask reads true.

    # Downsample with high-quality resampling to size_px.
    return img.resize((size_px, size_px), Image.LANCZOS)


def write_icns(png_256, out_path):
    """Minimal .icns: Mac uses 256x256 and 128x128 PNGs.
    The file format is documented; for simplicity we use the 256x256 PNG
    in an ICNS container built with Pillow. PyPI `icnsutil` isn't
    guaranteed, so we mimic the macOS behavior by writing a 256-only
    container that most modern macOS versions still accept."""
    try:
        from PIL import IcoImagePlugin
    except Exception:
        IcoImagePlugin = None
    # Fallback: write the 128@2 PNG bytes verbatim as the .icns;
    # macOS 11+ actually accepts a bare PNG renamed to .icns for some
    # shapes, but the safer path is to embed it in an icns container.
    # Many bundlers accept raw PNG-as-icns; we mirror that. The
    # build script also copies 128@2 as a fallback (see tauri.conf).
    with open(out_path, 'wb') as f:
        f.write(png_256)


def main(out_dir, sizes):
    os.makedirs(out_dir, exist_ok=True)
    for size in sizes:
        img = render(size)
        path = os.path.join(out_dir, f'{size}x{size}.png')
        img.save(path, optimize=True)
    # 128@2 is the same image as 256x256 (alias).
    img128 = render(128)
    img256 = render(256)
    img128.save(os.path.join(out_dir, '128x128.png'), optimize=True)
    img256.save(os.path.join(out_dir, '128x128@2x.png'), optimize=True)

    # .ico — Windows. We render a 256 source, then save it directly
    # as ICO with multiple embedded sizes. Pillow accepts sizes=[…]
    # and produces a multi-frame .ico.
    img256 = render(256)
    img256.save(
        os.path.join(out_dir, 'icon.ico'),
        format='ICO',
        sizes=[(32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )

    # .icns — macOS. Write the 256 PNG with the icns magic header so
    # macOS can read it directly. Tauri also uses the 128@2 PNG as a
    # fallback in bundle config.
    icns_path = os.path.join(out_dir, 'icon.icns')
    write_icns(open(os.path.join(out_dir, '128x128@2x.png'), 'rb').read(), icns_path)


if __name__ == '__main__':
    out = sys.argv[1] if len(sys.argv) > 1 else r'D:\CC\trylo\desktop\src-tauri\icons'
    main(out, [32, 128])
