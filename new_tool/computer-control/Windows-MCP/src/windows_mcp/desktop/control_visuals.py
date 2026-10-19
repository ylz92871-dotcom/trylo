"""Trylo's gold activity halo and receipt cursor, in physical screen pixels."""

import math

from PIL import Image, ImageDraw, ImageFilter

GOLD = (232, 189, 101)  # #e8bd65 — shared with the native browser cursor
INK = (59, 43, 19)
IVORY = (255, 247, 221)


def render_halo(width: int, height: int, scale: float = 1.0) -> Image.Image:
    """Transparent centre, fine inner edge, broad restrained inward bloom."""
    image = Image.new("RGBA", (width, height))
    draw = ImageDraw.Draw(image)
    depth = min(round(56 * scale), width // 2, height // 2)
    for inset in range(depth):
        alpha = round(108 * math.exp(-inset / (13 * scale)))
        draw.rectangle((inset, inset, width - inset - 1, height - inset - 1),
                       outline=(*GOLD, alpha))
    if depth:
        draw.rectangle((0, 0, width - 1, height - 1), outline=(*IVORY, 190),
                       width=max(1, round(scale)))
    return image


def render_cursor(scale: float = 1.0, pulse: float | None = None) -> Image.Image:
    """Hotspot is (24,24) DIP. The visual never replaces the system cursor."""
    # Supersample to retain a clean, recognisable tip at fractional Windows DPI.
    factor = 3
    size = max(1, round(88 * scale))
    unit = scale * factor
    image = Image.new("RGBA", (size * factor, size * factor))
    draw = ImageDraw.Draw(image)
    x = y = 24 * unit
    if pulse is not None and 0 <= pulse < 1:
        radius = (7 + 15 * pulse) * unit
        draw.ellipse((x-radius, y-radius, x+radius, y+radius),
                     outline=(*GOLD, round(225 * (1-pulse))), width=max(1, round(2*unit)))
    points = [(0, 0), (0.6, 21.5), (5.8, 16.4), (10, 25.2),
              (13.6, 23.4), (9.4, 14.6), (17.4, 14.4)]
    points = [(x + a*unit, y + b*unit) for a, b in points]
    shadow = Image.new("RGBA", image.size)
    ImageDraw.Draw(shadow).polygon([(a, b+1.5*unit) for a, b in points],
                                  fill=(*INK, 100))
    image = Image.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(1.5*unit)), image)
    draw = ImageDraw.Draw(image)
    draw.line(points + [points[0]], fill=(*IVORY, 250), width=max(1, round(2.4*unit)),
              joint="curve")
    mask = Image.new("L", image.size)
    ImageDraw.Draw(mask).polygon(points, fill=255)
    gradient = Image.new("RGBA", image.size)
    gradient_draw = ImageDraw.Draw(gradient)
    stops = [(255, 239, 179), GOLD, (206, 146, 54)]
    for row in range(round(26*unit)+1):
        progress = min(1.0, row/(25.2*unit)) * 2
        segment = min(1, int(progress))
        blend = progress-segment
        color = tuple(round(a+(b-a)*blend) for a, b in zip(stops[segment], stops[segment+1]))
        gradient_draw.line((0, round(y)+row, image.width, round(y)+row), fill=(*color, 255))
    gradient.putalpha(mask)
    image = Image.alpha_composite(image, gradient)
    draw = ImageDraw.Draw(image)
    draw.line(points + [points[0]], fill=(117, 78, 24, 255),
              width=max(1, round(0.75*unit)), joint="curve")
    # A restrained bevel catches the light along the long leading edge.
    draw.line([(x+0.8*unit, y+2.3*unit), (x+1.3*unit, y+18.7*unit)],
              fill=(*IVORY, 215), width=max(1, round(0.65*unit)))
    return image.resize((size, size), Image.Resampling.LANCZOS)


def premultiplied(image: Image.Image) -> bytes:
    # Pillow premultiplies in native code; no Python loop across desktop pixels.
    return image.convert("RGBa").tobytes("raw", "BGRa")
