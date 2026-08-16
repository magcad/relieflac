"""Prépare la silhouette du lac pour les vignettes de trajets (module `src/lake-outline.js`).

`data/lake.geojson` fait 385 Ko pour 4 435 sommets : c'est la donnée IGN brute, lue par les
seuls outils Python. Une vignette de 64 px n'en a aucun besoin — à cette taille, un sommet
sur vingt suffit, et le reste ne serait que du réseau et du travail de rendu.

L'outil décime les contours, les projette **une fois pour toutes** dans le carré normalisé
des vignettes, et écrit un chemin SVG tout fait. L'application colle une chaîne de
caractères : elle ne charge aucune géométrie de fond et ne calcule aucune projection de
rivage.

Le cadrage est celui de la grille (`bed.meta.bounds_wgs84`) et non celui du lac : c'est ce
même repère que `src/thumb.js` emploie pour projeter les trajets, donc les deux se
superposent sans qu'aucune valeur ne soit recopiée d'un fichier à l'autre — la boîte
normalisée voyage dans le module généré.

Usage : python tools/build_lake_outline.py
"""

from __future__ import annotations

import json
import math
from pathlib import Path

from common import DATA_DIR, ROOT

# Largeur du repère normalisé. Rien ne l'impose sinon la lisibilité du fichier produit :
# des entiers à trois chiffres se relisent, et un décime de mille reste sous le pixel à la
# taille d'affichage (64 px).
BOX_W = 1000.0
# Sommets visés après décimation. Au-delà on paye du fichier pour du sous-pixel.
TARGET_VERTICES = 300
# Un îlot plus petit que cela ne couvre même pas un pixel de la vignette.
MIN_RING_AREA = 4.0  # unités normalisées au carré


def mercator_y(lat: float) -> float:
    """Ordonnée Web Mercator, en degrés — même formule que `mercatorY` de `src/thumb.js`."""
    return math.degrees(math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)))


def douglas_peucker(points: list[tuple[float, float]], tol: float) -> list[tuple[float, float]]:
    """Décimation classique, itérative : la récursion sur 3 553 sommets déborde la pile."""
    if len(points) < 3:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        first, last = stack.pop()
        if last <= first + 1:
            continue
        ax, ay = points[first]
        bx, by = points[last]
        dx, dy = bx - ax, by - ay
        norm = math.hypot(dx, dy)
        worst, worst_i = -1.0, -1
        for i in range(first + 1, last):
            px, py = points[i]
            if norm == 0:
                dist = math.hypot(px - ax, py - ay)
            else:
                dist = abs(dy * px - dx * py + bx * ay - by * ax) / norm
            if dist > worst:
                worst, worst_i = dist, i
        if worst > tol:
            keep[worst_i] = True
            stack.append((first, worst_i))
            stack.append((worst_i, last))
    return [p for p, k in zip(points, keep) if k]


def ring_area(points: list[tuple[float, float]]) -> float:
    """Aire du polygone (formule du lacet), en valeur absolue."""
    total = 0.0
    for (x1, y1), (x2, y2) in zip(points, points[1:] + points[:1]):
        total += x1 * y2 - x2 * y1
    return abs(total) / 2


def main() -> None:
    meta = json.loads((DATA_DIR / "bed.json").read_text(encoding="utf-8"))
    bounds = meta["bounds_wgs84"]
    west, east = bounds["west"], bounds["east"]
    south_y, north_y = mercator_y(bounds["south"]), mercator_y(bounds["north"])
    # La hauteur suit le rapport mercator de l'emprise : la silhouette n'est jamais étirée.
    box_h = round(BOX_W * (north_y - south_y) / (east - west), 2)

    def project(lon: float, lat: float) -> tuple[float, float]:
        x = (lon - west) / (east - west) * BOX_W
        y = (north_y - mercator_y(lat)) / (north_y - south_y) * box_h
        return x, y

    lake = json.loads((DATA_DIR / "lake.geojson").read_text(encoding="utf-8"))
    rings: list[list[tuple[float, float]]] = []
    for feature in lake["features"]:
        geom = feature["geometry"]
        polygons = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
        for polygon in polygons:
            # Anneau extérieur et trous confondus : le chemin est rendu en `evenodd`, donc
            # les îles se creusent d'elles-mêmes.
            for ring in polygon:
                rings.append([project(lon, lat) for lon, lat, *_ in ring])

    raw_vertices = sum(len(r) for r in rings)

    # Tolérance cherchée par dichotomie plutôt que devinée : le nombre de sommets est ce qui
    # nous intéresse, la tolérance n'en est que le moyen.
    lo, hi = 0.0, 40.0
    best: list[list[tuple[float, float]]] = []
    for _ in range(40):
        tol = (lo + hi) / 2
        trial = [douglas_peucker(r, tol) for r in rings]
        trial = [r for r in trial if len(r) >= 4 and ring_area(r) >= MIN_RING_AREA]
        count = sum(len(r) for r in trial)
        if count > TARGET_VERTICES:
            lo = tol
        else:
            hi = tol
            best = trial
    kept = best or [r for r in rings if ring_area(r) >= MIN_RING_AREA]

    # Les grands anneaux d'abord : le contour du lac doit être en tête du chemin, ne
    # serait-ce que pour que le fichier se relise.
    kept.sort(key=ring_area, reverse=True)
    # Un `M` puis des couples : en SVG, ceux qui suivent un `M` sont des `L` implicites.
    path = "".join(f"M{' '.join(f'{x:.1f},{y:.1f}' for x, y in ring)}Z" for ring in kept)

    vertices = sum(len(r) for r in kept)
    module = f'''/**
 * Silhouette du lac pour les vignettes de trajets — GÉNÉRÉ, ne pas modifier à la main.
 * Produit par `python tools/build_lake_outline.py` depuis `data/lake.geojson`
 * ({raw_vertices} sommets, 385 Ko) décimé à {vertices} sommets.
 *
 * Le chemin est déjà projeté dans la boîte normalisée ci-dessous, dans le repère de
 * l'emprise de la grille : `src/thumb.js` y projette les trajets avec la même formule, donc
 * les deux se superposent. Rendu en `fill-rule: evenodd`, ce qui creuse les îles.
 */
export const LAKE_OUTLINE = {{
  path: '{path}',
  box: {{ width: {BOX_W:.0f}, height: {box_h} }},
  bounds: {{ west: {west}, south: {bounds["south"]}, east: {east}, north: {bounds["north"]} }},
}};
'''
    out = ROOT / "src" / "lake-outline.js"
    out.write_text(module, encoding="utf-8", newline="\n")
    size = len(module.encode("utf-8"))
    print(f"{out.relative_to(ROOT)} : {len(kept)} anneaux, {vertices} sommets "
          f"(sur {raw_vertices}), {size / 1024:.1f} Ko, boîte {BOX_W:.0f}x{box_h}")


if __name__ == "__main__":
    main()
