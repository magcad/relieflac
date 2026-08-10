"""Construit la contrainte de bord de l'interpolation : altitude du terrain au trait de côte.

Sans contrainte de bord, la triangulation extrapole n'importe quoi près des rives —
les sondes s'arrêtent là où le bateau ne passe plus, vers 0,5 m de fond, et le
modèle n'a plus rien pour raccrocher la berge.

On échantillonne donc le RGE ALTI le long du contour BD TOPO. Là où le MNT renvoie
encore le plan d'eau de l'acquisition LiDAR (648,80 m constant), la valeur n'est pas
informative : on lui substitue la médiane des points tombés sur la berge.

Sortie : data/shore_constraint.csv (lon, lat, z_bed_m_ngf)
"""

from __future__ import annotations

import csv
import json
import statistics

from common import DATA_DIR, load_model_config, write_json
from ign_alti import boundary_points, sample_elevations


def main() -> int:
    config = load_model_config()
    shore_cfg = config["grid"]["shore_constraint"]
    water_plane = config["reference_levels"]["rge_alti"]["value_m_ngf"]

    with (DATA_DIR / "lake.geojson").open(encoding="utf-8") as fh:
        geometry = json.load(fh)["features"][0]["geometry"]

    points = boundary_points(geometry, spacing_m=float(shore_cfg["spacing_m"]))
    elevations = sample_elevations(points)
    print(f"{len(points)} points de contour échantillonnés "
          f"(pas {shore_cfg['spacing_m']} m)")

    on_bank = [z for z in elevations if z >= water_plane + 0.05]
    if not on_bank:
        print("ERREUR : aucun point du contour ne tombe sur la berge")
        return 1
    fallback = statistics.median(on_bank)
    print(f"  {len(on_bank)} points sur berge · médiane {fallback:.2f} m NGF")
    print(f"  {len(points) - len(on_bank)} points non informatifs → remplacés par la médiane")

    path = DATA_DIR / "shore_constraint.csv"
    with path.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.writer(fh)
        writer.writerow(["lon", "lat", "z_bed_m_ngf"])
        for (lon, lat), z in zip(points, elevations):
            value = z if z >= water_plane + 0.05 else fallback
            writer.writerow([f"{lon:.6f}", f"{lat:.6f}", f"{value:.2f}"])

    write_json(
        DATA_DIR / "shore_constraint.json",
        {
            "label": "Contrainte de bord — altitude du terrain au trait de côte",
            "source": "IGN RGE ALTI® échantillonné le long du contour BD TOPO® V3",
            "license": "Licence Ouverte / Etalab 2.0 — © IGN",
            "spacing_m": shore_cfg["spacing_m"],
            "count": len(points),
            "median_bank_m_ngf": round(fallback, 2),
            "substituted": len(points) - len(on_bank),
            "note": (
                "Altitudes absolues en m NGF, indépendantes de toute cote de référence : "
                "ces points ancrent l'interpolation même si Z_2009 change."
            ),
        },
    )
    print(f"→ {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
