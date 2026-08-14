"""Construit la grille d'altitude de fond à partir de la **seule** cartographie communautaire.

Deuxième fond de carte du dépôt, autonome et interchangeable avec celui du levé de 2009 :

    bandes Quickdraw ── encadrement [dmin, dmax] par cellule ──┐
                                                              ├── détente sous contrainte
    contour du lac ─────────────── masque ────────────────────┘        │
                                                                       ├── PNG Terrain-RGB
    MNT RGE ALTI (terrain émergé, facultatif) ─────────────────────────┘

Pourquoi une deuxième carte plutôt qu'un réglage de la première. Beaucoup de plaisanciers
du lac naviguent à la carte Garmin seule et n'ont pas de raison de faire confiance à un
levé de 2009 qu'ils n'ont pas vu ; le dépôt leur doit une carte qu'ils reconnaissent, où
rien ne vient d'ailleurs. À l'inverse, le levé de 2009 est une mesure au décimètre là où
il est passé, ce que la communauté n'égalera jamais. Les deux cartes se valent selon ce
qu'on cherche, aucune ne remplace l'autre : l'application les échange d'un réglage.

**La géométrie est celle de `build_grid.py`**, au pixel près (`grid_geometry`) : c'est ce
qui permet à l'application d'échanger les deux fonds tableau contre tableau, sans toucher
au cadrage de la couche.

Ce qu'une bande de couleur dit, et ce qu'elle ne dit pas. Elle ne donne jamais une
profondeur : elle donne un **intervalle**, « entre 4 et 6 m ». Une carte a pourtant besoin
d'une valeur par cellule, et le choix de cette valeur est tout le sujet de ce fichier.

  - Prendre le fond de l'intervalle (le plus profond) trahirait la doctrine du dépôt : sur
    l'eau, l'erreur doit toujours aller vers le haut-fond.
  - Prendre le sommet (le moins profond) partout donne un escalier de plateaux. Ce n'est
    pas seulement laid : un fond en marches n'a plus de gradient, et le contour de sécurité
    de l'application — calculé par `fwidth` dans le shader — **disparaît** dès que le seuil
    tombe entre deux paliers. Une carte qui n'affiche plus sa limite de sécurité là où elle
    compte est pire que terrassée.
  - D'où la **détente sous contrainte** : on part du sommet de l'intervalle, la valeur
    prudente, on lisse doucement, et après chaque lissage on **replie** la valeur dans son
    intervalle. Le résultat est continu, il porte un gradient partout, et chaque cellule
    reste dans la bande que la communauté lui a donnée — invariant vérifiable, et vérifié
    par `/test/`. C'est la reconstruction classique d'un relief à partir de ses isobathes,
    à ceci près que la contrainte est un encadrement et non une courbe.

Ce qui n'y entre pas : aucune sonde de 2009, aucune triangulation, aucune contrainte de
bord, aucune généralisation `shoal_bias`. Là où la communauté n'est jamais passée, la
carte n'a **rien** — pas d'extrapolation, une cellule vide. C'est le point où elle est la
plus honnête et la moins confortable.

Ce qui y entre quand même, et il faut le dire : le terrain émergé du MNT RGE ALTI, au-dessus
du plan d'eau du LiDAR (648,80 m NGF). Ce n'est pas le levé de 2009 — c'est une mesure
aéroportée indépendante de l'IGN — et cela ne concerne que des îlots et des berges au-dessus
de presque toutes les cotes de navigation. Se désactive par `terrain_source` dans la config.

Sorties : data/bed_quickdraw.png, data/bed_quickdraw.json, data/coverage_quickdraw.png

Usage :
    python tools/build_grid_quickdraw.py
"""

from __future__ import annotations

import json
import sys

import numpy as np
from PIL import Image
from pyproj import Transformer

from build_grid import (
    WEBMERC,
    WGS84,
    encode_terrain_rgb,
    grid_geometry,
    load_quickdraw_codes,
    quickdraw_bounds,
    smooth_masked,
)
from common import DATA_DIR, load_model_config, write_json


