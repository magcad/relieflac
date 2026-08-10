"""Produit les valeurs de référence attendues par le test du navigateur.

tools/palette.py et src/palette.js doivent produire exactement la même table : l'aperçu
de contrôle et le téléphone montreraient sinon des couleurs différentes pour la même
profondeur. Ce script fige la référence, test/reference.json, que test.html compare.

    python tools/dump_reference.py
"""

from __future__ import annotations

import json

import numpy as np
from PIL import Image

from common import DATA_DIR, ROOT
from palette import build_lut, load_palette, lut_index

DEPTHS = [0.0, 0.5, 1.0, 1.5, 2.0, 3.0, 4.0, 5.0, 8.0, 10.0, 12.0, 18.0, 20.0, 25.0, 30.0]

# Points de contrôle répartis sur le lac, dont un hors emprise.
PROBES = [
    (1.87132, 45.79328), (1.86000, 45.80000), (1.90000, 45.79000),
    (1.84837, 45.78223), (1.89965, 45.79602), (1.91000, 45.81000),
    (1.70000, 45.70000),
]


def main() -> int:
    palette = load_palette()
    lut_max = palette["lut_max_depth_m"]

    presets = {}
    for name in palette["presets"]:
        lut, _ = build_lut(palette, name)
        samples = {}
        for depth in DEPTHS:
            r, g, b = lut[int(lut_index(depth, lut_max))]
            samples[f"{depth:g}"] = f"#{r:02x}{g:02x}{b:02x}"
        presets[name] = samples

    with (DATA_DIR / "bed.json").open(encoding="utf-8") as fh:
        meta = json.load(fh)
    image = np.array(Image.open(DATA_DIR / "bed.png").convert("RGBA"))
    r, g, b, a = (image[..., i].astype(np.int64) for i in range(4))
    enc = meta["encoding"]
    bed = np.where(a > 0, enc["base"] + (r * 65536 + g * 256 + b) * enc["interval"], np.nan)

    x0, y0, x1, y1 = meta["bbox_3857"]
    height, width = bed.shape
    earth = 40075016.685578488

    probes = []
    for lon, lat in PROBES:
        mx = lon / 360 * earth
        clamped = max(min(lat, 85.05112878), -85.05112878)
        my = np.log(np.tan(np.pi / 4 + clamped * np.pi / 360)) / np.pi * (earth / 2)
        col = int(np.floor((mx - x0) / (x1 - x0) * width))
        row = int(np.floor((y1 - my) / (y1 - y0) * height))
        inside = 0 <= col < width and 0 <= row < height
        z = float(bed[row, col]) if inside else float("nan")
        probes.append({
            "lon": lon, "lat": lat,
            "z": None if not np.isfinite(z) else round(z, 2),
        })

    coverage = meta.get("coverage", {})

    reference = {
        "generated_by": "tools/dump_reference.py",
        "lut_max_depth_m": lut_max,
        "coverage": {
            key: coverage.get(key)
            for key in ("median_m", "max_m", "share_within_25m", "share_beyond_60m")
        },
        "safety_depth_m": palette["safety_contour"]["draft_m"] + palette["safety_contour"]["margin_m"],
        "presets": presets,
        "bed": {"width": meta["width"], "height": meta["height"], "probes": probes},
    }

    path = ROOT / "test" / "reference.json"
    path.parent.mkdir(exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as fh:
        json.dump(reference, fh, ensure_ascii=False, indent=2)
        fh.write("\n")

    print(f"{len(presets)} préréglages × {len(DEPTHS)} profondeurs, "
          f"{len(probes)} points de contrôle → test/reference.json")
    for probe in probes:
        print(f"  {probe['lat']:.5f}, {probe['lon']:.5f} → "
              f"{'hors emprise' if probe['z'] is None else f'{probe['z']:.2f} m NGF'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
