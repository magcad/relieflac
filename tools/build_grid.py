"""Construit la grille d'altitude de fond du lac et l'encode en PNG Terrain-RGB.

Chaîne de traitement :

  sondes (profondeur)  ──┐
                         ├── altitude de fond en m NGF ── triangulation de Delaunay
  contrainte de bord  ───┘                                       │
                                                                 ├── grille régulière
  contour du lac ────────────────────────── masque ──────────────┘
                                                                 │
                                                      lissage ───┴── PNG Terrain-RGB

La grille est produite en EPSG:3857 (Web Mercator) pour que l'application puisse la
draper telle quelle sur la carte, mais l'interpolation est calculée en EPSG:2154
(Lambert-93), métrique et non déformant, pour que les distances soient justes.

Sorties : data/bed.png et data/bed.json
"""

from __future__ import annotations

import csv
import json
import math
import sys

import numpy as np
from PIL import Image, ImageDraw
from pyproj import Transformer
from scipy.interpolate import LinearNDInterpolator
from scipy.ndimage import gaussian_filter

from common import (
    DATA_DIR,
    LevelHistory,
    list_sounding_sets,
    load_model_config,
    read_soundings,
    resolve_reference_level,
    write_json,
)

WGS84 = "EPSG:4326"
WEBMERC = "EPSG:3857"
LAMBERT93 = "EPSG:2154"


# --------------------------------------------------------------------------- sondes


def collect_points(config: dict) -> tuple[np.ndarray, dict]:
    """Rassemble toutes les sondes, converties en altitude de fond (m NGF)."""
    history = LevelHistory()
    lons: list[float] = []
    lats: list[float] = []
    zs: list[float] = []
    report: dict = {}

    for name in list_sounding_sets():
        rows, meta = read_soundings(name)
        kept = skipped = 0
        ref_used: set[float] = set()

        for lon, lat, depth, timestamp in rows:
            ref = resolve_reference_level(meta, timestamp, config, history)
            if ref is None:
                skipped += 1
                continue
            lons.append(lon)
            lats.append(lat)
            zs.append(ref - depth)
            ref_used.add(round(ref, 2))
            kept += 1

        report[name] = {
            "label": meta.get("label", name),
            "kept": kept,
            "skipped": skipped,
            "reference_mode": meta.get("reference", {}).get("mode"),
            "reference_levels_m_ngf": sorted(ref_used)[:5],
            "weight": meta.get("weight", 1.0),
        }
        status = f"    {name:16s} {kept:6d} sondes retenues"
        if skipped:
            status += f", {skipped} écartées (cote de référence introuvable)"
        print(status)

    shore_path = DATA_DIR / "shore_constraint.csv"
    if shore_path.exists():
        count = 0
        with shore_path.open(encoding="utf-8", newline="") as fh:
            for rec in csv.DictReader(fh):
                lons.append(float(rec["lon"]))
                lats.append(float(rec["lat"]))
                zs.append(float(rec["z_bed_m_ngf"]))
                count += 1
        report["shore_constraint"] = {"label": "Contrainte de bord (trait de côte)", "kept": count}
        print(f"    {'shore':16s} {count:6d} points de contour")

    if not zs:
        raise SystemExit("ERREUR : aucune sonde exploitable")

    return np.column_stack([lons, lats, zs]), report


# --------------------------------------------------------------------------- masque


def iter_rings(geometry: dict):
    polygons = (
        geometry["coordinates"]
        if geometry["type"] == "MultiPolygon"
        else [geometry["coordinates"]]
    )
    for poly in polygons:
        for index, ring in enumerate(poly):
            yield ring, index == 0  # (anneau, est_exterieur)


def build_mask(geometry: dict, bbox, size, to_mercator) -> np.ndarray:
    """Rastérise le contour du lac : True à l'intérieur, îles exclues."""
    x0, y0, x1, y1 = bbox
    width, height = size
    image = Image.new("1", (width, height), 0)
    draw = ImageDraw.Draw(image)

    for ring, is_outer in iter_rings(geometry):
        xs, ys = to_mercator.transform([p[0] for p in ring], [p[1] for p in ring])
        pixels = [
            ((x - x0) / (x1 - x0) * width, (y1 - y) / (y1 - y0) * height)
            for x, y in zip(xs, ys)
        ]
        draw.polygon(pixels, fill=1 if is_outer else 0)

    return np.array(image, dtype=bool)


# --------------------------------------------------------------------------- lissage


def smooth_masked(values: np.ndarray, sigma_px: float) -> np.ndarray:
    """Lissage gaussien tolérant aux trous : les NaN ne contaminent pas le voisinage."""
    if sigma_px <= 0:
        return values
    valid = np.isfinite(values)
    filled = np.where(valid, values, 0.0)
    weights = valid.astype(np.float64)

    numerator = gaussian_filter(filled, sigma_px, mode="nearest")
    denominator = gaussian_filter(weights, sigma_px, mode="nearest")

    with np.errstate(invalid="ignore", divide="ignore"):
        smoothed = numerator / denominator
    return np.where(valid & (denominator > 1e-6), smoothed, np.nan)


# --------------------------------------------------------------------------- encodage


def encode_terrain_rgb(values: np.ndarray, base: float, interval: float) -> Image.Image:
    """altitude = base + (R*65536 + G*256 + B) * interval ; alpha = 0 hors du lac."""
    height, width = values.shape
    valid = np.isfinite(values)

    encoded = np.zeros((height, width, 4), dtype=np.uint8)
    quantised = np.zeros(values.shape, dtype=np.int64)
    quantised[valid] = np.rint((values[valid] - base) / interval).astype(np.int64)
    quantised = np.clip(quantised, 0, 256 ** 3 - 1)

    encoded[..., 0] = (quantised >> 16) & 0xFF
    encoded[..., 1] = (quantised >> 8) & 0xFF
    encoded[..., 2] = quantised & 0xFF
    encoded[..., 3] = np.where(valid, 255, 0)

    return Image.fromarray(encoded, mode="RGBA")


