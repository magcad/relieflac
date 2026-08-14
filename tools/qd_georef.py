#!/usr/bin/env python3
"""Géoréférencement des captures d'écran ActiveCaptain / Quickdraw.

Une capture d'écran de la couche communautaire Quickdraw est une carte de bandes
de profondeur : la légende donne l'intervalle exact associé à chaque couleur, et
les couleurs sont plates, donc décodables sans ambiguïté.

Ce module cale chaque capture en Web Mercator :

  - une **vue d'ensemble** se cale sur le contour BD TOPO du lac
    (`data/lake.geojson`), en ajustant échelle et translation sur les seuls
    pixels certains — kaki = terre, couleur de palette = eau. Le bleu nuit des
    calques « Zones accès limité » et « Conduites et câbles » est opaque et
    recouvre indifféremment terre et eau : il est classé « inconnu » et exclu ;
  - une **vue de détail** se cale sur la vue d'ensemble déjà géoréférencée, par
    corrélation croisée normalisée masquée (FFT) sur l'indice de bande, en
    cherchant simultanément l'échelle. La référence est donc toujours une autre
    capture, jamais le modèle bathymétrique : le calage reste indépendant de ce
    que la comparaison cherche à vérifier.

La barre d'échelle affichée n'est pas utilisée : elle sert au mieux d'amorce.
Mesurée sur la vue d'ensemble du 14/08/2026, elle est juste à 0,2 % près, mais
sa longueur en pixels est difficile à mesurer de façon fiable (le texte blanc
des étiquettes de sonde pollue la détection).

Usage :
    python tools/qd_georef.py <dossier_de_captures> <capture_de_reference> \
        [--out data/mesuresEtalonnage/Garmin/georef.json]

La capture de référence doit montrer le lac entier.
"""
from __future__ import annotations

import argparse
import glob
import json
import os

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage
from scipy.signal import fftconvolve
from shapely.geometry import shape
from shapely.ops import unary_union

R = 6378137.0

# Zone carte utile d'une capture iPad en mode paysage, panneau de réglages ouvert :
# sous le bandeau supérieur, à gauche du panneau. À revoir si l'appareil change.
CROP = (0, 192, 1752, 1599)

LAND_RGB = np.array([155, 152, 98])

# Palette lue sur la légende (IMG_1143, 14/08/2026), portées personnalisées :
# couleur -> (profondeur mini, profondeur maxi) en mètres.
PALETTE = [
    ((206, 156, 197), 0.0, 0.5),
    ((255, 0, 0), 0.5, 1.0),
    ((255, 173, 0), 1.0, 1.5),
    ((255, 255, 0), 1.5, 2.0),
    ((132, 132, 0), 2.0, 3.0),
    ((0, 132, 0), 3.0, 4.0),
    ((0, 255, 0), 4.0, 6.0),
    ((0, 0, 255), 6.0, 8.0),
    ((66, 132, 255), 8.0, 12.0),
    ((0, 197, 255), 12.0, 30.0),
]

# Cote du plan d'eau à laquelle se rapportent les profondeurs Quickdraw, mesurée
# par comparaison des isobathes au modèle, au large. Voir ANALYSE.md § 3.
Z_AC_M_NGF = 647.68


def merc(lon, lat):
    return np.radians(lon) * R, np.log(np.tan(np.pi / 4 + np.radians(lat) / 2)) * R


def unmerc(x, y):
    return np.degrees(x / R), np.degrees(2 * np.arctan(np.exp(y / R)) - np.pi / 2)


def load_lake(path="data/lake.geojson"):
    gj = json.load(open(path, encoding="utf-8"))
    return unary_union([shape(f["geometry"]) for f in gj["features"]])


def rasterize(lake, cx, cy, mpp, w, h):
    """Rasterise le contour du lac dans une fenêtre Mercator centrée sur (cx, cy)."""
    img = Image.new("1", (w, h), 0)
    dr = ImageDraw.Draw(img)
    for p in (lake.geoms if lake.geom_type == "MultiPolygon" else [lake]):
        for ring, fill in [(p.exterior, 1)] + [(i, 0) for i in p.interiors]:
            lon, lat = np.array(ring.coords).T[:2]
            X, Y = merc(lon, lat)
            dr.polygon(list(zip((X - cx) / mpp + w / 2, h / 2 - (Y - cy) / mpp)), fill=fill)
    return np.array(img, dtype=bool)


