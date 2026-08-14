#!/usr/bin/env python3
"""Mosaïque géoréférencée des captures Quickdraw, en Web Mercator.

Ce n'est pas un assemblage photo. Chaque capture ayant été calée indépendamment
par `qd_georef.py`, on se contente de les reprojeter dans une grille commune —
la plus fine gagne là où plusieurs se recouvrent. Les recouvrements ne sont donc
pas des coutures à masquer mais un **contrôle de qualité** : deux captures qui
se chevauchent doivent donner la même bande. Le taux d'accord est affiché.

Deux sorties, même emprise que `data/bed.png` :

  - `mosaique.png` : raster de bandes, chaque pixel portant la couleur exacte de
    la palette. Le PNG est sans perte, donc les bandes se relisent telles quelles ;
    1,3 Mo, contre 60 Mo pour le tableau numpy équivalent.
  - `mosaique.json` : emprise, résolution, palette, liste des captures retenues.

Le rebouchage : les étiquettes de sonde (texte blanc) et les traits de contour
(gris) percent des trous dans les bandes. Une étiquette étant toujours posée à
l'intérieur d'une bande, on la rebouche par plus proche voisin dans un rayon de
10 m. Au-delà, on ne rebouche pas : c'est alors un vrai trou (calque opaque, ou
zone jamais parcourue). Mesuré le 14/08/2026 : 80,8 % du lac décodé avant,
93,6 % après.

Usage :
    python tools/qd_mosaic.py [--georef data/mesuresEtalonnage/Garmin/georef.json]
"""
from __future__ import annotations

import argparse
import json
import os

import numpy as np
from PIL import Image
from scipy import ndimage

