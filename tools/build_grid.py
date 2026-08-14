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
from scipy.ndimage import distance_transform_edt, gaussian_filter, grey_dilation
from scipy.spatial import cKDTree

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


def collect_points(config: dict) -> tuple[np.ndarray, np.ndarray, dict]:
    """Rassemble toutes les sondes, converties en altitude de fond (m NGF).

    Retourne aussi un masque distinguant les sondes réellement mesurées de la
    contrainte de bord : seules les premières alimentent la généralisation biaisée
    vers le haut-fond, la seconde n'étant qu'un artefact de modélisation.
    """
    history = LevelHistory()
    lons: list[float] = []
    lats: list[float] = []
    zs: list[float] = []
    measured: list[bool] = []
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
            measured.append(True)
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
                measured.append(False)
                count += 1
        report["shore_constraint"] = {"label": "Contrainte de bord (trait de côte)", "kept": count}
        print(f"    {'shore':16s} {count:6d} points de contour")

    if not zs:
        raise SystemExit("ERREUR : aucune sonde exploitable")

    return np.column_stack([lons, lats, zs]), np.array(measured, dtype=bool), report


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


# ------------------------------------------------------------- fusion du terrain


def fuse_terrain(
    values: np.ndarray,
    grid_x: np.ndarray,
    grid_y: np.ndarray,
    water_plane: float,
    margin: float,
) -> tuple[np.ndarray, dict]:
    """Fusionne le MNT RGE ALTI là où il décrit du terrain émergé.

    Le levé de 2009 a un angle mort structurel : le bateau sondeur ne passe pas sur
    un haut-fond, qui devient donc un trou dans les données. La triangulation comble
    ce trou en interpolant entre les sondes du pourtour — c'est-à-dire en creusant
    l'obstacle. Ce sont les zones les plus dangereuses qui sont les plus fausses.

    Le LiDAR IGN a survolé le lac à 648,80 m NGF. Au-dessus de cette cote, il mesure
    du vrai terrain, y compris ces hauts-fonds. On retient le maximum des deux : la
    fusion ne peut que rendre le fond moins profond.
    """
    dem_path = DATA_DIR / "rge_alti.npy"
    if not dem_path.exists():
        print("  MNT absent — lancez tools/fetch_rge_alti.py", file=sys.stderr)
        return values, {"available": False}

    with (DATA_DIR / "rge_alti.json").open(encoding="utf-8") as fh:
        meta = json.load(fh)
    dem = np.load(dem_path)

    x0, _, _, y1 = meta["bbox"]
    res = meta["resolution_m"]
    to_lambert = Transformer.from_crs(WEBMERC, meta["crs"], always_xy=True)
    lx, ly = to_lambert.transform(grid_x.ravel(), grid_y.ravel())

    cols = np.floor((lx - x0) / res).astype(np.int64)
    rows = np.floor((y1 - ly) / res).astype(np.int64)
    inside = (cols >= 0) & (cols < meta["width"]) & (rows >= 0) & (rows < meta["height"])

    sampled = np.full(lx.shape, np.nan)
    sampled[inside] = dem[rows[inside], cols[inside]]
    sampled = sampled.reshape(values.shape)

    emerged = np.isfinite(sampled) & (sampled > water_plane + margin)
    raised = emerged & np.isfinite(values) & (sampled > values)
    result = np.where(raised, sampled, values)

    deltas = (sampled - values)[raised]
    return result, {
        "available": True,
        "water_plane_m_ngf": water_plane,
        "cells_terrain": int(emerged.sum()),
        "cells_raised": int(raised.sum()),
        "max_shallower_m": round(float(deltas.max()), 2) if deltas.size else 0.0,
        "median_shallower_m": round(float(np.median(deltas)), 2) if deltas.size else 0.0,
    }


# ------------------------------------- cartographie communautaire Quickdraw


