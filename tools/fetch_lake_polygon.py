"""Récupère le contour du lac de Vassivière depuis l'IGN BD TOPO® (WFS Géoplateforme).

Le polygone sert à deux choses : masquer tout ce qui est hors du lac, et fournir
une contrainte de bord (profondeur nulle au trait de côte) à l'interpolation.

Licence : Licence Ouverte / Etalab 2.0 — © IGN
"""

from __future__ import annotations

import json
import sys
import urllib.parse
import urllib.request

from common import DATA_DIR, write_json

WFS = "https://data.geopf.fr/wfs/ows"
LAYER = "BDTOPO_V3:plan_d_eau"
NAME_FILTER = "toponyme LIKE '%Vassivi%'"


def fetch_features() -> list[dict]:
    params = {
        "SERVICE": "WFS",
        "VERSION": "2.0.0",
        "REQUEST": "GetFeature",
        "TYPENAMES": LAYER,
        "SRSNAME": "EPSG:4326",
        "OUTPUTFORMAT": "application/json",
        "COUNT": "50",
        "CQL_FILTER": NAME_FILTER,
    }
    url = f"{WFS}?{urllib.parse.urlencode(params)}"
    request = urllib.request.Request(url, headers={"User-Agent": "ReliefLac/0.1"})
    with urllib.request.urlopen(request, timeout=120) as response:
        payload = json.load(response)
    return payload.get("features", [])


def ring_area_deg2(ring: list) -> float:
    """Aire signée d'un anneau, en degrés carrés — suffisant pour classer les entités."""
    total = 0.0
    for (x0, y0), (x1, y1) in zip(ring, ring[1:] + ring[:1]):
        total += x0 * y1 - x1 * y0
    return abs(total) / 2.0


def feature_area(feature: dict) -> float:
    geom = feature["geometry"]
    polygons = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
    return sum(ring_area_deg2(poly[0]) for poly in polygons)


def main() -> int:
    features = fetch_features()
    if not features:
        print("ERREUR : le WFS n'a retourné aucune entité", file=sys.stderr)
        return 1

    features.sort(key=feature_area, reverse=True)
    for feature in features:
        props = feature["properties"]
        print(f"  {feature['geometry']['type']:13s} "
              f"nature={props.get('nature', '?'):18s} "
              f"aire≈{feature_area(feature) * 1e6:7.2f} (10⁻⁶ deg²)")

    main_feature = features[0]
    nature = main_feature["properties"].get("nature")
    if nature != "Retenue-barrage":
        print(f"ATTENTION : l'entité la plus grande est de nature « {nature} », "
              f"pas « Retenue-barrage ».", file=sys.stderr)

    collection = {
        "type": "FeatureCollection",
        "properties": {
            "source": "IGN BD TOPO® V3 — couche plan_d_eau",
            "source_url": WFS,
            "license": "Licence Ouverte / Etalab 2.0 — © IGN",
            "filter": NAME_FILTER,
        },
        "features": [
            {
                "type": "Feature",
                "geometry": main_feature["geometry"],
                "properties": {
                    key: main_feature["properties"].get(key)
                    for key in ("toponyme", "nature", "cleabs")
                },
            }
        ],
    }
    write_json(DATA_DIR / "lake.geojson", collection)

    vertices = sum(
        len(ring)
        for poly in main_feature["geometry"]["coordinates"]
        for ring in poly
    )
    print(f"contour retenu : {main_feature['properties'].get('toponyme')} "
          f"({nature}), {vertices} sommets → data/lake.geojson")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
