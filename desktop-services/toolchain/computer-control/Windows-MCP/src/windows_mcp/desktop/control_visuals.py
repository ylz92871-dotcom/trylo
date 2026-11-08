"""Trylo's gold activity halo and receipt cursor, in physical screen pixels."""

import math
import os
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

GOLD = (232, 189, 101)  # #e8bd65 — shared with the native browser cursor
INK = (59, 43, 19)
IVORY = (255, 247, 221)


def render_control_banner(scale=1.0, *, escape_available=True):
    """The approved top-centred stop control, at the monitor's physical DPI."""
    def px(value):
        return round(value * scale)

    font_path = Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts" / "msyh.ttc"
    font = ImageFont.truetype(str(font_path), px(12))
    small = ImageFont.truetype(str(font_path), px(11))
    label = "Trylo 正在操控你的电脑"
    text_width = math.ceil(font.getlength(label))
    width = px(13 + 23 + 10 + 15 + 14 + 25 + 6 + 24 + 14) + text_width
    pad, height = px(6), px(44)
    image = Image.new("RGBA", (width + 2 * pad, height + 2 * pad))
    shadow = Image.new("RGBA", image.size)
    ImageDraw.Draw(shadow).rounded_rectangle((pad, pad + px(2), pad + width, pad + height + px(2)), radius=px(22), fill=(0, 0, 0, 65))
    image = shadow.filter(ImageFilter.GaussianBlur(px(3)))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((pad, pad, pad + width, pad + height), radius=px(22), fill="#202020", outline="#3e3e3e", width=max(1, px(1)))
    logo = Image.open(Path(__file__).with_name("assets") / "trylo-control-logo.png").convert("RGBA").resize((px(23), px(23)), Image.Resampling.LANCZOS)
    image.alpha_composite(logo, (pad + px(13), pad + px(10)))
    x, centre = pad + px(46), pad + height // 2
    draw.text((x, centre), label, font=font, fill="#f4f4f4", anchor="lm")
    separator = x + text_width + px(15)
    draw.line((separator, pad + px(10), separator, pad + px(34)), fill="#484848", width=max(1, px(1)))
    if escape_available:
        left = separator + px(14)
        draw.rounded_rectangle((left, pad + px(12), left + px(25), pad + px(32)), radius=px(4), fill="#303030", outline="#606060")
        draw.text((left + px(12.5), centre), "Esc", font=small, fill="#f1f1f1", anchor="mm")
        draw.text((left + px(31), centre), "退出", font=font, fill="#b6b6b6", anchor="lm")
    else:
        draw.text((separator + px(14), centre), "点击退出", font=font, fill="#b6b6b6", anchor="lm")
    return image


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