def load_quickdraw_codes(paths: list) -> tuple[np.ndarray, list, list]:
    """Fusionne les mosaïques Quickdraw en une borne de profondeur, au pas de la mosaïque.

    Les deux campagnes couvrent des plages **disjointes** — 0 à 12 m, 12 à 30 m — donc une
    cellule vue par les deux est décrite deux fois et jamais contredite : la campagne
    profonde ne fait que raffiner la dernière bande de la fine, qui dit seulement « plus de
    12 m ». En cas de recouvrement, la borne la plus haute gagne, c'est-à-dire le plus petit
    `dmax` : la même règle prudente que partout ailleurs.

    Piège de la campagne, et il est silencieux : **les couleurs se recyclent**. (0,197,255)
    vaut 12–30 m dans « 0-12m » et 12–14 m dans « 12_30m ». Chaque mosaïque porte donc sa
    propre palette dans son `.json` et c'est celle-là qu'on lit — jamais une constante.

    Le PNG est sans perte et chaque pixel porte la couleur exacte de la palette : la
    comparaison est une égalité stricte, sans tolérance, ce qui rend impossible de confondre
    deux bandes voisines.

    Retourne `(codes, table, floors, metas)` : `codes` vaut 0 hors donnée, sinon 1 + l'indice
    dans `table`, liste croissante des `dmax` distincts des deux palettes. `floors` donne le
    `dmin` associé à chaque entrée de `table` — la profondeur *garantie*, celle qui sert à
    la borne basse.

    Deux bandes de campagnes différentes peuvent partager un `dmax` sans partager leur
    `dmin` : 30 m ferme la bande 12-30 de la campagne fine et la bande 25-30 de la profonde.
    On retient alors le plus petit `dmin`, le seul que les deux garantissent.
    """
    metas = []
    for path in paths:
        with path.with_suffix(".json").open(encoding="utf-8") as fh:
            metas.append(json.load(fh))

    table = sorted({float(band["dmax"]) for meta in metas for band in meta["palette"]})
    floors = [min(float(band["dmin"]) for meta in metas for band in meta["palette"]
                  if float(band["dmax"]) == dmax) for dmax in table]
    codes = None

    for path, meta in zip(paths, metas):
        image = np.array(Image.open(path).convert("RGB"))
        if codes is None:
            codes = np.zeros(image.shape[:2], np.uint8)
        elif image.shape[:2] != codes.shape:
            raise SystemExit(f"ERREUR : {path.name} n'a pas la taille des autres mosaïques")

        candidate = np.zeros(image.shape[:2], np.uint8)
        for band in meta["palette"]:
            red, green, blue = band["rgb"]
            hit = ((image[..., 0] == red) & (image[..., 1] == green) & (image[..., 2] == blue))
            candidate[hit] = table.index(float(band["dmax"])) + 1

        # « La borne la plus haute gagne » = le plus petit dmax, 0 valant « rien dit ».
        better = (candidate > 0) & ((codes == 0) | (candidate < codes))
        codes[better] = candidate[better]
        print(f"    {path.name:22s} {meta['width']}×{meta['height']} px · "
              f"{len(meta['captures'])} captures · accord {meta['overlap_agreement'] * 100:.1f} %")

    return codes, table, floors, metas


def quickdraw_bounds(codes, table, floors, mpp, res_merc, shape, quantile, min_decoded):
    """Ramène la mosaïque au pas de la grille : les deux bornes de profondeur par cellule.

    `dmax` est la profondeur maximale admissible — elle interdit au fond d'être trop bas
    et sert au relèvement. `dmin` est la profondeur *garantie* : la bande la moins profonde
    présente dans la cellule dit qu'un bateau a flotté là, donc qu'il y a au moins tant
    d'eau. Elle interdit au fond d'être trop haut et sert à l'abaissement.

    `dmin` est toujours pris sur la bande la plus haute du bloc, indépendamment de
    `quantile` : c'est le seul énoncé que toute la cellule vérifie.

    Une cellule de 5 m recouvre une cinquantaine de pixels de mosaïque, et il faut choisir
    lequel commande. `quantile` = 0 retient le plus haut-fond du bloc, 0,5 la médiane.

    Zéro, donc le minimum, est la valeur retenue. L'accord entre deux captures qui se
    recouvrent n'est que de 88 %, mais le désaccord se loge aux **frontières** de bande, où
    un pixel de décalage suffit à changer de couleur : prendre le minimum revient à dilater
    chaque bande peu profonde d'environ une cellule, ce que `shoal_bias` fait déjà
    volontairement à 15 m sur les sondes mesurées. Mesuré sur la campagne fine : 90,1 ha
    relevés au minimum, 71,1 au quantile 0,25, 63,8 à la médiane.

    Les cellules trop peu décodées (bord de mosaïque, trou d'étiquette) sont écartées :
    trois pixels ne décrivent pas une cellule de 25 m².
    """
    height, width = shape
    rows_m, cols_m = codes.shape
    col_of = np.minimum((((np.arange(cols_m) + 0.5) * mpp) / res_merc).astype(np.int64), width - 1)
    row_of = np.minimum((((np.arange(rows_m) + 0.5) * mpp) / res_merc).astype(np.int64), height - 1)
    ucols, cstarts = np.unique(col_of, return_index=True)
    urows, rstarts = np.unique(row_of, return_index=True)
    box = np.ix_(urows, ucols)

    def blocks(mask: np.ndarray) -> np.ndarray:
        """Somme d'un masque de mosaïque par cellule de grille, en deux réductions."""
        partial = np.add.reduceat(mask, rstarts, axis=0, dtype=np.int32)
        partial = np.add.reduceat(partial, cstarts, axis=1)
        out = np.zeros(shape, np.int32)
        out[box] = partial
        return out

    pixels = np.zeros(shape, np.int32)
    pixels[box] = (np.diff(np.append(rstarts, rows_m))[:, None]
                   * np.diff(np.append(cstarts, cols_m))[None, :])

    decoded = blocks(codes > 0)
    needed = np.maximum(quantile * decoded, 1.0)

    dmax = np.full(shape, np.nan, np.float32)
    dmin = np.full(shape, np.nan, np.float32)
    cumulative = np.zeros(shape, np.int32)
    settled = np.zeros(shape, bool)
    seen = np.zeros(shape, bool)
    for code, depth in enumerate(table, start=1):
        present = blocks(codes == code)
        cumulative += present
        reached = ~settled & (decoded > 0) & (cumulative >= needed)
        dmax[reached] = depth
        settled |= reached
        # Première bande rencontrée, donc la moins profonde du bloc : sa borne basse est
        # la seule profondeur que toute la cellule garantit.
        first = ~seen & (present > 0)
        dmin[first] = floors[code - 1]
        seen |= first

    thin = decoded < min_decoded * np.maximum(pixels, 1)
    dmax[thin] = np.nan
    dmin[thin] = np.nan
    return dmax, dmin


