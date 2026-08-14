"""Rend un aperçu colorié de la grille, pour contrôle visuel hors application.

    python tools/preview_grid.py                    # cote et préréglage courants
    python tools/preview_grid.py 645.0              # à une autre cote
    python tools/preview_grid.py 645.0 rouge-vert   # avec un autre préréglage
    python tools/preview_grid.py 645.0 --quickdraw  # le fond communautaire seul

Le rendu passe par tools/palette.py, donc par la même table de correspondance que
l'application : ce que montre l'aperçu est ce que verra le téléphone.

Sortie : data/preview.png, ou data/preview_quickdraw.png avec --quickdraw.
"""

from __future__ import annotations

import json
import sys

import numpy as np
from PIL import Image

from common import DATA_DIR
from palette import get_preset, load_palette, render, safety_depth


def load_bed(stem: str = "bed") -> tuple[np.ndarray, np.ndarray, dict]:
    with (DATA_DIR / f"{stem}.json").open(encoding="utf-8") as fh:
        meta = json.load(fh)
    image = np.array(Image.open(DATA_DIR / f"{stem}.png").convert("RGBA"))
    r, g, b, a = (image[..., i].astype(np.int64) for i in range(4))
    enc = meta["encoding"]
    return enc["base"] + (r * 65536 + g * 256 + b) * enc["interval"], a > 0, meta


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    quickdraw = "--quickdraw" in sys.argv
    bed, valid, meta = load_bed("bed_quickdraw" if quickdraw else "bed")

    if args:
        level = float(args[0])
    else:
        with (DATA_DIR / "level.json").open(encoding="utf-8") as fh:
            level = float(json.load(fh)["level_m_ngf"])

    palette = load_palette()
    name, preset = get_preset(palette, args[1] if len(args) > 1 else None)

    depth = np.where(valid, level - bed, np.nan)
    rgb = render(depth, valid, palette, name)
    rgb[~valid] = (255, 255, 255)

    path = DATA_DIR / ("preview_quickdraw.png" if quickdraw else "preview.png")
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