def relax_envelope(low, high, sigma_px, iterations):
    """Surface continue la plus proche du sommet de l'encadrement, sans en sortir.

    `low` et `high` sont les altitudes extrêmes que la bande autorise (`low` = z_ac - dmax,
    `high` = z_ac - dmin), NaN là où la communauté n'a rien dit.

    On part de `high`, la valeur prudente — le fond le plus haut compatible avec la donnée —
    puis on alterne lissage et repli dans l'encadrement. Chaque lissage fait descendre les
    cellules voisines d'une bande plus profonde ; le repli les empêche d'aller plus bas que
    leur propre bande ne le permet. Au bout de quelques passes, chaque bande porte une rampe
    qui va de son sommet à son plancher au contact de la bande suivante, et les isobathes
    tombent exactement sur les frontières de couleur.

    Le repli est ce qui rend l'opération sûre : quel que soit le nombre d'itérations, la
    sortie reste dans l'encadrement d'entrée. Le lissage ne peut donc rien inventer, il ne
    fait que choisir, à l'intérieur de ce que la communauté autorise, la surface qui a un
    gradient. Zéro itération redonne l'escalier prudent.
    """
    values = high.copy()
    for _ in range(iterations):
        values = smooth_masked(values, sigma_px)
        values = np.clip(values, low, high)
    return values