def measured_floor(points, measured, bbox, res_merc, shape, radius_px, to_mercator):
    """Altitude de fond imposée par les sondes réellement mesurées, dilatée d'un rayon.

    Sert de garde-fou à la borne basse de Quickdraw, qu'elle empêche de descendre sous une
    mesure du levé de 2009. Renvoie -inf là où aucune sonde mesurée n'est assez proche.
    """
    x0, _, _, y1 = bbox
    height, width = shape
    subset = points[measured]
    mx, my = to_mercator.transform(subset[:, 0], subset[:, 1])
    cols = np.floor((np.asarray(mx) - x0) / res_merc).astype(np.int64)
    rows = np.floor((y1 - np.asarray(my)) / res_merc).astype(np.int64)
    inside = (cols >= 0) & (cols < width) & (rows >= 0) & (rows < height)
    stamped = np.full(shape, -np.inf)
    np.maximum.at(stamped, (rows[inside], cols[inside]), subset[inside, 2])
    return grey_dilation(stamped, footprint=disk_footprint(radius_px),
                         mode="constant", cval=-np.inf)


def fuse_quickdraw(values, mask, bbox, res_merc, ground_res, z_ac, cfg,
                   points=None, measured=None, to_mercator=None):
    """Relève le fond là où la cartographie communautaire interdit d'être si profond.

    Quickdraw enregistre la profondeur lue par des dizaines de sondeurs indépendants, sur
    des trajets quotidiens de pêche : là où le levé de 2009 n'a qu'une interpolation entre
    deux traces distantes de 150 m, la communauté est passée. Ce n'est pas une mesure
    ponctuelle — une bande dit seulement « entre 4 et 6 m » — mais un **encadrement**, et
    c'est déjà beaucoup là où le modèle ne repose sur rien.

    Une bande donne **deux** bornes, et le modèle a besoin des deux :

    - `z >= z_ac - dmax` interdit au fond d'être trop bas. C'est le relèvement, dans le
      droit fil de la fusion du MNT, et il est sans risque : au pire il annonce moins
      d'eau qu'il n'y en a ;
    - `z <= z_ac - dmin` interdit au fond d'être trop haut. Un bateau a flotté là, donc il
      y a au moins `dmin` d'eau. C'est ce qui répare le trait de côte : la contrainte de
      bord épingle une profondeur nulle sur le contour BD TOPO, qui est celui de la
      retenue normale, si bien que toute la frange sort de l'eau dès que le lac baisse —
      ports compris, qu'aucun levé n'a jamais sondés.

    L'abaissement est le seul mécanisme du modèle qui puisse annoncer **plus** d'eau qu'il
    n'y en a. Il porte donc deux garde-fous, tous deux obligatoires :

    - il ne descend jamais sous l'altitude d'une sonde réellement mesurée du voisinage
      (`lower_guard_radius_m`) — le levé de 2009 garde le dernier mot là où il est passé ;
    - il s'arrête `lower_margin_m` au-dessus de la borne stricte, parce que `z_ac` est une
      valeur centrale à ±1,5 m près et non une précision.

    `z_ac` est solidaire de `Z_2009` : il a été mesuré en comparant les isobathes
    communautaires à ce modèle-ci. Confirmer l'un sans déplacer l'autre fausserait
    silencieusement ce relèvement (config/model.json, `solidarity_note`).
    """
    paths = [DATA_DIR / name for name in cfg["mosaics"]]
    missing = [p for p in paths if not p.exists()]
    if missing:
        print(f"  mosaïque absente : {', '.join(p.name for p in missing)} — "
              f"lancez tools/qd_georef.py puis tools/qd_mosaic.py", file=sys.stderr)
        return values, None, {"available": False}

    codes, table, floors, metas = load_quickdraw_codes(paths)
    mpp = float(metas[0]["mpp_merc"])

    # Une mosaïque décalée d'une emprise ne se voit sur aucune image : elle produit une
    # carte plausible et fausse. On refuse plutôt que d'y croire.
    for meta in metas:
        if max(abs(a - b) for a, b in zip(meta["bbox_3857"], bbox)) > 0.5:
            raise SystemExit("ERREUR : une mosaïque Quickdraw n'a pas l'emprise de la "
                             "grille — reconstruire avec tools/qd_mosaic.py")
        if abs(float(meta["mpp_merc"]) - mpp) > 1e-9:
            raise SystemExit("ERREUR : les mosaïques n'ont pas la même résolution")
        if abs(float(meta["z_ac_m_ngf"]) - z_ac) > 1e-6:
            raise SystemExit(f"ERREUR : la mosaïque annonce z_ac = {meta['z_ac_m_ngf']} "
                             f"alors que config/model.json dit {z_ac}")

    quantile = float(cfg.get("aggregate_quantile", 0.0))
    min_decoded = float(cfg.get("min_decoded_fraction", 0.25))
    dmax, dmin = quickdraw_bounds(codes, table, floors, mpp, res_merc, values.shape,
                                  quantile, min_decoded)

    # Distance au rivage, pour vérifier plutôt que supposer que la frange côtière ne se
    # fait pas relever : la contrainte de bord y place déjà le fond ~1,5 m trop haut.
    shore_m = distance_transform_edt(mask) * ground_res
    fringe = float(cfg.get("min_shore_distance_m", 0.0))
    if fringe > 0:
        dmax[shore_m < fringe] = np.nan
        dmin[shore_m < fringe] = np.nan

    bound = z_ac - dmax
    constrained = mask & np.isfinite(bound)
    raised = constrained & np.isfinite(values) & (bound > values)
    result = np.where(raised, bound, values)

    # --- borne haute : « un bateau a flotté ici, donc il y a au moins dmin d'eau »
    lower_cfg = cfg.get("lower_bound", {})
    lowered = np.zeros(values.shape, bool)
    ceiling = np.full(values.shape, np.nan)
    lower_stats = {"enabled": False}
    if lower_cfg.get("enabled"):
        margin = float(lower_cfg.get("lower_margin_m", 0.5))
        guard_r = float(lower_cfg.get("lower_guard_radius_m", 25.0))
        ceiling = z_ac - dmin + margin
        if points is not None and measured is not None and measured.any():
            floor = measured_floor(points, measured, bbox, res_merc, values.shape,
                                   guard_r / ground_res, to_mercator)
            ceiling = np.maximum(ceiling, floor)
        lowered = mask & np.isfinite(ceiling) & np.isfinite(result) & (result > ceiling)
        result = np.where(lowered, ceiling, result)
        lower_stats = {
            "enabled": True,
            "lower_margin_m": margin,
            "lower_guard_radius_m": guard_r,
            "cells_lowered": int(lowered.sum()),
            "lowered_ha": round(float(lowered.sum()) * ground_res ** 2 / 1e4, 1),
        }

    cell_ha = ground_res ** 2 / 1e4
    deltas = (bound - values)[raised]
    stats = {
        "available": True,
        "z_ac_m_ngf": z_ac,
        "solidary_with": "ofb2009",
        "mosaics": [p.name for p in paths],
        "aggregate_quantile": quantile,
        "min_decoded_fraction": min_decoded,
        "min_shore_distance_m": fringe,
        "cells_constrained": int(constrained.sum()),
        "cells_raised": int(raised.sum()),
        "constrained_ha": round(float(constrained.sum()) * cell_ha, 1),
        "raised_ha": round(float(raised.sum()) * cell_ha, 1),
        "lake_share_constrained": round(float(constrained.sum() / max(mask.sum(), 1)), 4),
        "max_shallower_m": round(float(deltas.max()), 2) if deltas.size else 0.0,
        "median_shallower_m": round(float(np.median(deltas)), 2) if deltas.size else 0.0,
        "ha_above": {f"{t:g}": round(float((deltas > t).sum()) * cell_ha, 1)
                     for t in (0, 2, 3, 5, 8)},
        "lower_bound": lower_stats,
        "shore_fringe": {},
    }

    if lowered.any():
        drops = (values - ceiling)[lowered]
        # Ce que l'abaissement remet sous l'eau à une cote d'été typique : c'est la
        # mesure de la plainte de terrain — les ports à sec sur la carte.
        for level in (648.0, 647.0, 646.0):
            was_dry = mask & np.isfinite(values) & (values >= level)
            now_wet = was_dry & (result < level)
            stats["lower_bound"][f"dry_recovered_ha_at_{level:g}"] = round(
                float(now_wet.sum()) * cell_ha, 1)
        stats["lower_bound"].update({
            "median_deeper_m": round(float(np.median(drops)), 2),
            "max_deeper_m": round(float(drops.max()), 2),
            "ha_below": {f"{t:g}": round(float((drops > t).sum()) * cell_ha, 1)
                         for t in (0, 1, 2, 5)},
        })

    # Décision du § 10 d'ANALYSE.md : laisser faire la frange ou la masquer. On mesure.
    for label, low, high in (("0-25", 0, 25), ("25-50", 25, 50),
                             ("50-100", 50, 100), ("100+", 100, np.inf)):
        band = constrained & (shore_m >= low) & (shore_m < high)
        hit = raised & band
        down = lowered & band
        stats["shore_fringe"][label] = {
            "constrained_ha": round(float(band.sum()) * cell_ha, 1),
            "raised_ha": round(float(hit.sum()) * cell_ha, 1),
            "share_raised": round(float(hit.sum() / max(band.sum(), 1)), 4),
            "median_shallower_m": (round(float(np.median((bound - values)[hit])), 2)
                                   if hit.any() else 0.0),
            "lowered_ha": round(float(down.sum()) * cell_ha, 1),
            "median_deeper_m": (round(float(np.median((values - ceiling)[down])), 2)
                                if down.any() else 0.0),
        }

    return result, {"dmax": dmax, "change": np.where(np.isfinite(result) & np.isfinite(values),
                                                     result - values, 0.0)}, stats


