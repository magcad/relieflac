"""Compare les préréglages de config/palette.json sur un même extrait du lac.

    python tools/compare_palettes.py                 # tous les préréglages
    python tools/compare_palettes.py marine degrade  # une sélection
    python tools/compare_palettes.py --level 645     # à une autre cote

Sortie : data/comparaison_palettes.png
"""

from __future__ import annotations

import argparse
import json

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from common import DATA_DIR
from palette import load_palette, render, safety_depth
from preview_grid import load_bed

# Extrait centré sur le bassin est, où les îlots découverts sont les plus nombreux.
CROP = (690, 40, 1228, 760)


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
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("presets", nargs="*", help="préréglages à comparer")
    parser.add_argument("--level", type=float, help="cote en m NGF (défaut : cote courante)")
    args = parser.parse_args()

    bed, valid_full, meta = load_bed()
    if args.level is not None:
        level = args.level
    else:
        with (DATA_DIR / "level.json").open(encoding="utf-8") as fh:
            level = float(json.load(fh)["level_m_ngf"])

    palette = load_palette()
    names = args.presets or list(palette["presets"])

    left, top, right, bottom = CROP
    valid = valid_full[top:bottom, left:right]
    depth = np.where(valid, level - bed[top:bottom, left:right], np.nan)

    height, width = depth.shape
    gap = 14
    canvas = Image.new("RGB", (width * len(names) + gap * (len(names) - 1), height), (255, 255, 255))

    for index, name in enumerate(names):
        preset = palette["presets"][name]
        pixels = render(depth, valid, palette, name)
        pixels[~valid] = (255, 255, 255)
        panel = Image.fromarray(pixels, mode="RGB")
        active = " (actif)" if name == palette["active_preset"] else ""
        label(panel, f"{index + 1} · {preset['label']}{active}")
        canvas.paste(panel, (index * (width + gap), 0))

    path = DATA_DIR / "comparaison_palettes.png"
    canvas.save(path)

    cell = meta["resolution_ground_m"] ** 2
    safe = safety_depth(palette)
    wet = valid & (depth > 0)
    print(f"extrait du bassin est · cote {level:.2f} m NGF")
    print(f"  fond émergé              : {(valid & (depth <= 0)).sum() * cell / 1e4:5.1f} ha")
    print(f"  sous la cote de sécurité ({safe:.1f} m) : {(wet & (depth <= safe)).sum() * cell / 1e4:5.1f} ha")
    print(f"  préréglages : {', '.join(names)}")
    print(f"→ {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
