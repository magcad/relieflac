"""Rend un aperçu colorié de la grille, pour contrôle visuel hors application.

    python tools/preview_grid.py [cote_m_ngf]

Sans argument, utilise la cote courante de data/level.json. La rampe est celle de
config/palette.json, interpolée en OKLab — le rendu est donc celui de l'application.

Sortie : data/preview.png
"""

from __future__ import annotations

import json
import sys

import numpy as np
from PIL import Image

from common import DATA_DIR
from palette import build_lut, hex_to_rgb, load_palette


def main() -> int:
    with (DATA_DIR / "bed.json").open(encoding="utf-8") as fh:
        meta = json.load(fh)

    if len(sys.argv) > 1:
        level = float(sys.argv[1])
    else:
        with (DATA_DIR / "level.json").open(encoding="utf-8") as fh:
            level = float(json.load(fh)["level_m_ngf"])

    image = np.array(Image.open(DATA_DIR / "bed.png").convert("RGBA"))
    r, g, b, a = (image[..., i].astype(np.int64) for i in range(4))
    z = meta["encoding"]["base"] + (r * 65536 + g * 256 + b) * meta["encoding"]["interval"]

    valid = a > 0
    depth = np.where(valid, level - z, np.nan)

    palette = load_palette()
    lut, depth_max = build_lut(palette)
    ratio = np.clip(np.nan_to_num(depth, nan=0.0) / depth_max, 0.0, 1.0)
    rgb = lut[np.rint(ratio * (len(lut) - 1)).astype(np.int32)]

    emerged = np.rint(np.array(hex_to_rgb(palette["emerged_color"])) * 255).astype(np.uint8)
    rgb[valid & (depth <= 0)] = emerged
    rgb[~valid] = (255, 255, 255)

    path = DATA_DIR / "preview.png"
    Image.fromarray(rgb, mode="RGB").save(path)

    wet = valid & (depth > 0)
    dry = valid & (depth <= 0)
    cell = meta["resolution_ground_m"] ** 2
    print(f"cote {level:.2f} m NGF · rampe 0 → {depth_max:g} m")
    print(f"  surface en eau : {wet.sum() * cell / 1e6:.2f} km²")
    print(f"  fond émergé    : {dry.sum() * cell / 1e6:.2f} km²")
    if wet.any():
        print(f"  profondeur max : {np.nanmax(depth):.1f} m · moyenne {depth[wet].mean():.1f} m")
        deep = (depth > depth_max) & wet
        print(f"  au-delà de la rampe ({depth_max:g} m) : "
              f"{deep.sum() / max(wet.sum(), 1) * 100:.1f} % de la surface en eau")
    print(f"→ {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