# --------------------------------------------------------- couverture du levé


def coverage_map(points, measured, grid_x, grid_y, to_mercator, ground_res, res_merc):
    """Distance à la sonde mesurée la plus proche, en mètres au sol, par cellule.

    Le levé de 2009 est fait de traces largement espacées : dans les grands bassins,
    plus de 150 m séparent deux passages. Entre elles, la triangulation relie des sondes
    éloignées et produit une valeur qui ne repose sur aucune mesure — un haut-fond y est
    non seulement invisible, mais hérite de la profondeur des fosses voisines.

    Cette distance est le seul indicateur honnête de ce que vaut le modèle localement.
    Elle est embarquée avec la grille pour que l'application puisse le signaler à
    l'écran plutôt que de présenter une interpolation avec l'aplomb d'une mesure.
    """
    subset = points[measured]
    mx, my = to_mercator.transform(subset[:, 0], subset[:, 1])
    tree = cKDTree(np.column_stack([mx, my]))
    distances, _ = tree.query(np.column_stack([grid_x.ravel(), grid_y.ravel()]))
    # Le mercator dilate les distances ; on repasse en mètres au sol.
    return (distances.reshape(grid_x.shape) * (ground_res / res_merc)).astype(np.float32)


# ------------------------------------------------- généralisation « haut-fond »