from qd_georef import (CROP, PALETTES, bands, load_campaign, load_lake, rasterize,
                       read_map, unmerc)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("campaign", help="nom d'une campagne de palettes.json")
    ap.add_argument("--palettes", default=PALETTES)
    ap.add_argument("--georef", default=None, help="défaut : georef_<campagne>.json")
    ap.add_argument("--bed", default="data/bed.json")
    ap.add_argument("--lake", default="data/lake.geojson")
    ap.add_argument("--out", default=None, help="défaut : mosaique_<campagne>.png")
    ap.add_argument("--mpp", type=float, default=1.0, help="mètres Mercator par pixel")
    ap.add_argument("--fill-radius", type=float, default=10.0)
    ap.add_argument("--min-ncc", type=float, default=0.90)
    args = ap.parse_args()

    camp = load_campaign(args.campaign, args.palettes)
    args.directory = os.path.join(camp["root"], camp["folder"])
    args.georef = args.georef or os.path.join(camp["root"], f"georef_{args.campaign}.json")
    args.out = args.out or os.path.join(camp["root"], f"mosaique_{args.campaign}.png")

    gj = json.load(open(args.georef, encoding="utf-8"))
    palette = [(tuple(p["rgb"]), p["dmin"], p["dmax"]) for p in gj["palette"]]
    geo = {k: v for k, v in gj["captures"].items() if v.get("ncc", -1) >= args.min_ncc}

    meta = json.load(open(args.bed, encoding="utf-8"))
    bb = meta["bbox_3857"]
    W = int((bb[2] - bb[0]) / args.mpp)
    H = int((bb[3] - bb[1]) / args.mpp)
    print(f"mosaïque {W} x {H} px à {args.mpp} m/px Mercator, {len(geo)} captures")

    # Correction de position, mesurée sur les sondes de 2009 (voir palettes.json).
    # Elle s'applique ici et nulle part ailleurs : les solutions de georef_*.json
    # restent celles de la corrélation brute, donc rejouables sans double correction.
    fix_x, fix_y = camp["position_correction_merc"]
    if fix_x or fix_y:
        lat0 = np.degrees(2 * np.arctan(np.exp((bb[1] + bb[3]) / 2 / 6378137.0)) - np.pi / 2)
        gnd = np.cos(np.radians(lat0))
        print(f"correction de position : {fix_x:+.1f} / {fix_y:+.1f} m Mercator "
              f"= {fix_x * gnd:+.1f} m est, {fix_y * gnd:+.1f} m nord au sol")

    mos = np.full((H, W), -1, np.int8)
    agree = disagree = 0
    for n, name in enumerate(sorted(geo, key=lambda k: -geo[k]["ground_mpp"]), 1):
        g = dict(geo[name])
        g["cx"] += fix_x
        g["cy"] += fix_y
        bi = bands(read_map(os.path.join(args.directory, name)), palette)
        h, w = bi.shape
        i0 = max(int((g["cx"] - w / 2 * g["mpp_merc"] - bb[0]) / args.mpp), 0)
        i1 = min(int((g["cx"] + w / 2 * g["mpp_merc"] - bb[0]) / args.mpp) + 1, W)
        j0 = max(int((bb[3] - (g["cy"] + h / 2 * g["mpp_merc"])) / args.mpp), 0)
        j1 = min(int((bb[3] - (g["cy"] - h / 2 * g["mpp_merc"])) / args.mpp) + 1, H)
        if i1 <= i0 or j1 <= j0:
            print(f"  {name} hors cadre")
            continue
        ii, jj = np.arange(i0, i1), np.arange(j0, j1)
        px = ((bb[0] + (ii + 0.5) * args.mpp - g["cx"]) / g["mpp_merc"] + w / 2).astype(int)
        py = (h / 2 - (bb[3] - (jj + 0.5) * args.mpp - g["cy"]) / g["mpp_merc"]).astype(int)
        ok_x, ok_y = (px >= 0) & (px < w), (py >= 0) & (py < h)
        px, py, ii, jj = px[ok_x], py[ok_y], ii[ok_x], jj[ok_y]
        if not len(px) or not len(py):
            continue
        patch = bi[np.ix_(py, px)]
        sl = np.ix_(jj, ii)
        prev = mos[sl]
        have = patch >= 0
        both = have & (prev >= 0)
        agree += int((both & (patch == prev)).sum())
        disagree += int((both & (patch != prev)).sum())
        cur = prev.copy()
        cur[have] = patch[have]
        mos[sl] = cur
        print(f"  {n:2d}/{len(geo)} {name}  {g['ground_mpp']:.3f} m/px  {have.sum():8d} px")

    lake = load_lake(args.lake)
    lakeras = rasterize(lake, (bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2, args.mpp, W, H)
    lat0 = np.degrees(2 * np.arctan(np.exp((bb[1] + bb[3]) / 2 / 6378137.0)) - np.pi / 2)
    ha = args.mpp ** 2 * np.cos(np.radians(lat0)) ** 2 / 1e4
    tot = agree + disagree
    print(f"\nrecouvrements : {tot} comparaisons, accord {100 * agree / max(tot, 1):.1f} %")
    print(f"décodé avant rebouchage : {(lakeras & (mos >= 0)).sum() * ha:.0f} ha "
          f"({100 * (lakeras & (mos >= 0)).sum() / lakeras.sum():.1f} % du lac)")

    dist, (iy, ix) = ndimage.distance_transform_edt(mos < 0, return_indices=True)
    fill = (mos < 0) & lakeras & (dist <= args.fill_radius / args.mpp)
    mos[fill] = mos[iy[fill], ix[fill]]
    print(f"décodé après rebouchage : {(lakeras & (mos >= 0)).sum() * ha:.0f} ha "
          f"({100 * (lakeras & (mos >= 0)).sum() / lakeras.sum():.1f} %)")

    rgb = np.zeros((H, W, 3), np.uint8)
    rgb[:] = (16, 18, 24)
    rgb[lakeras & (mos < 0)] = (70, 70, 78)
    for i, (col, _, _) in enumerate(palette):
        rgb[mos == i] = col
    Image.fromarray(rgb).save(args.out)
    json.dump({"campaign": args.campaign,
               "bbox_3857": bb, "width": W, "height": H, "mpp_merc": args.mpp,
               "z_ac_m_ngf": gj["z_ac_m_ngf"],
               "palette": gj["palette"],
               "nodata_rgb": [16, 18, 24], "lake_nodata_rgb": [70, 70, 78],
               "position_correction_merc": [fix_x, fix_y],
               "captures": sorted(geo),
               "overlap_agreement": round(agree / max(tot, 1), 4)},
              open(os.path.splitext(args.out)[0] + ".json", "w", encoding="utf-8"), indent=1)
    print(f"\n{args.out} écrit")


if __name__ == "__main__":
    main()