# --------------------------------------------------------------------------- principal


def main() -> int:
    config = load_model_config()
    grid_cfg = config["grid"]
    encoding = config["encoding"]

    ground_res = float(grid_cfg["resolution_m"])
    margin = float(grid_cfg["margin_m"])

    print("sondes :")
    points, report = collect_points(config)

    with (DATA_DIR / "lake.geojson").open(encoding="utf-8") as fh:
        geometry = json.load(fh)["features"][0]["geometry"]

    to_mercator = Transformer.from_crs(WGS84, WEBMERC, always_xy=True)
    to_lambert = Transformer.from_crs(WGS84, LAMBERT93, always_xy=True)
    mercator_to_lambert = Transformer.from_crs(WEBMERC, LAMBERT93, always_xy=True)

    # Emprise : contour du lac élargi de la marge, en Web Mercator.
    ring_lons = [p[0] for ring, _ in iter_rings(geometry) for p in ring]
    ring_lats = [p[1] for ring, _ in iter_rings(geometry) for p in ring]
    mx, my = to_mercator.transform(ring_lons, ring_lats)
    mid_lat = (min(ring_lats) + max(ring_lats)) / 2

    # Web Mercator dilate les distances de 1/cos(latitude) : on compense pour que la
    # résolution demandée soit bien une résolution au sol.
    scale = 1.0 / math.cos(math.radians(mid_lat))
    res_merc = ground_res * scale
    margin_merc = margin * scale

    x0 = min(mx) - margin_merc
    x1 = max(mx) + margin_merc
    y0 = min(my) - margin_merc
    y1 = max(my) + margin_merc

    width = int(math.ceil((x1 - x0) / res_merc))
    height = int(math.ceil((y1 - y0) / res_merc))
    x1 = x0 + width * res_merc
    y1 = y0 + height * res_merc

    print(f"\ngrille : {width} × {height} px "
          f"({width * height / 1e6:.2f} M cellules) · {ground_res} m au sol")

    # Centres de cellules, en Web Mercator puis en Lambert-93 pour l'interpolation.
    xs = x0 + (np.arange(width) + 0.5) * res_merc
    ys = y1 - (np.arange(height) + 0.5) * res_merc
    grid_x, grid_y = np.meshgrid(xs, ys)
    lam_x, lam_y = mercator_to_lambert.transform(grid_x.ravel(), grid_y.ravel())

    print("triangulation de Delaunay…")
    px, py = to_lambert.transform(points[:, 0], points[:, 1])
    interpolator = LinearNDInterpolator(np.column_stack([px, py]), points[:, 2])

    print("interpolation…")
    values = interpolator(lam_x, lam_y).reshape(height, width)

    print("masquage par le contour du lac…")
    mask = build_mask(geometry, (x0, y0, x1, y1), (width, height), to_mercator)
    values = np.where(mask, values, np.nan)

    sigma_px = float(grid_cfg["smoothing_sigma_m"]) / ground_res
    if sigma_px > 0:
        print(f"lissage gaussien (σ = {grid_cfg['smoothing_sigma_m']} m = {sigma_px:.1f} px)…")
        values = np.where(mask, smooth_masked(values, sigma_px), np.nan)

    valid = np.isfinite(values)
    coverage = valid.sum() / max(mask.sum(), 1)
    print(f"\ncouverture : {valid.sum():,} cellules valides "
          f"({coverage * 100:.1f} % de la surface du lac)")
    if valid.any():
        print(f"altitude de fond : {np.nanmin(values):.2f} → {np.nanmax(values):.2f} m NGF")

    if coverage < 0.95:
        print(f"ATTENTION : {(1 - coverage) * 100:.1f} % de la surface du lac reste sans valeur",
              file=sys.stderr)

    image = encode_terrain_rgb(values, float(encoding["base"]), float(encoding["interval"]))
    png_path = DATA_DIR / "bed.png"
    image.save(png_path, optimize=True)

    (west, east), (south, north) = (
        Transformer.from_crs(WEBMERC, WGS84, always_xy=True).transform([x0, x1], [y0, y1])
    )

    write_json(
        DATA_DIR / "bed.json",
        {
            "description": "Altitude du fond du lac de Vassivière, encodée en Terrain-RGB.",
            "formula": "altitude_m_ngf = base + (R * 65536 + G * 256 + B) * interval ; alpha = 0 → pas de donnée",
            "crs": WEBMERC,
            "width": width,
            "height": height,
            "resolution_ground_m": ground_res,
            "resolution_crs_m": round(res_merc, 4),
            "bbox_3857": [x0, y0, x1, y1],
            "bounds_wgs84": {"west": west, "south": south, "east": east, "north": north},
            "corners_wgs84": [
                [west, north], [east, north], [east, south], [west, south]
            ],
            "encoding": {"base": encoding["base"], "interval": encoding["interval"]},
            "z_range_m_ngf": [
                round(float(np.nanmin(values)), 2),
                round(float(np.nanmax(values)), 2),
            ],
            "coverage_ratio": round(float(coverage), 4),
            "smoothing_sigma_m": grid_cfg["smoothing_sigma_m"],
            "reference_levels": config["reference_levels"],
            "sources": report,
        },
    )

    size_mb = png_path.stat().st_size / 1e6
    print(f"\n→ {png_path.name} ({size_mb:.2f} Mo) et bed.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