def disk_footprint(radius_px: float) -> np.ndarray:
    span = int(math.ceil(radius_px))
    offsets = np.arange(-span, span + 1)
    dy, dx = np.meshgrid(offsets, offsets, indexing="ij")
    return (dx * dx + dy * dy) <= radius_px * radius_px


def shoal_bias(
    values: np.ndarray,
    points: np.ndarray,
    measured: np.ndarray,
    bbox,
    res: float,
    radius_m: float,
    to_mercator,
) -> tuple[np.ndarray, dict]:
    """Interdit au modèle d'être plus profond qu'une sonde mesurée du voisinage.

    Le lissage et l'interpolation moyennent : un haut-fond ponctuel s'y dilue et le
    modèle annonce alors plus d'eau qu'il n'y en a. C'est la seule erreur réellement
    dangereuse pour un bateau, l'inverse ne faisant que rendre le modèle prudent.

    On rastérise donc les sondes mesurées, on dilate leur altitude de fond dans un
    rayon couvrant l'incertitude de position, et on retient le maximum avec le modèle
    interpolé. Rien n'est inventé : le résultat ne s'écarte du modèle que vers moins
    d'eau, et seulement à proximité d'une mesure réelle.
    """
    x0, _, _, y1 = bbox
    height, width = values.shape

    subset = points[measured]
    mx, my = to_mercator.transform(subset[:, 0], subset[:, 1])
    cols = np.floor((np.asarray(mx) - x0) / res).astype(np.int64)
    rows = np.floor((y1 - np.asarray(my)) / res).astype(np.int64)

    inside = (cols >= 0) & (cols < width) & (rows >= 0) & (rows < height)
    cols, rows, zs = cols[inside], rows[inside], subset[inside, 2]

    # Une cellule peut recevoir plusieurs sondes : on garde la moins profonde.
    stamped = np.full(values.shape, -np.inf)
    np.maximum.at(stamped, (rows, cols), zs)

    radius_px = radius_m / res
    dilated = grey_dilation(stamped, footprint=disk_footprint(radius_px), mode="constant", cval=-np.inf)

    finite = np.isfinite(values)
    raised = finite & np.isfinite(dilated) & (dilated > values)
    result = np.where(raised, dilated, values)

    deltas = (dilated - values)[raised]
    stats = {
        "radius_m": radius_m,
        "cells_raised": int(raised.sum()),
        "cells_valid": int(finite.sum()),
        "max_shallower_m": round(float(deltas.max()), 2) if deltas.size else 0.0,
        "mean_shallower_m": round(float(deltas.mean()), 3) if deltas.size else 0.0,
    }
    return result, stats


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
    points, measured, report = collect_points(config)

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

    terrain_cfg = grid_cfg.get("terrain_source", {})
    terrain_stats = None
    if terrain_cfg.get("enabled"):
        water_plane = float(config["reference_levels"]["rge_alti"]["value_m_ngf"])
        print(f"fusion du terrain émergé mesuré au LiDAR (> {water_plane} m NGF)…")
        values, terrain_stats = fuse_terrain(
            values, grid_x, grid_y, water_plane, float(terrain_cfg.get("margin_m", 0.05))
        )
        values = np.where(mask, values, np.nan)
        if terrain_stats.get("available"):
            print(f"  {terrain_stats['cells_raised']:,} cellules relevées sur "
                  f"{terrain_stats['cells_terrain']:,} de terrain · "
                  f"médiane {terrain_stats['median_shallower_m']:.2f} m, "
                  f"maximum {terrain_stats['max_shallower_m']:.2f} m moins d'eau")

    quickdraw_cfg = grid_cfg.get("quickdraw_source", {})
    quickdraw_stats = None
    quickdraw_layer = None
    if quickdraw_cfg.get("enabled"):
        z_ac = float(config["reference_levels"][quickdraw_cfg["reference_level_key"]]["value_m_ngf"])
        print(f"relèvement par la cartographie communautaire Quickdraw (z_ac = {z_ac} m NGF)…")
        before = values.copy()
        values, quickdraw_layer, quickdraw_stats = fuse_quickdraw(
            values, mask, (x0, y0, x1, y1), res_merc, ground_res, z_ac, quickdraw_cfg,
            points, measured, to_mercator,
        )
        values = np.where(mask, values, np.nan)
        if quickdraw_stats.get("available"):
            cell_area = ground_res ** 2
            volume = [float(np.nansum(np.clip(647.0 - v, 0, None)[mask]) * cell_area / 1e6)
                      for v in (before, values)]
            quickdraw_stats["volume_647_hm3"] = [round(v, 2) for v in volume]
            quickdraw_stats["volume_removed_hm3"] = round(volume[0] - volume[1], 2)
            print(f"  {quickdraw_stats['constrained_ha']:.0f} ha encadrés "
                  f"({quickdraw_stats['lake_share_constrained'] * 100:.1f} % du lac) · "
                  f"{quickdraw_stats['cells_raised']:,} cellules relevées "
                  f"({quickdraw_stats['raised_ha']:.1f} ha) · "
                  f"médiane {quickdraw_stats['median_shallower_m']:.2f} m, "
                  f"maximum {quickdraw_stats['max_shallower_m']:.2f} m moins d'eau")
            print("    " + " · ".join(f"> {t} m : {ha} ha"
                                      for t, ha in quickdraw_stats["ha_above"].items()))
            lb = quickdraw_stats.get("lower_bound", {})
            if lb.get("enabled"):
                print(f"  borne basse (« un bateau a flotté ici ») : "
                      f"{lb['cells_lowered']:,} cellules abaissées ({lb['lowered_ha']:.1f} ha) · "
                      f"médiane {lb.get('median_deeper_m', 0):.2f} m, "
                      f"maximum {lb.get('max_deeper_m', 0):.2f} m plus d'eau")
                print(f"    remis sous l'eau : "
                      + " · ".join(f"{lb.get(f'dry_recovered_ha_at_{lv:g}', 0)} ha à {lv:g} m"
                                   for lv in (648.0, 647.0, 646.0)))
            removed = quickdraw_stats["volume_removed_hm3"]
            print(f"    volume à 647 m : {volume[0]:.2f} → {volume[1]:.2f} hm³ "
                  f"({abs(removed):.2f} {'retirés' if removed >= 0 else 'ajoutés'})")
            print("    par distance au rivage — part des cellules encadrées qui sont relevées :")
            for label, band in quickdraw_stats["shore_fringe"].items():
                print(f"      {label:>7s} m : {band['share_raised'] * 100:5.1f} % de "
                      f"{band['constrained_ha']:6.1f} ha encadrés · "
                      f"médiane {band['median_shallower_m']:.2f} m")

    shoal_cfg = grid_cfg.get("shoal_bias", {})
    shoal_stats = None
    if shoal_cfg.get("enabled"):
        radius_m = float(shoal_cfg["radius_m"])
        print(f"généralisation biaisée vers le haut-fond (rayon {radius_m} m)…")
        values, shoal_stats = shoal_bias(
            values, points, measured,
            (x0, y0, x1, y1), res_merc, radius_m * scale, to_mercator,
        )
        values = np.where(mask, values, np.nan)
        ratio = shoal_stats["cells_raised"] / max(shoal_stats["cells_valid"], 1)
        print(f"  {shoal_stats['cells_raised']:,} cellules relevées ({ratio * 100:.1f} %) · "
              f"moyenne {shoal_stats['mean_shallower_m']:.2f} m, "
              f"maximum {shoal_stats['max_shallower_m']:.2f} m moins d'eau")

    valid = np.isfinite(values)
    coverage = valid.sum() / max(mask.sum(), 1)
    print(f"\ncouverture : {valid.sum():,} cellules valides "
          f"({coverage * 100:.1f} % de la surface du lac)")
    if valid.any():
        print(f"altitude de fond : {np.nanmin(values):.2f} → {np.nanmax(values):.2f} m NGF")

    if coverage < 0.95:
        print(f"ATTENTION : {(1 - coverage) * 100:.1f} % de la surface du lac reste sans valeur",
              file=sys.stderr)

    print("\ndistance à la sonde mesurée la plus proche…")
    distance_map = coverage_map(points, measured, grid_x, grid_y, to_mercator, ground_res, res_merc)
    in_lake = distance_map[mask]
    coverage_stats = {
        "unit": "m",
        "max_encoded_m": 255,
        "median_m": round(float(np.median(in_lake)), 1),
        "max_m": round(float(in_lake.max()), 1),
        "share_within_25m": round(float((in_lake <= 25).mean()), 4),
        "share_within_60m": round(float((in_lake <= 60).mean()), 4),
        "share_beyond_60m": round(float((in_lake > 60).mean()), 4),
    }
    for limit in (25, 50, 100, 150):
        print(f"  à moins de {limit:3d} m : {(in_lake <= limit).mean() * 100:5.1f} %")
    print(f"  médiane {coverage_stats['median_m']:.0f} m · maximum {coverage_stats['max_m']:.0f} m")

    # Les trois états de la carte de fiabilité. « Encadré » n'est pas « mesuré » : la
    # communauté donne un intervalle de profondeur, pas une sonde au décimètre. Mais ce
    # n'est plus « interpolé » non plus — un bateau y est passé.
    if quickdraw_layer is not None:
        bounded = mask & np.isfinite(quickdraw_layer["dmax"])
        blind = mask & (distance_map > 60) & ~bounded
        coverage_stats["share_bounded"] = round(float(bounded.sum() / max(mask.sum(), 1)), 4)
        coverage_stats["share_blind"] = round(float(blind.sum() / max(mask.sum(), 1)), 4)
        print(f"  encadré par la communauté : {coverage_stats['share_bounded'] * 100:5.1f} % "
              f"du lac · reste aveugle (> 60 m d'une sonde et sans encadrement) : "
              f"{coverage_stats['share_blind'] * 100:.1f} %")

    # coverage.png, désormais à trois canaux : la carte de fiabilité doit distinguer trois
    # états, et non plus deux. Avant l'apport communautaire, une cellule était mesurée ou
    # interpolée, et la distance à la sonde suffisait à le dire. Une cellule encadrée par
    # Quickdraw n'est ni l'un ni l'autre : personne n'y a mesuré une profondeur au
    # décimètre, mais un bateau y est passé et sa bande interdit un haut-fond. Garder le
    # seul canal de distance rendrait le hachurage trompeur dans l'autre sens — il
    # crierait « non sondé » sur des zones désormais encadrées.
    #
    #   R = distance à la sonde mesurée la plus proche, en m, plafonnée à 255 (inchangé) ;
    #   G = borne de profondeur communautaire, en m arrondie au-dessus ; 0 = aucune ;
    #   B = changement appliqué par cette couche, signé : 128 = aucun, au-dessus la couche
    #       a relevé le fond, en dessous elle l'a abaissé, par pas de 0,2 m (±25,4 m).
    #
    # B a dû devenir signé : depuis que la borne basse existe, la couche peut aussi faire
    # descendre le fond, et un canal non signé ne saurait pas le dire.
    #
    # G et B sont aussi ce qui rend la couche Quickdraw identifiable cellule par cellule,
    # donc retirable d'un seul geste — obligation de licence, voir ANALYSE.md § 9.
    channels = np.zeros((height, width, 3), np.uint8)
    channels[..., 0] = np.where(mask, np.clip(distance_map, 0, 255), 255).astype(np.uint8)
    channels[..., 2] = 128
    if quickdraw_layer is not None:
        bound = np.nan_to_num(quickdraw_layer["dmax"], nan=0.0)
        channels[..., 1] = np.clip(np.ceil(bound), 0, 255).astype(np.uint8)
        channels[..., 2] = np.clip(
            128 + np.rint(quickdraw_layer["change"] * 5), 0, 255).astype(np.uint8)
    Image.fromarray(channels, mode="RGB").save(DATA_DIR / "coverage.png", optimize=True)

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
            "terrain_source": terrain_stats,
            "quickdraw_source": quickdraw_stats,
            "shoal_bias": shoal_stats,
            "coverage": {
                **coverage_stats,
                "file": "coverage.png",
                "channels": {
                    "R": "distance en mètres à la sonde mesurée la plus proche, plafonnée à 255",
                    "G": "borne de profondeur de la cartographie communautaire Quickdraw, en "
                         "mètres arrondis au-dessus ; 0 = aucun encadrement",
                    "B": "changement appliqué par cette couche, signé : 128 = aucun, "
                         "au-dessus elle a relevé le fond, en dessous elle l'a abaissé, "
                         "par pas de 0,2 m — soit (B - 128) / 5 mètres, de -25,6 à +25,4",
                },
                "note": (
                    "Image RGB, même emprise et même taille que bed.png. Trois états, et non "
                    "deux : mesuré (R faible), encadré par la communauté Quickdraw (R élevé "
                    "mais G > 0 — personne n'y a mesuré au décimètre, mais un bateau y est "
                    "passé : sa bande interdit un haut-fond, et garantit aussi une hauteur "
                    "d'eau minimale), interpolé (R élevé et G = 0 — "
                    "la valeur du modèle ne repose alors sur aucune mesure). G et B rendent "
                    "la couche communautaire identifiable cellule par cellule."
                ),
            },
            "reference_levels": config["reference_levels"],
            "sources": report,
        },
    )

    size_mb = png_path.stat().st_size / 1e6
    print(f"\n→ {png_path.name} ({size_mb:.2f} Mo) et bed.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
