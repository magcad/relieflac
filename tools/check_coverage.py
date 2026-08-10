"""Localise les zones où le modèle invente : les trous du levé de 2009.

Le bateau sondeur suit des traces. Entre deux traces, la triangulation interpole ; là où
il n'est pas passé du tout, elle relie des sondes éloignées de part et d'autre et produit
une valeur qui ne repose sur aucune mesure. Un haut-fond au milieu d'un tel trou devient
invisible, et pire : il hérite de la profondeur des fosses qui l'entourent.

Ce script mesure, pour chaque cellule du lac, la distance à la sonde de 2009 la plus
proche, isole les trous, et confronte chacun au MNT LiDAR pour dire si la donnée
manquante est récupérable ou non.

Sortie : data/couverture.png (carte de diagnostic) et un rapport en console.
"""

from __future__ import annotations

import json

import numpy as np
from PIL import Image, ImageDraw
from pyproj import Transformer
from scipy import ndimage
from scipy.spatial import cKDTree

from common import DATA_DIR, list_sounding_sets, load_model_config, read_soundings

VOID_RADIUS_M = 60.0   # au-delà, aucune sonde n'a contraint la valeur localement
MIN_VOID_AREA_M2 = 20000.0


def main() -> int:
    config = load_model_config()
    water_plane = config["reference_levels"]["rge_alti"]["value_m_ngf"]

    with (DATA_DIR / "bed.json").open(encoding="utf-8") as fh:
        meta = json.load(fh)
    with (DATA_DIR / "level.json").open(encoding="utf-8") as fh:
        level = float(json.load(fh)["level_m_ngf"])

    image = np.array(Image.open(DATA_DIR / "bed.png").convert("RGBA"))
    r, g, b, a = (image[..., i].astype(np.int64) for i in range(4))
    enc = meta["encoding"]
    bed = np.where(a > 0, enc["base"] + (r * 65536 + g * 256 + b) * enc["interval"], np.nan)
    lake = a > 0

    height, width = bed.shape
    x0, y0, x1, y1 = meta["bbox_3857"]
    res_x = (x1 - x0) / width
    res_y = (y1 - y0) / height
    ground = meta["resolution_ground_m"]
    cell_area = ground ** 2

    # Sondes mesurées, en mercator, pour tenir dans le même repère que la grille.
    to_merc = Transformer.from_crs("EPSG:4326", "EPSG:3857", always_xy=True)
    lons, lats = [], []
    for name in list_sounding_sets():
        rows, _ = read_soundings(name)
        lons.extend(row[0] for row in rows)
        lats.extend(row[1] for row in rows)
    mx, my = to_merc.transform(lons, lats)
    tree = cKDTree(np.column_stack([mx, my]))

    xs = x0 + (np.arange(width) + 0.5) * res_x
    ys = y1 - (np.arange(height) + 0.5) * res_y
    grid_x, grid_y = np.meshgrid(xs, ys)
    distances, _ = tree.query(np.column_stack([grid_x.ravel(), grid_y.ravel()]))
    # Le mercator dilate les distances : on repasse en mètres au sol.
    scale = ground / res_x
    distances = (distances.reshape(height, width) * scale)
    distances = np.where(lake, distances, np.nan)

    print(f"couverture du levé de 2009 sur {lake.sum() * cell_area / 1e6:.2f} km² de lac")
    for limit in (25, 50, 60, 100, 150):
        share = np.nansum(distances <= limit) / lake.sum() * 100
        print(f"  à moins de {limit:3d} m d'une sonde : {share:5.1f} %")
    print(f"  distance médiane : {np.nanmedian(distances):.0f} m · "
          f"maximale : {np.nanmax(distances):.0f} m")

    voids = lake & (distances > VOID_RADIUS_M)
    labels, count = ndimage.label(voids)
    print(f"\n{count} trous au-delà de {VOID_RADIUS_M:.0f} m · "
          f"{voids.sum() * cell_area / 1e4:.1f} ha au total "
          f"({voids.sum() / lake.sum() * 100:.1f} % du lac)")

    dem = np.load(DATA_DIR / "rge_alti.npy") if (DATA_DIR / "rge_alti.npy").exists() else None
    dem_meta = None
    if dem is not None:
        with (DATA_DIR / "rge_alti.json").open(encoding="utf-8") as fh:
            dem_meta = json.load(fh)

    to_lambert = Transformer.from_crs("EPSG:3857", dem_meta["crs"], always_xy=True) if dem is not None else None
    to_wgs = Transformer.from_crs("EPSG:3857", "EPSG:4326", always_xy=True)

    sizes = ndimage.sum_labels(np.ones_like(labels), labels, range(1, count + 1))
    order = np.argsort(sizes)[::-1]

    print(f"\n{'aire':>7}  {'centre':>19}  {'profondeur affichée':>19}  {'MNT LiDAR':>22}")
    print(f"{'(ha)':>7}  {'lat, lon':>19}  {'(m)':>19}")

    shown = 0
    for index in order:
        area = sizes[index] * cell_area
        if area < MIN_VOID_AREA_M2 or shown >= 10:
            break
        cells = labels == index + 1
        rows, cols = np.nonzero(cells)
        cx = x0 + (cols.mean() + 0.5) * res_x
        cy = y1 - (rows.mean() + 0.5) * res_y
        lon, lat = to_wgs.transform(cx, cy)

        depths = level - bed[cells]
        verdict = "—"
        if dem is not None:
            lx, ly = to_lambert.transform(
                x0 + (cols + 0.5) * res_x, y1 - (rows + 0.5) * res_y)
            dcols = np.floor((lx - dem_meta["bbox"][0]) / dem_meta["resolution_m"]).astype(int)
            drows = np.floor((dem_meta["bbox"][3] - ly) / dem_meta["resolution_m"]).astype(int)
            ok = ((dcols >= 0) & (dcols < dem_meta["width"])
                  & (drows >= 0) & (drows < dem_meta["height"]))
            values = dem[drows[ok], dcols[ok]]
            at_plane = np.abs(values - water_plane) < 0.05
            share = at_plane.mean() * 100 if values.size else 0.0
            verdict = (f"{share:.0f} % au plan d'eau"
                       if share > 50 else f"max {np.nanmax(values):.1f} m NGF")

        print(f"{area / 1e4:7.1f}  {lat:9.5f}, {lon:.5f}  "
              f"{np.nanmin(depths):6.1f} → {np.nanmax(depths):5.1f}  {verdict:>22}")
        shown += 1

    # --- carte de diagnostic ---------------------------------------------------
    canvas = np.full((height, width, 3), 255, dtype=np.uint8)
    depth_all = level - bed
    canvas[lake] = (210, 226, 238)
    canvas[lake & (depth_all <= 0)] = (200, 161, 101)
    canvas[voids] = (255, 60, 60)
    canvas[lake & (distances <= 25)] = (120, 190, 140)

    picture = Image.fromarray(canvas, mode="RGB")
    draw = ImageDraw.Draw(picture)
    for px, py in zip(mx, my):
        col = int((px - x0) / res_x)
        row = int((y1 - py) / res_y)
        if 0 <= col < width and 0 <= row < height:
            draw.point((col, row), fill=(20, 40, 60))

    path = DATA_DIR / "couverture.png"
    picture.save(path)
    print(f"\n→ {path}")
    print("   vert : sonde à moins de 25 m · bleu pâle : entre 25 et 60 m · "
          "rouge : trou · points sombres : traces de 2009")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
