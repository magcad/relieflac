"""Compare plusieurs schémas de couleurs sur un même extrait du lac.

Sert à trancher la question de lisibilité : un dégradé continu cache les transitions,
là où des bandes discrètes créent des bords que l'œil détecte immédiatement — c'est le
principe des cartes marines (norme S-52, cartes Garmin BlueChart, Navionics).

Sortie : data/comparaison_palettes.png
"""

from __future__ import annotations

import json

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from common import DATA_DIR
from palette import build_lut, hex_to_rgb, load_palette

# Extrait centré sur le bassin est, où les îlots découverts sont les plus nombreux.
CROP = (690, 40, 1228, 760)


def rgb(value: str) -> np.ndarray:
    return np.rint(np.array(hex_to_rgb(value)) * 255).astype(np.uint8)


def render_continuous(depth, valid, palette):
    lut, depth_max = build_lut(palette)
    ratio = np.clip(np.nan_to_num(depth, nan=0.0) / depth_max, 0.0, 1.0)
    out = lut[np.rint(ratio * (len(lut) - 1)).astype(np.int32)]
    out[valid & (depth <= 0)] = rgb(palette["emerged_color"])
    return out


def render_bands(depth, valid, bands, emerged_colour, outline=True):
    """Bandes discrètes : `bands` est une liste de (profondeur_max, couleur)."""
    out = np.zeros(depth.shape + (3,), dtype=np.uint8)
    previous = 0.0
    index = np.zeros(depth.shape, dtype=np.int16)

    for level, (limit, colour) in enumerate(bands, start=1):
        selection = valid & (depth > previous) & (depth <= limit)
        out[selection] = rgb(colour)
        index[selection] = level
        previous = limit

    deepest = valid & (depth > previous)
    out[deepest] = rgb(bands[-1][1])
    index[deepest] = len(bands)

    emerged = valid & (depth <= 0)
    out[emerged] = rgb(emerged_colour)
    index[emerged] = 0

    if outline:
        # Trait de séparation entre bandes : l'œil lit un bord, pas un dégradé.
        edge = np.zeros(depth.shape, dtype=bool)
        edge[:-1, :] |= index[:-1, :] != index[1:, :]
        edge[:, :-1] |= index[:, :-1] != index[:, 1:]
        out[edge & valid] = (24, 32, 40)

    return out


MARINE_BANDS = [
    (1.0,  "#ff1f1f"),   # danger immédiat
    (2.0,  "#ff8a3d"),   # marge de sécurité
    (5.0,  "#1f6fb2"),   # eau peu profonde — bleu le plus soutenu
    (10.0, "#4b9fd5"),
    (20.0, "#9fcbe8"),
    (99.0, "#e8f3fb"),   # eau profonde — quasi blanc
]

REDGREEN_BANDS = [
    (1.0,  "#c1121f"),
    (2.0,  "#f06a2a"),
    (3.0,  "#e0c020"),
    (6.0,  "#22a02c"),
    (12.0, "#14722a"),
    (20.0, "#0e4f52"),
    (99.0, "#08262f"),
]


def label(image: Image.Image, text: str) -> None:
    draw = ImageDraw.Draw(image)
    try:
        font = ImageFont.truetype("arialbd.ttf", 22)
    except OSError:
        font = ImageFont.load_default()
    box = draw.textbbox((0, 0), text, font=font)
    draw.rectangle((0, 0, box[2] + 24, box[3] + 20), fill=(16, 22, 28))
    draw.text((12, 8), text, fill=(255, 255, 255), font=font)


def main() -> int:
    with (DATA_DIR / "bed.json").open(encoding="utf-8") as fh:
        meta = json.load(fh)
    with (DATA_DIR / "level.json").open(encoding="utf-8") as fh:
        level = float(json.load(fh)["level_m_ngf"])

    image = np.array(Image.open(DATA_DIR / "bed.png").convert("RGBA"))
    r, g, b, a = (image[..., i].astype(np.int64) for i in range(4))
    z = meta["encoding"]["base"] + (r * 65536 + g * 256 + b) * meta["encoding"]["interval"]

    left, top, right, bottom = CROP
    valid = (a > 0)[top:bottom, left:right]
    depth = np.where(valid, level - z[top:bottom, left:right], np.nan)

    palette = load_palette()
    panels = [
        ("1 · Dégradé continu (actuel)", render_continuous(depth, valid, palette)),
        ("2 · Bandes façon carte marine", render_bands(depth, valid, MARINE_BANDS, "#c8a165")),
        ("3 · Bandes en rouge / vert", render_bands(depth, valid, REDGREEN_BANDS, "#c8a165")),
    ]

    height, width = depth.shape
    gap = 14
    canvas = Image.new("RGB", (width * len(panels) + gap * (len(panels) - 1), height), (255, 255, 255))
    for index, (title, pixels) in enumerate(panels):
        pixels = pixels.copy()
        pixels[~valid] = (255, 255, 255)
        panel = Image.fromarray(pixels, mode="RGB")
        label(panel, title)
        canvas.paste(panel, (index * (width + gap), 0))

    path = DATA_DIR / "comparaison_palettes.png"
    canvas.save(path)

    emerged = valid & (depth <= 0)
    shallow = valid & (depth > 0) & (depth <= 2)
    cell = meta["resolution_ground_m"] ** 2
    print(f"extrait du bassin est · cote {level:.2f} m NGF")
    print(f"  fond émergé      : {emerged.sum() * cell / 1e4:.1f} ha")
    print(f"  moins de 2 m     : {shallow.sum() * cell / 1e4:.1f} ha")
    print(f"→ {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