def read_map(path):
    """Zone carte d'une capture, en RGB."""
    a = np.array(Image.open(path).convert("RGB")).astype(np.int16)
    return a[CROP[1]:CROP[3], CROP[0]:CROP[2]]


def bands(rgb, tol=30):
    """Indice de bande par pixel ; -1 hors palette (étiquette, trait, calque)."""
    out = np.full(rgb.shape[:2], -1, np.int8)
    for i, (col, _, _) in enumerate(PALETTE):
        out[np.abs(rgb - np.array(col)).sum(axis=2) < tol] = i
    return out


def land_mask(rgb, tol=40):
    return np.abs(rgb - LAND_RGB).sum(axis=2) < tol


def masked_ncc(A, MA, B, MB, min_overlap=0.30):
    """Corrélation croisée normalisée de A glissant sur B, pixels connus seulement."""
    Ar, MAr = (A * MA)[::-1, ::-1], MA[::-1, ::-1]
    n = np.maximum(fftconvolve(MB, MAr, mode="valid"), 1.0)
    sAB = fftconvolve(B, Ar, mode="valid")
    sA = fftconvolve(MB, Ar, mode="valid")
    sB = fftconvolve(B, MAr, mode="valid")
    sBB = fftconvolve(B * B, MAr, mode="valid")
    sAA = fftconvolve(MB, (A * A * MA)[::-1, ::-1], mode="valid")
    cov = sAB - sA * sB / n
    va = np.maximum(sAA - sA ** 2 / n, 0.0)
    vb = np.maximum(sBB - sB ** 2 / n, 0.0)
    out = cov / np.sqrt(np.maximum(va * vb, 1e-9))
    out[n < min_overlap * MA.sum()] = -2.0
    return out


