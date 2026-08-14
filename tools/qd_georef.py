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

Une **campagne** est un dossier de captures et une palette, déclarés dans
`data/mesuresEtalonnage/Garmin/palettes.json`. Les couleurs se recyclent d'une
campagne à l'autre — `(0,197,255)` vaut 12–30 m dans « 0-12m » et 12–14 m dans
« 12_30m » — donc la palette n'est jamais une constante globale.

Deux campagnes n'ayant aucune couleur en commun, la seconde ne peut pas se caler
par ressemblance de bandes sur la première. Elle se cale sur un **masque**
partagé : « plus profond que 12 m » est à la fois la dernière bande de la
campagne fine et la réunion de toutes les bandes de la campagne profonde.

Usage :
    python tools/qd_georef.py 0-12m
    python tools/qd_georef.py 12_30m
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

PALETTES = "data/mesuresEtalonnage/Garmin/palettes.json"

# Cote du plan d'eau à laquelle se rapportent les profondeurs Quickdraw, mesurée
# par comparaison des isobathes au modèle, au large. Voir ANALYSE.md § 3.
Z_AC_M_NGF = 647.68


def load_campaign(name, path=PALETTES):
    """Description d'une campagne : dossier, palette, mode de calage.

    ATTENTION : les couleurs se recyclent d'une campagne à l'autre. (0,197,255)
    vaut 12–30 m dans la campagne « 0-12m » et 12–14 m dans « 12_30m ». Décoder
    avec la mauvaise palette produit une carte fausse sans aucun signe extérieur.
    """
    cfg = json.load(open(path, encoding="utf-8"))
    if name not in cfg["campaigns"]:
        raise SystemExit(f"campagne inconnue : {name} — "
                         f"connues : {', '.join(cfg['campaigns'])}")
    c = dict(cfg["campaigns"][name])
    c["palette"] = [(tuple(p["rgb"]), p["dmin"], p["dmax"]) for p in c["palette"]]
    c["z_ac_m_ngf"] = cfg["z_ac_m_ngf"]
    # Translation mesurée sur les sondes de 2009, appliquée au mosaïquage et NON ici :
    # les solutions de `georef_*.json` restent celles de la corrélation brute, sans quoi
    # une seconde exécution la réappliquerait par-dessus la première. Voir qd_mosaic.py.
    c["position_correction_merc"] = tuple(cfg.get("position_correction_merc", (0.0, 0.0)))
    c["root"] = os.path.dirname(path)
    c["name"] = name
    return c


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


def bands(rgb, palette, tol=30):
    """Indice de bande par pixel ; -1 hors palette (étiquette, trait, calque).

    `palette` est la liste (couleur, dmin, dmax) de la campagne — jamais une
    constante globale, voir `load_campaign`.
    """
    out = np.full(rgb.shape[:2], -1, np.int8)
    for i, (col, _, _) in enumerate(palette):
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


def fit_overview(path, lake, mpp_hint, lat0, palette):
    """Cale une vue d'ensemble sur le contour du lac : échelle puis translation."""
    rgb = read_map(path)
    L = ndimage.binary_erosion(land_mask(rgb), np.ones((5, 5)))
    W = ndimage.binary_erosion(
        ndimage.binary_closing(bands(rgb, palette) >= 0, np.ones((11, 11))), np.ones((5, 5)))
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


def reference_from_mosaic(png, meta, mask_bands, down=1):
    """Signal de référence tiré d'une mosaïque déjà géoréférencée.

    Sert à caler une campagne dont la palette n'a **aucune couleur en commun**
    avec la précédente. On ne compare alors pas des bandes mais un masque : par
    exemple « plus profond que 12 m », qui est la bande 12–30 m de la campagne
    fine et la réunion de toutes les bandes de la campagne profonde. C'est le
    seul signal partagé, et il suffit.
    """
    a = np.array(Image.open(png).convert("RGB")).astype(np.int16)
    pal = [tuple(p["rgb"]) for p in meta["palette"]]
    m = np.zeros(a.shape[:2], bool)
    for i in mask_bands:
        m |= (np.abs(a - np.array(pal[i])).sum(axis=2) < 30)
    m = m[::down, ::down]
    # Le centre se décale d'un demi-pixel résiduel quand la taille n'est pas
    # divisible : on le recalcule depuis la taille réellement obtenue.
    mpp = meta["mpp_merc"] * down
    # La mosaïque de référence porte déjà la correction de position ; on la retire pour
    # que les captures calées dessus ressortent dans le repère brut de la corrélation,
    # celui que qd_mosaic.py corrigera à son tour. Sans cela, la correction serait
    # appliquée deux fois à la campagne profonde, et seulement à elle.
    fix_x, fix_y = meta.get("position_correction_merc", (0.0, 0.0))
    geo = {"cx": meta["bbox_3857"][0] + m.shape[1] / 2 * mpp - fix_x,
           "cy": meta["bbox_3857"][3] - m.shape[0] / 2 * mpp - fix_y,
           "mpp_merc": mpp}
    lat0 = np.degrees(2 * np.arctan(np.exp(geo["cy"] / R)) - np.pi / 2)
    geo["ground_mpp"] = mpp * np.cos(np.radians(lat0))
    return m, geo


