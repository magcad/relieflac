"""Télécharge le MNT RGE ALTI® sur l'emprise du lac, en altitudes réelles.

Le WMS de la Géoplateforme sert le modèle numérique de terrain en BIL float32 :
on récupère donc de vraies altitudes en m NGF, pas une image ombrée.

Intérêt : le LiDAR a été acquis alors que le lac était à 648,80 m NGF. Tout ce qui,
à l'intérieur du contour du lac, dépasse cette cote est **du terrain réellement
mesuré** — des hauts-fonds qui affleuraient ce jour-là. Or ce sont précisément les
zones que le levé bathymétrique de 2009 ne couvre pas : le bateau sondeur ne peut
pas y passer.

Sortie : data/rge_alti.npy (float32, EPSG:2154) et data/rge_alti.json
"""

from __future__ import annotations

import argparse
import io
import json
import math
import time
import urllib.error
import urllib.parse
import urllib.request

import numpy as np
from pyproj import Transformer

from common import DATA_DIR, write_json

WMS = "https://data.geopf.fr/wms-r/wms"
LAYER = "ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES"
CRS = "EPSG:2154"
TILE = 1000  # côté maximal d'une requête, en pixels
NODATA_BELOW = -1000.0


def fetch_tile(bbox, width: int, height: int, retries: int = 3) -> np.ndarray:
    params = {
        "SERVICE": "WMS", "VERSION": "1.3.0", "REQUEST": "GetMap",
        "LAYERS": LAYER, "STYLES": "", "CRS": CRS,
        "BBOX": ",".join(f"{v:.3f}" for v in bbox),
        "WIDTH": str(width), "HEIGHT": str(height),
        "FORMAT": "image/x-bil;bits=32",
    }
    url = f"{WMS}?{urllib.parse.urlencode(params)}"
    request = urllib.request.Request(url, headers={"User-Agent": "ReliefLac/0.1"})

    for attempt in range(retries):
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                payload = response.read()
            break
        except (urllib.error.URLError, TimeoutError):
            if attempt == retries - 1:
                raise
            time.sleep(2 * (attempt + 1))

    expected = width * height * 4
    if len(payload) != expected:
        raise RuntimeError(f"réponse de {len(payload)} o, {expected} attendus "
                           f"(le service a probablement renvoyé une erreur XML)")

    return np.frombuffer(payload, dtype="<f4").reshape(height, width)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--resolution", type=float, default=5.0, help="pas de la grille en m (défaut 5)")
    parser.add_argument("--margin", type=float, default=150.0, help="marge autour du lac en m")
    args = parser.parse_args()

    with (DATA_DIR / "lake.geojson").open(encoding="utf-8") as fh:
        geometry = json.load(fh)["features"][0]["geometry"]

    polygons = (
        geometry["coordinates"] if geometry["type"] == "MultiPolygon" else [geometry["coordinates"]]
    )
    lons = [p[0] for poly in polygons for ring in poly for p in ring]
    lats = [p[1] for poly in polygons for ring in poly for p in ring]

    to_lambert = Transformer.from_crs("EPSG:4326", CRS, always_xy=True)
    xs, ys = to_lambert.transform(lons, lats)

    res = args.resolution
    x0 = math.floor((min(xs) - args.margin) / res) * res
    y0 = math.floor((min(ys) - args.margin) / res) * res
    width = int(math.ceil((max(xs) + args.margin - x0) / res))
    height = int(math.ceil((max(ys) + args.margin - y0) / res))
    x1 = x0 + width * res
    y1 = y0 + height * res

    print(f"MNT {width} × {height} px à {res} m (Lambert-93)")
    print(f"  emprise x {x0:.0f} → {x1:.0f} · y {y0:.0f} → {y1:.0f}")

    dem = np.full((height, width), np.nan, dtype=np.float32)
    tiles_x = math.ceil(width / TILE)
    tiles_y = math.ceil(height / TILE)
    total = tiles_x * tiles_y
    done = 0

    for ty in range(tiles_y):
        for tx in range(tiles_x):
            col0, row0 = tx * TILE, ty * TILE
            tw = min(TILE, width - col0)
            th = min(TILE, height - row0)

            # Ligne 0 du tableau = haut de l'image = ymax de la bbox.
            tile_bbox = (
                x0 + col0 * res,
                y1 - (row0 + th) * res,
                x0 + (col0 + tw) * res,
                y1 - row0 * res,
            )
            dem[row0 : row0 + th, col0 : col0 + tw] = fetch_tile(tile_bbox, tw, th)
            done += 1
            print(f"  dalle {done}/{total}")

    dem = np.where(dem > NODATA_BELOW, dem, np.nan)
    valid = np.isfinite(dem)

    np.save(DATA_DIR / "rge_alti.npy", dem)
    write_json(
        DATA_DIR / "rge_alti.json",
        {
            "source": "IGN RGE ALTI® via WMS Géoplateforme",
            "layer": LAYER,
            "license": "Licence Ouverte / Etalab 2.0 — © IGN",
            "crs": CRS,
            "width": width,
            "height": height,
            "resolution_m": res,
            "bbox": [x0, y0, x1, y1],
            "origin_top_left": [x0, y1],
            "z_range_m_ngf": [round(float(np.nanmin(dem)), 2), round(float(np.nanmax(dem)), 2)],
            "note": "Ligne 0 du tableau = bord nord (y max). NaN = hors couverture.",
        },
    )

    print(f"\naltitudes : {np.nanmin(dem):.2f} → {np.nanmax(dem):.2f} m NGF "
          f"({valid.sum() / valid.size * 100:.1f} % de cellules valides)")
    print(f"→ data/rge_alti.npy ({dem.nbytes / 1e6:.1f} Mo)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
