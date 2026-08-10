"""Rend un aperçu colorié de la grille, pour contrôle visuel hors application.

    python tools/preview_grid.py                    # cote et préréglage courants
    python tools/preview_grid.py 645.0              # à une autre cote
    python tools/preview_grid.py 645.0 rouge-vert   # avec un autre préréglage

Le rendu passe par tools/palette.py, donc par la même table de correspondance que
l'application : ce que montre l'aperçu est ce que verra le téléphone.

Sortie : data/preview.png
"""

from __future__ import annotations

import json
import sys

import numpy as np
from PIL import Image

from common import DATA_DIR
from palette import get_preset, load_palette, render, safety_depth


def load_bed() -> tuple[np.ndarray, np.ndarray, dict]:
    with (DATA_DIR / "bed.json").open(encoding="utf-8") as fh:
        meta = json.load(fh)
    image = np.array(Image.open(DATA_DIR / "bed.png").convert("RGBA"))
    r, g, b, a = (image[..., i].astype(np.int64) for i in range(4))
    enc = meta["encoding"]
    return enc["base"] + (r * 65536 + g * 256 + b) * enc["interval"], a > 0, meta


def main() -> int:
    bed, valid, meta = load_bed()

    if len(sys.argv) > 1:
        level = float(sys.argv[1])
    else:
        with (DATA_DIR / "level.json").open(encoding="utf-8") as fh:
            level = float(json.load(fh)["level_m_ngf"])

    palette = load_palette()
    name, preset = get_preset(palette, sys.argv[2] if len(sys.argv) > 2 else None)

    depth = np.where(valid, level - bed, np.nan)
    rgb = render(depth, valid, palette, name)
    rgb[~valid] = (255, 255, 255)

    path = DATA_DIR / "preview.png"
    Image.fromarray(rgb, mode="RGB").save(path)

    safe = safety_depth(palette)
    wet = valid & (depth > 0)
    cell = meta["resolution_ground_m"] ** 2
    print(f"cote {level:.2f} m NGF · préréglage « {preset['label']} » ({preset['mode']})")
    print(f"  fond émergé            : {(valid & (depth <= 0)).sum() * cell / 1e4:6.1f} ha")
    print(f"  sous la cote de sécurité ({safe:.1f} m) : "
          f"{(wet & (depth <= safe)).sum() * cell / 1e4:6.1f} ha")
    print(f"  surface en eau         : {wet.sum() * cell / 1e6:.2f} km²")
    if wet.any():
        print(f"  profondeur max         : {np.nanmax(depth):.1f} m · "
              f"moyenne {depth[wet].mean():.1f} m")
    print(f"→ {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