def fit_overview(path, lake, mpp_hint, lat0):
    """Cale une vue d'ensemble sur le contour du lac : échelle puis translation."""
    rgb = read_map(path)
    L = ndimage.binary_erosion(land_mask(rgb), np.ones((5, 5)))
    W = ndimage.binary_erosion(
        ndimage.binary_closing(bands(rgb) >= 0, np.ones((11, 11))), np.ones((5, 5)))
    K = L | W
    b = lake.bounds
    cx0, cy0 = [float(v[0]) for v in merc(np.array([(b[0] + b[2]) / 2]),
                                          np.array([(b[1] + b[3]) / 2]))]

    def score(mpp, cx, cy, d):
        l, w, k = L[::d, ::d], W[::d, ::d], K[::d, ::d]
        r = rasterize(lake, cx, cy, mpp * d, l.shape[1], l.shape[0])
        return (((r & w) | (~r & l))[k]).mean()

    best = None
    for s in np.arange(0.90, 1.101, 0.02):
        for dx in np.arange(-900, 901, 60):
            for dy in np.arange(-900, 901, 60):
                v = score(mpp_hint * s, cx0 + dx, cy0 + dy, 8)
                if best is None or v > best[0]:
                    best = (v, s, dx, dy)
    _, s, dx, dy = best
    for step, rng in [(0.006, 24), (0.002, 8)]:
        cand = None
        for ds in np.linspace(-step * 3, step * 3, 7):
            for ddx in np.arange(-rng, rng + 1, max(rng // 3, 1)):
                for ddy in np.arange(-rng, rng + 1, max(rng // 3, 1)):
                    v = score(mpp_hint * (s + ds), cx0 + dx + ddx, cy0 + dy + ddy, 4)
                    if cand is None or v > cand[0]:
                        cand = (v, s + ds, dx + ddx, dy + ddy)
        _, s, dx, dy = cand
    mpp = mpp_hint * s
    return {"mpp_merc": float(mpp), "cx": float(cx0 + dx), "cy": float(cy0 + dy),
            "ground_mpp": float(mpp * np.cos(np.radians(lat0))),
            "ncc": float(cand[0]), "method": "contour"}


def register(path, ref_bi, ref_geo, scales):
    """Cale une capture sur une capture de référence déjà géoréférencée."""
    bi = bands(read_map(path))
    rv = ref_bi.astype(np.float64)
    rv[ref_bi < 0] = 0.0
    rm = (ref_bi >= 0).astype(np.float64)
    best = None
    for ground in scales:
        k = ref_geo["ground_mpp"] / ground
        h2, w2 = int(bi.shape[0] / k), int(bi.shape[1] / k)
        if h2 < 20 or w2 < 20 or h2 > ref_bi.shape[0] or w2 > ref_bi.shape[1]:
            continue
        sm = bi[np.ix_((np.arange(h2) * k).astype(int), (np.arange(w2) * k).astype(int))]
        A = sm.astype(np.float64)
        MA = (sm >= 0).astype(np.float64)
        A[sm < 0] = 0.0
        if MA.sum() < 1500:
            continue
        cc = masked_ncc(A, MA, rv, rm)
        j, i = np.unravel_index(cc.argmax(), cc.shape)
        if best is None or cc[j, i] > best[0]:
            best = (cc[j, i], ground, j, i, sm.shape)
    if best is None:
        return None
    v, ground, j, i, shp = best
    H, W = ref_bi.shape
    return {"ncc": float(v), "ground_mpp": float(ground),
            "mpp_merc": float(ground * ref_geo["mpp_merc"] / ref_geo["ground_mpp"]),
            "cx": float(ref_geo["cx"] + (i + shp[1] / 2 - W / 2) * ref_geo["mpp_merc"]),
            "cy": float(ref_geo["cy"] - (j + shp[0] / 2 - H / 2) * ref_geo["mpp_merc"]),
            "method": "correlation"}


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("directory")
    ap.add_argument("reference", help="capture montrant le lac entier")
    ap.add_argument("--lake", default="data/lake.geojson")
    ap.add_argument("--out", default="data/mesuresEtalonnage/Garmin/georef.json")
    ap.add_argument("--hint", type=float, default=3.40,
                    help="mètres sol par pixel supposés pour la référence")
    ap.add_argument("--min-ncc", type=float, default=0.90)
    args = ap.parse_args()

    lake = load_lake(args.lake)
    b = lake.bounds
    lat0 = (b[1] + b[3]) / 2

    ref_path = os.path.join(args.directory, args.reference)
    gref = fit_overview(ref_path, lake, args.hint / np.cos(np.radians(lat0)), lat0)
    print(f"{args.reference}  référence  accord={gref['ncc']:.4f}  "
          f"{gref['ground_mpp']:.4f} m/px")
    ref_bi = bands(read_map(ref_path))

    # Échelles déjà rencontrées, essayées en premier ; sinon balayage large.
    known = [0.6908, 0.6873, 0.6839, 2.1656, gref["ground_mpp"]]
    wide = np.exp(np.linspace(np.log(0.35), np.log(4.6), 40))

    out = {args.reference: gref}
    for p in sorted(glob.glob(os.path.join(args.directory, "*.PNG"))):
        name = os.path.basename(p)
        if name == args.reference:
            continue
        r = register(p, ref_bi, gref, known)
        if r is None or r["ncc"] < args.min_ncc:
            r = register(p, ref_bi, gref, wide)
        if r is not None:
            fine = register(p, ref_bi, gref, r["ground_mpp"] * np.linspace(0.98, 1.02, 9))
            if fine is not None and fine["ncc"] > r["ncc"]:
                r = fine
        flag = "" if (r and r["ncc"] >= args.min_ncc) else "   <-- douteux, écarté"
        out[name] = r or {"ncc": -1.0}
        print(f"{name}  ncc={out[name]['ncc']:.3f}  "
              f"{out[name].get('ground_mpp', float('nan')):.4f} m/px{flag}")

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    json.dump({"crop": list(CROP), "z_ac_m_ngf": Z_AC_M_NGF,
               "palette": [{"rgb": list(c), "dmin": a, "dmax": z} for c, a, z in PALETTE],
               "captures": out}, open(args.out, "w", encoding="utf-8"), indent=1)
    ok = sum(1 for v in out.values() if v["ncc"] >= args.min_ncc)
    print(f"\n{ok}/{len(out)} captures calées → {args.out}")


if __name__ == "__main__":
    main()
