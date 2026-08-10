"""Accès à l'altimétrie IGN (RGE ALTI®) et rééchantillonnage de contours.

API : https://data.geopf.fr/altimetrie/1.0/calcul/alti/rest/elevation.json
Licence des données : Licence Ouverte / Etalab 2.0 — © IGN
"""

from __future__ import annotations

import json
import math
import statistics
import time
import urllib.error
import urllib.parse
import urllib.request

ENDPOINT = "https://data.geopf.fr/altimetrie/1.0/calcul/alti/rest/elevation.json"
RESOURCE = "ign_rge_alti_wld"
BATCH = 100


def boundary_points(geometry: dict, spacing_m: float) -> list[tuple[float, float]]:
    """Rééchantillonne l'anneau extérieur le plus long d'un (Multi)Polygon à pas ~constant."""
    polygons = (
        geometry["coordinates"]
        if geometry["type"] == "MultiPolygon"
        else [geometry["coordinates"]]
    )
    ring = max((poly[0] for poly in polygons), key=len)

    mid_lat = statistics.fmean(pt[1] for pt in ring)
    m_per_deg_lon = 111320 * math.cos(math.radians(mid_lat))
    m_per_deg_lat = 111320

    points: list[tuple[float, float]] = []
    carry = 0.0
    for (x0, y0), (x1, y1) in zip(ring, ring[1:]):
        dx = (x1 - x0) * m_per_deg_lon
        dy = (y1 - y0) * m_per_deg_lat
        seg = math.hypot(dx, dy)
        if seg == 0:
            continue
        travelled = spacing_m - carry
        while travelled < seg:
            ratio = travelled / seg
            points.append((x0 + (x1 - x0) * ratio, y0 + (y1 - y0) * ratio))
            travelled += spacing_m
        carry = (carry + seg) % spacing_m
    return points


def sample_elevations(points: list[tuple[float, float]], retries: int = 3) -> list[float]:
    """Altitudes RGE ALTI en m NGF, par lots de 100 points."""
    elevations: list[float] = []
    total = (len(points) + BATCH - 1) // BATCH
    for index, start in enumerate(range(0, len(points), BATCH), start=1):
        chunk = points[start : start + BATCH]
        params = {
            "lon": "|".join(f"{lon:.6f}" for lon, _ in chunk),
            "lat": "|".join(f"{lat:.6f}" for _, lat in chunk),
            "resource": RESOURCE,
            "zonly": "true",
        }
        url = f"{ENDPOINT}?{urllib.parse.urlencode(params, safe='|')}"
        request = urllib.request.Request(url, headers={"User-Agent": "ReliefLac/0.1"})

        for attempt in range(retries):
            try:
                with urllib.request.urlopen(request, timeout=90) as response:
                    elevations.extend(float(v) for v in json.load(response)["elevations"])
                break
            except (urllib.error.URLError, TimeoutError):
                if attempt == retries - 1:
                    raise
                time.sleep(2 * (attempt + 1))

        if index % 10 == 0 or index == total:
            print(f"  lot {index}/{total}")
    return elevations
