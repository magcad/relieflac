"""Extrait les sondes du lac de Vassivière du jeu OFB « Bathymétrie plans d'eau ».

Le fichier source couvre plus de 200 plans d'eau (1,5 M de lignes) ; on n'en garde
que l'entité hydrographique L0115203.

Source  : https://data.eaufrance.fr/jdd/c31746f7-311a-41c7-b995-6cb78a2ddc25
Licence : Licence Ouverte / Open Licence 2.0
"""

from __future__ import annotations

import io
import sys
import urllib.request
import zipfile

from common import CACHE_DIR, load_model_config, write_soundings

ARCHIVE_URL = (
    "https://data.ofb.fr/catalogue/data-eaufrance/api/records/"
    "c31746f7-311a-41c7-b995-6cb78a2ddc25/attachments/points_bruts_bathy_20161020.zip"
)
ARCHIVE_NAME = "points_bruts_bathy_20161020.zip"
MEMBER_NAME = "points_bathy_bruts_plans_d_eau_20161020.tab"


def fetch_archive() -> bytes:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cached = CACHE_DIR / ARCHIVE_NAME
    if cached.exists():
        print(f"archive en cache : {cached}")
        return cached.read_bytes()
    print(f"téléchargement de {ARCHIVE_URL}")
    request = urllib.request.Request(ARCHIVE_URL, headers={"User-Agent": "ReliefLac/0.1"})
    with urllib.request.urlopen(request, timeout=180) as response:
        payload = response.read()
    cached.write_bytes(payload)
    print(f"  {len(payload) / 1e6:.1f} Mo mis en cache")
    return payload


def parse_rows(archive: bytes, code: str):
    """Le fichier est en UTF-8 BOM, tabulé, avec la virgule comme séparateur décimal."""
    with zipfile.ZipFile(io.BytesIO(archive)) as zf:
        member = next(n for n in zf.namelist() if n.endswith(MEMBER_NAME))
        raw = zf.read(member)
    text = io.TextIOWrapper(io.BytesIO(raw), encoding="utf-8-sig", newline="")
    header = next(text).rstrip("\r\n").split("\t")
    idx = {name: pos for pos, name in enumerate(header)}
    for line in text:
        fields = line.rstrip("\r\n").split("\t")
        if fields[idx["code_gene"]] != code:
            continue
        yield (
            float(fields[idx["lon"]].replace(",", ".")),
            float(fields[idx["lat"]].replace(",", ".")),
            float(fields[idx["prof"]].replace(",", ".")),
            iso_date(fields[idx["dtg_bathy"]]),
        )


def iso_date(value: str) -> str:
    """`22/04/2009` → `2009-04-22T12:00:00+00:00` (midi faute d'heure connue)."""
    value = value.strip()
    if not value:
        return ""
    day, month, year = value.split("/")
    return f"{year}-{month}-{day}T12:00:00+00:00"


def main() -> int:
    config = load_model_config()
    code = config["lake"]["code_entite_hydrographique"]

    rows = list(parse_rows(fetch_archive(), code))
    if not rows:
        print(f"ERREUR : aucune sonde trouvée pour le code {code}", file=sys.stderr)
        return 1

    depths = [row[2] for row in rows]
    dates = sorted({row[3][:10] for row in rows if row[3]})

    write_soundings(
        "ofb2009",
        rows,
        {
            "label": "Levé bathymétrique OFB / Onema — retenue de Vassivière",
            "source": "Système d'Information sur l'Eau / OFB — « Bathymétrie plans d'eau »",
            "source_url": "https://data.eaufrance.fr/jdd/c31746f7-311a-41c7-b995-6cb78a2ddc25",
            "protocol": "Alleaume et al., 2010 — Onema/Cemagref",
            "license": "Licence Ouverte / Open Licence 2.0",
            "survey_dates": dates,
            "reference": {"mode": "fixed_key", "key": "ofb2009"},
            "weight": 1.0,
            "note": (
                "Sondes espacées d'environ 10 m le long des traces, mais d'environ "
                "100 à 130 m entre traces : tout ce qui est entre deux traces est interpolé."
            ),
        },
    )

    print(f"{len(rows)} sondes extraites pour {code}")
    print(f"  dates      : {', '.join(dates)}")
    print(f"  profondeur : {min(depths):.1f} m → {max(depths):.1f} m "
          f"(moyenne {sum(depths) / len(depths):.2f} m)")
    print(f"  emprise    : lon {min(r[0] for r in rows):.5f} → {max(r[0] for r in rows):.5f} · "
          f"lat {min(r[1] for r in rows):.5f} → {max(r[1] for r in rows):.5f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