def crop_reference(ref, geo, cx, cy, half_w_m, half_h_m):
    """Découpe la référence autour d'une solution grossière.

    Corréler une capture contre une mosaïque entière coûte des FFT de dizaines
    de millions de pixels. Une fois la position connue à quelques mètres près,
    il suffit de refaire le calcul sur une fenêtre à peine plus grande que la
    capture : même résultat, deux ordres de grandeur moins cher.
    """
    mpp = geo["mpp_merc"]
    h, w = ref.shape
    ci = (cx - geo["cx"]) / mpp + w / 2
    cj = h / 2 - (cy - geo["cy"]) / mpp
    hw, hh = half_w_m / mpp, half_h_m / mpp
    i0, i1 = int(max(ci - hw, 0)), int(min(ci + hw, w))
    j0, j1 = int(max(cj - hh, 0)), int(min(cj + hh, h))
    sub = ref[j0:j1, i0:i1]
    sub_geo = dict(geo)
    sub_geo["cx"] = geo["cx"] + ((i0 + i1) / 2 - w / 2) * mpp
    sub_geo["cy"] = geo["cy"] - ((j0 + j1) / 2 - h / 2) * mpp
    return sub, sub_geo


def register(path, ref, ref_geo, scales, palette, binary=False):
    """Cale une capture sur une référence déjà géoréférencée.

    Deux modes :

    - `binary=False` — `ref` est l'indice de bande d'une autre capture de la
      **même** campagne. On compare des bandes, et seuls les pixels de palette
      comptent (étiquettes et calques exclus de part et d'autre).
    - `binary=True` — `ref` est un masque booléen produit par
      `reference_from_mosaic`. On compare alors « dans le masque / hors du
      masque », partout : c'est le seul recours quand les deux campagnes n'ont
      aucune couleur en commun.
    """
    bi = bands(read_map(path), palette)
    if binary:
        sig = (bi >= 0).astype(np.int8)          # 1 = colorié, donc dans la plage
        rv = ref.astype(np.float64)
        rm = np.ones_like(rv)
    else:
        sig = bi
        rv = ref.astype(np.float64)
        rv[ref < 0] = 0.0
        rm = (ref >= 0).astype(np.float64)
    best = None
    for ground in scales:
        k = ref_geo["ground_mpp"] / ground
        h2, w2 = int(sig.shape[0] / k), int(sig.shape[1] / k)
        if h2 < 20 or w2 < 20 or h2 > rv.shape[0] or w2 > rv.shape[1]:
            continue
        sm = sig[np.ix_((np.arange(h2) * k).astype(int), (np.arange(w2) * k).astype(int))]
        if binary:
            A = sm.astype(np.float64)
            MA = np.ones_like(A)
            if A.sum() < 1500:
                continue
        else:
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
    H, W = rv.shape
    return {"ncc": float(v), "ground_mpp": float(ground),
            "mpp_merc": float(ground * ref_geo["mpp_merc"] / ref_geo["ground_mpp"]),
            "cx": float(ref_geo["cx"] + (i + shp[1] / 2 - W / 2) * ref_geo["mpp_merc"]),
            "cy": float(ref_geo["cy"] - (j + shp[0] / 2 - H / 2) * ref_geo["mpp_merc"]),
            "method": "correlation"}


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("campaign", help="nom d'une campagne de palettes.json")
    ap.add_argument("--palettes", default=PALETTES)
    ap.add_argument("--lake", default="data/lake.geojson")
    ap.add_argument("--out", default=None, help="défaut : georef_<campagne>.json")
    ap.add_argument("--min-ncc", type=float, default=0.90)
    ap.add_argument("--ref-down", type=int, default=4,
                    help="reduction de la mosaique de reference pour la recherche d'echelle")
    ap.add_argument("--refine-margin", type=float, default=120.0,
                    help="marge en metres autour de la solution grossiere, passe finale")
    ap.add_argument("--ref-down-final", type=int, default=2,
                    help="reduction pour la passe finale. 1 = pleine resolution, mais une "
                         "mosaique au metre fait alors 60 Mpx par FFT : plusieurs Go de RAM "
                         "pour une precision (0,7 m) sans objet face a la grille de 5 m")
    args = ap.parse_args()

    camp = load_campaign(args.campaign, args.palettes)
    pal = camp["palette"]
    directory = os.path.join(camp["root"], camp["folder"])
    out_path = args.out or os.path.join(camp["root"], f"georef_{args.campaign}.json")
    ref = camp["reference"]

    lake = load_lake(args.lake)
    b = lake.bounds
    lat0 = (b[1] + b[3]) / 2

    out = {}
    if ref["type"] == "contour":
        ref_path = os.path.join(directory, ref["capture"])
        gref = fit_overview(ref_path, lake,
                            ref["hint_ground_mpp"] / np.cos(np.radians(lat0)), lat0, pal)
        ref_sig = bands(read_map(ref_path), pal)
        fine_sig = fine_geo = None
        binary = False
        out[ref["capture"]] = gref
        print(f"{ref['capture']}  référence sur contour  accord={gref['ncc']:.4f}  "
              f"{gref['ground_mpp']:.4f} m/px")
    elif ref["type"] == "mosaic":
        other = load_campaign(ref["campaign"], args.palettes)
        png = os.path.join(other["root"], ref["file"])
        meta = json.load(open(os.path.splitext(png)[0] + ".json", encoding="utf-8"))
        # Une mosaïque au mètre fait 60 Mpx : la corrélation y est hors de prix.
        # On cherche donc l'échelle sur une version réduite, puis on rejoue le
        # seul meilleur candidat à pleine résolution.
        ref_sig, gref = reference_from_mosaic(png, meta, ref["mask_bands"], args.ref_down)
        fine_sig, fine_geo = reference_from_mosaic(png, meta, ref["mask_bands"],
                                                   args.ref_down_final)
        binary = True
        print(f"référence : masque {ref['mask_bands']} de {ref['file']} — "
              f"{int(fine_sig.sum())} px, recherche à {gref['ground_mpp']:.3f} m/px "
              f"puis calage final à {fine_geo['ground_mpp']:.3f} m/px")
    else:
        raise SystemExit(f"mode de référence inconnu : {ref['type']}")

    # Balayage large systématique. Un raccourci « essayer d'abord les échelles
    # déjà rencontrées » a été retiré : quand une campagne introduit un zoom
    # inédit, il se verrouille sur le bord de la fenêtre d'affinage voisine et
    # renvoie une solution plausible mais fausse — mesuré sur la campagne
    # 12_30m, 0,663 m/px à NCC 0,605 contre 0,621 m/px à NCC 0,677.
    wide = np.exp(np.linspace(np.log(0.35), np.log(4.6), 40))

    for p in sorted(glob.glob(os.path.join(directory, "*.PNG"))):
        name = os.path.basename(p)
        if name in out:
            continue
        r = register(p, ref_sig, gref, wide, pal, binary)
        if r is not None:
            fine = register(p, ref_sig, gref, r["ground_mpp"] * np.linspace(0.98, 1.02, 9),
                            pal, binary)
            if fine is not None and fine["ncc"] > r["ncc"]:
                r = fine
        if r is not None and fine_sig is not None:
            # Passe finale : même corrélation, mais sur une fenêtre resserrée
            # autour de la solution grossière — sinon la FFT porte sur toute la
            # mosaïque et coûte des minutes par échelle essayée.
            half_w = (CROP[2] - CROP[0]) / 2 * r["mpp_merc"] + args.refine_margin
            half_h = (CROP[3] - CROP[1]) / 2 * r["mpp_merc"] + args.refine_margin
            sub, sub_geo = crop_reference(fine_sig, fine_geo, r["cx"], r["cy"],
                                          half_w, half_h)
            if min(sub.shape) > 40:
                full = register(p, sub, sub_geo,
                                r["ground_mpp"] * np.linspace(0.99, 1.01, 5), pal, binary)
                if full is not None and full["ncc"] > 0:
                    r = full
        flag = "" if (r and r["ncc"] >= args.min_ncc) else "   <-- douteux, écarté"
        out[name] = r or {"ncc": -1.0}
        print(f"{name}  ncc={out[name]['ncc']:.3f}  "
              f"{out[name].get('ground_mpp', float('nan')):.4f} m/px{flag}")

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    json.dump({"campaign": args.campaign, "folder": camp["folder"],
               "crop": list(CROP), "z_ac_m_ngf": camp["z_ac_m_ngf"],
               "palette": [{"rgb": list(c), "dmin": a, "dmax": z} for c, a, z in pal],
               "captures": out}, open(out_path, "w", encoding="utf-8"), indent=1)
    args.out = out_path
    ok = sum(1 for v in out.values() if v["ncc"] >= args.min_ncc)
    print(f"\n{ok}/{len(out)} captures calées -> {args.out}")


if __name__ == "__main__":
    main()