def fuse_emerged_terrain(values, mask, grid_x, grid_y, water_plane, margin):
    """Ajoute le terrain émergé mesuré au LiDAR : îlots et berges hautes.

    Deux différences avec `fuse_terrain` de la chaîne 2009. D'abord, la carte communautaire
    a des **trous** — là où aucun bateau n'est passé, donc en particulier sur les îlots — et
    ces trous doivent pouvoir être **remplis** par le terrain, pas seulement relevés. Ensuite
    il n'y a ici aucune sonde à protéger : le maximum se prend entre la bande et le MNT.
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

    emerged = mask & np.isfinite(sampled) & (sampled > water_plane + margin)
    filled = emerged & ~np.isfinite(values)
    raised = emerged & np.isfinite(values) & (sampled > values)
    result = np.where(filled | raised, sampled, values)

    deltas = (sampled - values)[raised]
    return result, {
        "available": True,
        "water_plane_m_ngf": water_plane,
        "cells_terrain": int(emerged.sum()),
        "cells_filled": int(filled.sum()),
        "cells_raised": int(raised.sum()),
        "max_shallower_m": round(float(deltas.max()), 2) if deltas.size else 0.0,
    }


def main() -> int:
    config = load_model_config()
    grid_cfg = config["grid"]
    encoding = config["encoding"]
    source_cfg = grid_cfg["quickdraw_source"]
    cfg = grid_cfg.get("quickdraw_only", {})

    geom = grid_geometry(config)
    x0, y0, x1, y1 = geom["bbox"]
    width, height = geom["width"], geom["height"]
    mask = geom["mask"]
    ground_res, res_merc = geom["ground_res"], geom["res_merc"]
    cell_ha = ground_res ** 2 / 1e4

    z_ac = float(config["reference_levels"][source_cfg["reference_level_key"]]["value_m_ngf"])
    print(f"grille : {width} × {height} px · {ground_res} m au sol · "
          f"z_ac = {z_ac} m NGF")

    paths = [DATA_DIR / name for name in source_cfg["mosaics"]]
    missing = [p for p in paths if not p.exists()]
    if missing:
        raise SystemExit(f"ERREUR : mosaïque absente ({', '.join(p.name for p in missing)}) — "
                         "lancez tools/qd_georef.py puis tools/qd_mosaic.py")

    print("décodage des mosaïques…")
    codes, table, floors, metas = load_quickdraw_codes(paths)
    mpp = float(metas[0]["mpp_merc"])

    # Une mosaïque décalée d'une emprise ne se voit sur aucune image : elle produit une
    # carte plausible et fausse. Mêmes vérifications que dans la chaîne 2009.
    for meta in metas:
        if max(abs(a - b) for a, b in zip(meta["bbox_3857"], (x0, y0, x1, y1))) > 0.5:
            raise SystemExit("ERREUR : une mosaïque n'a pas l'emprise de la grille — "
                             "reconstruire avec tools/qd_mosaic.py")
        if abs(float(meta["mpp_merc"]) - mpp) > 1e-9:
            raise SystemExit("ERREUR : les mosaïques n'ont pas la même résolution")
        if abs(float(meta["z_ac_m_ngf"]) - z_ac) > 1e-6:
            raise SystemExit(f"ERREUR : la mosaïque annonce z_ac = {meta['z_ac_m_ngf']} "
                             f"alors que config/model.json dit {z_ac}")

    quantile = float(cfg.get("aggregate_quantile", source_cfg.get("aggregate_quantile", 0.0)))
    min_decoded = float(cfg.get("min_decoded_fraction",
                                source_cfg.get("min_decoded_fraction", 0.25)))
    dmax, dmin = quickdraw_bounds(codes, table, floors, mpp, res_merc, (height, width),
                                  quantile, min_decoded)

    framed = mask & np.isfinite(dmax) & np.isfinite(dmin)
    dmax = np.where(framed, dmax, np.nan)
    dmin = np.where(framed, dmin, np.nan)
    print(f"  {framed.sum() * cell_ha:.0f} ha encadrés "
          f"({100 * framed.sum() / max(mask.sum(), 1):.1f} % du lac) · "
          f"{(mask & ~framed).sum() * cell_ha:.0f} ha sans donnée")

    low = z_ac - dmax   # fond le plus bas que la bande autorise
    high = z_ac - dmin  # fond le plus haut : la valeur prudente
    span = (high - low)[framed]
    print(f"  largeur d'encadrement : médiane {np.median(span):.1f} m, "
          f"maximum {span.max():.1f} m")

    relax = cfg.get("relaxation", {})
    iterations = int(relax.get("iterations", 24))
    sigma_px = float(relax.get("sigma_m", 10.0)) / ground_res
    print(f"détente sous contrainte ({iterations} passes, σ = {relax.get('sigma_m', 10.0)} m)…")
    values = relax_envelope(low, high, sigma_px, iterations)

    # L'invariant du fichier, vérifié plutôt qu'affirmé : rien ne sort de l'encadrement.
    inside = ~framed | ((values >= low - 1e-6) & (values <= high + 1e-6))
    if not inside.all():
        raise SystemExit(f"ERREUR : {int((~inside).sum())} cellules hors de leur encadrement")
    lowered = framed & (values < high - 1e-6)
    print(f"  {lowered.sum() * cell_ha:.0f} ha descendus sous la valeur prudente · "
          f"médiane {np.median((high - values)[lowered]) if lowered.any() else 0:.2f} m")

    terrain_stats = None
    if cfg.get("terrain_source", True):
        water_plane = float(config["reference_levels"]["rge_alti"]["value_m_ngf"])
        print(f"terrain émergé mesuré au LiDAR (> {water_plane} m NGF)…")
        values, terrain_stats = fuse_emerged_terrain(
            values, mask, geom["grid_x"], geom["grid_y"], water_plane,
            float(grid_cfg.get("terrain_source", {}).get("margin_m", 0.05)))
        if terrain_stats.get("available"):
            print(f"  {terrain_stats['cells_filled']:,} cellules comblées, "
                  f"{terrain_stats['cells_raised']:,} relevées")

    values = np.where(mask, values, np.nan)
    valid = np.isfinite(values)
    coverage_ratio = float(valid.sum() / max(mask.sum(), 1))
    print(f"\ncouverture : {valid.sum():,} cellules valides "
          f"({coverage_ratio * 100:.1f} % de la surface du lac)")
    print(f"altitude de fond : {np.nanmin(values):.2f} → {np.nanmax(values):.2f} m NGF")

    # Comparaison avec la carte du levé, si elle est là : c'est le seul chiffre qui dise
    # ce que change le choix de source pour celui qui bascule d'un fond à l'autre.
    comparison = None
    bed_png = DATA_DIR / "bed.png"
    if bed_png.exists():
        with (DATA_DIR / "bed.json").open(encoding="utf-8") as fh:
            other_meta = json.load(fh)
        if (other_meta["width"], other_meta["height"]) != (width, height):
            raise SystemExit("ERREUR : bed.png n'a pas la taille de cette grille — "
                             "les deux fonds doivent partager la maille")
        image = np.array(Image.open(bed_png).convert("RGBA")).astype(np.int64)
        enc = other_meta["encoding"]
        other = np.where(image[..., 3] > 0,
                         enc["base"] + (image[..., 0] * 65536 + image[..., 1] * 256
                                        + image[..., 2]) * enc["interval"], np.nan)
        both = valid & np.isfinite(other)
        delta = (values - other)[both]
        volume = [float(np.nansum(np.clip(647.0 - v, 0, None)[mask]) * ground_res ** 2 / 1e6)
                  for v in (other, values)]
        comparison = {
            "against": "bed.png",
            "cells_compared": int(both.sum()),
            "median_diff_m": round(float(np.median(delta)), 2),
            "mean_diff_m": round(float(delta.mean()), 2),
            "share_shallower": round(float((delta > 0).mean()), 4),
            "median_abs_diff_m": round(float(np.median(np.abs(delta))), 2),
            "share_within_1m": round(float((np.abs(delta) <= 1).mean()), 4),
            "share_within_2m": round(float((np.abs(delta) <= 2).mean()), 4),
            "volume_647_hm3": [round(v, 2) for v in volume],
        }
        print(f"\nécart au fond du levé 2009 sur {both.sum():,} cellules communes :")
        print(f"  médiane {comparison['median_diff_m']:+.2f} m "
              f"({comparison['share_shallower'] * 100:.0f} % moins profond) · "
              f"écart absolu médian {comparison['median_abs_diff_m']:.2f} m")
        print(f"  à moins d'1 m : {comparison['share_within_1m'] * 100:.0f} % · "
              f"à moins de 2 m : {comparison['share_within_2m'] * 100:.0f} %")
        print(f"  volume à 647 m : {volume[0]:.2f} hm³ (2009) → {volume[1]:.2f} hm³ "
              f"(communauté seule)")

    # Carte de fiabilité, mêmes canaux que celle du levé pour que l'application n'ait
    # qu'un seul décodeur — mais leur sens suit la source.
    #
    #   R = distance à la mesure la plus proche. Ici, **zéro partout où la carte existe** :
    #       chaque cellule visible porte le passage d'un sondeur, il n'y a pas de zone
    #       interpolée à hachurer. Là où personne n'est passé, la carte est vide et non
    #       douteuse — donc 255, mais l'alpha y est déjà nul.
    #   G = borne de profondeur de la bande, en mètres arrondis au-dessus. Elle vaut ici
    #       pour toute la carte : c'est ce qui rappelle qu'on lit un encadrement et non
    #       une sonde.
    #   B = largeur de l'encadrement en décimètres, plafonnée — la seule mesure locale de
    #       ce que la carte ignore encore. 0 sur les cellules comblées par le MNT.
    channels = np.zeros((height, width, 3), np.uint8)
    channels[..., 0] = np.where(framed, 0, 255).astype(np.uint8)
    channels[..., 1] = np.clip(np.ceil(np.nan_to_num(dmax, nan=0.0)), 0, 255).astype(np.uint8)
    channels[..., 2] = np.clip(np.nan_to_num(high - low, nan=0.0) * 10, 0, 255).astype(np.uint8)
    Image.fromarray(channels, mode="RGB").save(DATA_DIR / "coverage_quickdraw.png",
                                               optimize=True)

    image = encode_terrain_rgb(values, float(encoding["base"]), float(encoding["interval"]))
    png_path = DATA_DIR / "bed_quickdraw.png"
    image.save(png_path, optimize=True)

    (west, east), (south, north) = (
        Transformer.from_crs(WEBMERC, WGS84, always_xy=True).transform([x0, x1], [y0, y1])
    )

    write_json(
        DATA_DIR / "bed_quickdraw.json",
        {
            "description": "Altitude du fond du lac de Vassivière d'après la seule "
                           "cartographie communautaire Quickdraw, encodée en Terrain-RGB.",
            "bed_source": "quickdraw",
            "formula": "altitude_m_ngf = base + (R * 65536 + G * 256 + B) * interval ; "
                       "alpha = 0 → pas de donnée",
            "crs": WEBMERC,
            "width": width,
            "height": height,
            "resolution_ground_m": ground_res,
            "resolution_crs_m": round(res_merc, 4),
            "bbox_3857": [x0, y0, x1, y1],
            "bounds_wgs84": {"west": west, "south": south, "east": east, "north": north},
            "corners_wgs84": [[west, north], [east, north], [east, south], [west, south]],
            "encoding": {"base": encoding["base"], "interval": encoding["interval"]},
            "z_range_m_ngf": [round(float(np.nanmin(values)), 2),
                              round(float(np.nanmax(values)), 2)],
            "coverage_ratio": round(coverage_ratio, 4),
            "quickdraw_only": {
                "z_ac_m_ngf": z_ac,
                "solidary_with": "ofb2009",
                "mosaics": [p.name for p in paths],
                "aggregate_quantile": quantile,
                "min_decoded_fraction": min_decoded,
                "relaxation": {"iterations": iterations, "sigma_m": relax.get("sigma_m", 10.0)},
                "framed_ha": round(float(framed.sum()) * cell_ha, 1),
                "unframed_ha": round(float((mask & ~framed).sum()) * cell_ha, 1),
                "lake_share_framed": round(float(framed.sum() / max(mask.sum(), 1)), 4),
                "envelope_median_m": round(float(np.median(span)), 2),
                "envelope_max_m": round(float(span.max()), 2),
                "note": "Aucune sonde du levé de 2009 n'entre dans cette grille, ni "
                        "triangulation, ni contrainte de bord, ni généralisation vers le "
                        "haut-fond. Chaque cellule reste à l'intérieur de la bande de "
                        "couleur que la communauté lui donne ; là où la communauté n'est "
                        "pas passée, la cellule est vide. z_ac est solidaire de Z_2009 "
                        "(config/model.json, solidarity_note) : le décalage d'étalonnage "
                        "de l'application s'applique donc aussi à ce fond.",
            },
            "terrain_source": terrain_stats,
            "comparison": comparison,
            "coverage": {
                "file": "coverage_quickdraw.png",
                "channels": {
                    "R": "0 là où la carte existe — chaque cellule visible porte le passage "
                         "d'un sondeur, il n'y a pas de zone interpolée ; 255 ailleurs",
                    "G": "borne de profondeur de la bande, en mètres arrondis au-dessus",
                    "B": "largeur de l'encadrement en décimètres, plafonnée à 255",
                },
                "note": "Mêmes canaux que coverage.png pour que l'application n'ait qu'un "
                        "décodeur, mais leur sens suit la source : ici tout est encadré et "
                        "rien n'est interpolé.",
            },
            "reference_levels": config["reference_levels"],
            "sources": {
                "quickdraw": {
                    "label": "Cartographie communautaire Quickdraw (Garmin)",
                    "captures": sum(len(m["captures"]) for m in metas),
                    "licence": "donnée Garmin, usage dérivé, pas de licence ouverte",
                },
            },
        },
    )

    size_mb = png_path.stat().st_size / 1e6
    print(f"\n→ {png_path.name} ({size_mb:.2f} Mo), bed_quickdraw.json "
          f"et coverage_quickdraw.png")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
