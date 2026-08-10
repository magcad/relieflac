"""Contrôle : à quelle cote NGF correspond le trait de côte BD TOPO du lac ?

Le contour BD TOPO est supposé proche de la retenue normale (650 m NGF). Ce script
échantillonne le RGE ALTI le long du contour pour le vérifier. Le MNT renvoyant une
valeur constante (648,80 m) sur le plan d'eau de l'acquisition LiDAR, seuls les
points tombant sur la berge sont informatifs.

Résultat au 10/08/2026 : médiane 649,32 m NGF (p10 648,92 · p90 650,26) sur 914 points
de berge — le contour est bien un contour de haut niveau, à ~0,7 m sous la retenue normale.
"""

from __future__ import annotations

import json
import statistics

from common import DATA_DIR, load_model_config
from ign_alti import boundary_points, sample_elevations


def main() -> int:
    config = load_model_config()
    water_plane = config["reference_levels"]["rge_alti"]["value_m_ngf"]
    normal = config["lake"]["normal_level_m_ngf"]

    with (DATA_DIR / "lake.geojson").open(encoding="utf-8") as fh:
        geometry = json.load(fh)["features"][0]["geometry"]

    points = boundary_points(geometry, spacing_m=40.0)
    elevations = sample_elevations(points)
    print(f"{len(points)} points échantillonnés le long du contour (pas 40 m)")

    on_water = [z for z in elevations if abs(z - water_plane) < 0.05]
    on_bank = sorted(z for z in elevations if z >= water_plane + 0.05)
    below = [z for z in elevations if z <= water_plane - 0.05]

    print(f"  sur le plan d'eau LiDAR ({water_plane} m) : {len(on_water)}")
    print(f"  sur la berge (> {water_plane} m)          : {len(on_bank)}")
    print(f"  sous le plan d'eau                        : {len(below)}")

    if on_bank:
        print("\n  distribution des points de berge :")
        for label, value in [
            ("p10", on_bank[len(on_bank) // 10]),
            ("médiane", statistics.median(on_bank)),
            ("p90", on_bank[len(on_bank) * 9 // 10]),
        ]:
            print(f"    {label:8s} {value:7.2f} m NGF  "
                  f"(écart à la retenue normale : {value - normal:+.2f} m)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
