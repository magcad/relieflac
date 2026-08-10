"""Rend un aperçu colorié de la grille, pour contrôle visuel hors application.

    python tools/preview_grid.py [cote_m_ngf]

Sans argument, utilise la cote courante de data/level.json.
Sortie : data/preview.png
"""

from __future__ import annotations

import json
import sys

import numpy as np
from PIL import Image, ImageDraw

from common import DATA_DIR

# Paliers par défaut de l'application (profondeur en m → couleur RVB).
STOPS = [
    (0.0, (122, 0, 0)),
    (1.0, (224, 27, 27)),
    (3.0, (34, 160, 44)),
    (10.0, (0, 0, 0)),
]
EMERGED = (138, 106, 79)


def ramp(depth: np.ndarray) -> np.ndarray:
    """Interpolation linéaire entre paliers (approximation RVB de la rampe OKLab)."""
    height, width = depth.shape
    out = np.zeros((height, width, 3), dtype=np.float64)

    below = depth <= STOPS[0][0]
    out[below] = STOPS[0][1]
    out[depth >= STOPS[-1][0]] = STOPS[-1][1]

    for (d0, c0), (d1, c1) in zip(STOPS, STOPS[1:]):
        band = (depth > d0) & (depth < d1)
        if not band.any():
            continue
        ratio = ((depth[band] - d0) / (d1 - d0))[:, None]
        out[band] = np.array(c0) * (1 - ratio) + np.array(c1) * ratio

    return out


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

    rgb = ramp(np.nan_to_num(depth, nan=0.0))
    rgb[np.isfinite(depth) & (depth <= 0)] = EMERGED
    rgb[~valid] = (255, 255, 255)

    preview = Image.fromarray(rgb.astype(np.uint8), mode="RGB")
    draw = ImageDraw.Draw(preview)
    draw.text((12, 12), f"cote {level:.2f} m NGF", fill=(255, 255, 255))

    path = DATA_DIR / "preview.png"
    preview.save(path)

    wet = np.isfinite(depth) & (depth > 0)
    dry = np.isfinite(depth) & (depth <= 0)
    cell_area = meta["resolution_ground_m"] ** 2
    print(f"cote {level:.2f} m NGF")
    print(f"  surface en eau : {wet.sum() * cell_area / 1e6:.2f} km²")
    print(f"  fond émergé    : {dry.sum() * cell_area / 1e6:.2f} km²")
    if wet.any():
        print(f"  profondeur max : {np.nanmax(depth):.1f} m · "
              f"moyenne {depth[wet].mean():.1f} m")
    print(f"→ {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
