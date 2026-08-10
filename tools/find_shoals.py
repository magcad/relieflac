"""Cherche les hauts-fonds absents du levé bathymétrique de 2009.

Le bateau sondeur ne passe pas sur un haut-fond : ces zones sont donc des trous dans
le levé, que la triangulation comble en les rendant *plus profondes* qu'elles ne sont.
Ce sont exactement les zones dangereuses.

Le LiDAR IGN, lui, a survolé le lac à la cote 648,80 m NGF. Tout ce qui, à l'intérieur
du contour du lac, dépasse cette cote est du terrain réellement mesuré. On compare donc
le MNT au modèle pour quantifier ce que le modèle rate.
"""

from __future__ import annotations

import json

import numpy as np
from PIL import Image, ImageDraw
from pyproj import Transformer
from scipy import ndimage

from common import DATA_DIR, load_model_config

WATER_PLANE_MARGIN = 0.05


def lake_mask_lambert(geometry: dict, meta: dict) -> np.ndarray:
    x0, y0, x1, y1 = meta["bbox"]
    width, height = meta["width"], meta["height"]
    to_lambert = Transformer.from_crs("EPSG:4326", meta["crs"], always_xy=True)

    image = Image.new("1", (width, height), 0)
    draw = ImageDraw.Draw(image)
    polygons = (
        geometry["coordinates"] if geometry["type"] == "MultiPolygon" else [geometry["coordinates"]]
    )
    for poly in polygons:
        for index, ring in enumerate(poly):
            xs, ys = to_lambert.transform([p[0] for p in ring], [p[1] for p in ring])
            pixels = [
                ((x - x0) / (x1 - x0) * width, (y1 - y) / (y1 - y0) * height)
                for x, y in zip(xs, ys)
            ]
            draw.polygon(pixels, fill=1 if index == 0 else 0)
    return np.array(image, dtype=bool)


def model_bed_on(meta: dict) -> np.ndarray:
    """Rééchantillonne le modèle (Web Mercator) sur la grille du MNT (Lambert-93)."""
    with (DATA_DIR / "bed.json").open(encoding="utf-8") as fh:
        bed_meta = json.load(fh)

    image = np.array(Image.open(DATA_DIR / "bed.png").convert("RGBA"))
    r, g, b, a = (image[..., i].astype(np.int64) for i in range(4))
    enc = bed_meta["encoding"]
    bed = np.where(a > 0, enc["base"] + (r * 65536 + g * 256 + b) * enc["interval"], np.nan)

    bx0, by0, bx1, by1 = bed_meta["bbox_3857"]
    bh, bw = bed.shape

    x0, y0, x1, y1 = meta["bbox"]
    res = meta["resolution_m"]
    xs = x0 + (np.arange(meta["width"]) + 0.5) * res
    ys = y1 - (np.arange(meta["height"]) + 0.5) * res
    gx, gy = np.meshgrid(xs, ys)

    to_merc = Transformer.from_crs(meta["crs"], "EPSG:3857", always_xy=True)
    mx, my = to_merc.transform(gx.ravel(), gy.ravel())

    cols = np.floor((mx - bx0) / (bx1 - bx0) * bw).astype(np.int64)
    rows = np.floor((by1 - my) / (by1 - by0) * bh).astype(np.int64)
    inside = (cols >= 0) & (cols < bw) & (rows >= 0) & (rows < bh)

    out = np.full(mx.shape, np.nan)
    out[inside] = bed[rows[inside], cols[inside]]
    return out.reshape(meta["height"], meta["width"])


def main() -> int:
    config = load_model_config()
    water_plane = config["reference_levels"]["rge_alti"]["value_m_ngf"]

    with (DATA_DIR / "rge_alti.json").open(encoding="utf-8") as fh:
        meta = json.load(fh)
    dem = np.load(DATA_DIR / "rge_alti.npy")

    with (DATA_DIR / "lake.geojson").open(encoding="utf-8") as fh:
        geometry = json.load(fh)["features"][0]["geometry"]

    inside = lake_mask_lambert(geometry, meta)
    cell = meta["resolution_m"] ** 2
    print(f"surface du contour du lac : {inside.sum() * cell / 1e6:.2f} km²")

    water = np.isfinite(dem) & inside & (np.abs(dem - water_plane) < WATER_PLANE_MARGIN)
    above = np.isfinite(dem) & inside & (dem > water_plane + WATER_PLANE_MARGIN)
    print(f"  au plan d'eau LiDAR ({water_plane} m) : {water.sum() * cell / 1e6:.2f} km²")
    print(f"  au-dessus (terrain mesuré)           : {above.sum() * cell / 1e6:.2f} km²  "
          f"← hauts-fonds découverts lors du vol")

    if not above.any():
        print("\naucun haut-fond détecté au-dessus du plan d'eau LiDAR")
        return 0

    labels, count = ndimage.label(above)
    sizes = ndimage.sum_labels(np.ones_like(labels), labels, range(1, count + 1))
    order = np.argsort(sizes)[::-1]

    model = model_bed_on(meta)
    to_wgs = Transformer.from_crs(meta["crs"], "EPSG:4326", always_xy=True)
    x0, _, _, y1 = meta["bbox"]
    res = meta["resolution_m"]

    print(f"\n{count} amas détectés · les 12 plus étendus :\n")
    print(f"  {'aire':>8}  {'z max':>7}  {'modèle':>7}  {'écart':>7}   position")
    print(f"  {'(m²)':>8}  {'(m NGF)':>7}  {'(m NGF)':>7}  {'(m)':>7}")

    shown = 0
    for index in order:
        label = index + 1
        area = sizes[index] * cell
        if area < 200:
            break

        cells = labels == label
        peak = np.nanmax(dem[cells])
        rows, cols = np.nonzero(cells)
        top = np.argmax(dem[cells])
        lon, lat = to_wgs.transform(x0 + (cols[top] + 0.5) * res, y1 - (rows[top] + 0.5) * res)

        modelled = np.nanmax(model[cells]) if np.isfinite(model[cells]).any() else np.nan
        gap = peak - modelled if np.isfinite(modelled) else np.nan

        print(f"  {area:8.0f}  {peak:7.2f}  "
              f"{modelled:7.2f}  {gap:+7.2f}   {lat:.5f}, {lon:.5f}"
              if np.isfinite(modelled)
              else f"  {area:8.0f}  {peak:7.2f}  {'—':>7}  {'—':>7}   {lat:.5f}, {lon:.5f}")

        shown += 1
        if shown >= 12:
            break

    finite = above & np.isfinite(model)
    if finite.any():
        gaps = dem[finite] - model[finite]
        under = gaps > 0.5
        print(f"\nsur l'ensemble des cellules de haut-fond :")
        print(f"  le modèle sous-estime le fond de plus de 0,5 m sur "
              f"{under.sum() * cell / 1e4:.2f} ha ({under.mean() * 100:.0f} % d'entre elles)")
        print(f"  écart médian {np.median(gaps):+.2f} m · maximum {gaps.max():+.2f} m")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
