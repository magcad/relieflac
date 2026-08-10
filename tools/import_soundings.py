"""Normalise un relevé de sondes externe (CSV, GPX, GeoJSON, KML) vers le format du modèle.

    python tools/import_soundings.py data/imports/sortie.gpx --transducer-depth 0.35
    python tools/import_soundings.py data/imports/contours.geojson --reference-level 646.8
    python tools/import_soundings.py data/imports/log.csv --dry-run

Voir data/imports/README.md pour les formats et les précautions (horodatage,
immersion du transducteur, décalage de niveau d'eau Garmin).
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

from common import DATA_DIR, write_soundings

LON_KEYS = ("lon", "lng", "long", "longitude", "x")
LAT_KEYS = ("lat", "latitude", "y")
DEPTH_KEYS = ("depth", "depth_m", "prof", "profondeur", "sonde", "z", "water_depth")
TIME_KEYS = ("time", "date", "timestamp", "datetime", "utc")

LAKE_BOUNDS = (1.80, 45.75, 1.95, 45.84)  # garde-fou : lon/lat autour de Vassivière


# --------------------------------------------------------------------------- lecture


def pick_column(fieldnames: list[str], candidates: tuple[str, ...], override: str | None):
    if override:
        if override not in fieldnames:
            raise SystemExit(f"ERREUR : colonne « {override} » absente ({', '.join(fieldnames)})")
        return override
    lowered = {name.strip().lower(): name for name in fieldnames}
    for candidate in candidates:
        if candidate in lowered:
            return lowered[candidate]
    for key, name in lowered.items():
        if any(key.startswith(candidate) for candidate in candidates):
            return name
    return None


def number(value: str) -> float:
    return float(str(value).strip().replace(",", "."))


def read_csv(path: Path, args) -> list[tuple]:
    with path.open(encoding="utf-8-sig", newline="") as fh:
        sample = fh.read(8192)
        fh.seek(0)
        try:
            dialect = csv.Sniffer().sniff(sample, delimiters=",;\t|")
        except csv.Error:
            dialect = csv.excel
        reader = csv.DictReader(fh, dialect=dialect)
        fields = reader.fieldnames or []

        lon_col = pick_column(fields, LON_KEYS, args.lon_col)
        lat_col = pick_column(fields, LAT_KEYS, args.lat_col)
        depth_col = pick_column(fields, DEPTH_KEYS, args.depth_col)
        time_col = pick_column(fields, TIME_KEYS, args.time_col)

        missing = [
            label
            for label, col in (("longitude", lon_col), ("latitude", lat_col), ("profondeur", depth_col))
            if col is None
        ]
        if missing:
            raise SystemExit(
                f"ERREUR : colonne(s) {', '.join(missing)} introuvable(s).\n"
                f"  colonnes du fichier : {', '.join(fields)}\n"
                f"  précisez-les avec --lon-col / --lat-col / --depth-col"
            )
        print(f"  colonnes : lon={lon_col} lat={lat_col} depth={depth_col} "
              f"time={time_col or '—'}")

        rows = []
        for record in reader:
            try:
                rows.append(
                    (
                        number(record[lon_col]),
                        number(record[lat_col]),
                        number(record[depth_col]),
                        (record.get(time_col) or "").strip() if time_col else "",
                    )
                )
            except (TypeError, ValueError):
                continue
        return rows


def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1].lower()


def read_gpx(path: Path, args) -> list[tuple]:
    root = ET.parse(path).getroot()
    rows = []
    for node in root.iter():
        if local_name(node.tag) not in ("trkpt", "rtept", "wpt"):
            continue
        try:
            lon = float(node.attrib["lon"])
            lat = float(node.attrib["lat"])
        except (KeyError, ValueError):
            continue

        depth = None
        timestamp = ""
        for child in node.iter():
            name = local_name(child.tag)
            text = (child.text or "").strip()
            if not text:
                continue
            if name == "depth" and depth is None:
                try:
                    depth = float(text)
                except ValueError:
                    pass
            elif name == "time" and not timestamp:
                timestamp = text
            elif name in ("desc", "cmt") and depth is None:
                match = re.search(r"(\d+[.,]?\d*)\s*m", text, re.IGNORECASE)
                if match:
                    depth = number(match.group(1))

        if depth is not None:
            rows.append((lon, lat, depth, timestamp))
    return rows


def read_geojson(path: Path, args) -> list[tuple]:
    with path.open(encoding="utf-8") as fh:
        payload = json.load(fh)
    features = payload.get("features", [payload]) if isinstance(payload, dict) else []

    rows = []
    for feature in features:
        props = {str(k).lower(): v for k, v in (feature.get("properties") or {}).items()}
        depth = next(
            (props[key] for key in DEPTH_KEYS if key in props and props[key] is not None), None
        )
        if depth is None and args.depth_col:
            depth = props.get(args.depth_col.lower())
        if depth is None:
            continue
        try:
            depth = number(depth)
        except (TypeError, ValueError):
            continue

        timestamp = next((str(props[key]) for key in TIME_KEYS if props.get(key)), "")
        for lon, lat in iter_coords(feature.get("geometry") or {}):
            rows.append((lon, lat, depth, timestamp))
    return rows


def iter_coords(geometry: dict):
    """Aplatit n'importe quelle géométrie GeoJSON en une suite de couples (lon, lat)."""
    coords = geometry.get("coordinates")
    if coords is None:
        return

    def walk(node):
        if isinstance(node, (int, float)):
            return
        if node and isinstance(node[0], (int, float)):
            yield float(node[0]), float(node[1])
            return
        for child in node:
            yield from walk(child)

    yield from walk(coords)


def read_kml(path: Path, args) -> list[tuple]:
    root = ET.parse(path).getroot()
    rows = []
    for placemark in root.iter():
        if local_name(placemark.tag) != "placemark":
            continue

        text_blob = " ".join(
            (node.text or "") for node in placemark.iter()
            if local_name(node.tag) in ("name", "description", "value")
        )
        match = re.search(r"(-?\d+[.,]?\d*)\s*m\b", text_blob, re.IGNORECASE)
        if not match:
            continue
        depth = number(match.group(1))

        for node in placemark.iter():
            if local_name(node.tag) != "coordinates" or not (node.text or "").strip():
                continue
            for token in node.text.split():
                parts = token.split(",")
                if len(parts) >= 2:
                    try:
                        rows.append((float(parts[0]), float(parts[1]), depth, ""))
                    except ValueError:
                        continue
    return rows


READERS = {
    ".csv": read_csv, ".txt": read_csv, ".tsv": read_csv,
    ".gpx": read_gpx,
    ".geojson": read_geojson, ".json": read_geojson,
    ".kml": read_kml,
}


# --------------------------------------------------------------------------- principal


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("path", type=Path, help="fichier à importer")
    parser.add_argument("--name", help="nom du jeu produit (défaut : nom du fichier)")
    parser.add_argument("--label", help="libellé lisible du jeu")
    parser.add_argument("--transducer-depth", type=float, default=0.0,
                        help="immersion de la sonde sous la flottaison, en m (ajoutée aux profondeurs)")
    parser.add_argument("--reference-level", type=float,
                        help="cote du lac en m NGF si les sondes ne sont pas horodatées")
    parser.add_argument("--weight", type=float, default=1.0,
                        help="poids du jeu dans le modèle (défaut 1.0)")
    parser.add_argument("--lon-col"), parser.add_argument("--lat-col")
    parser.add_argument("--depth-col"), parser.add_argument("--time-col")
    parser.add_argument("--dry-run", action="store_true", help="analyser sans écrire")
    args = parser.parse_args()

    if not args.path.exists():
        print(f"ERREUR : {args.path} introuvable", file=sys.stderr)
        return 1

    reader = READERS.get(args.path.suffix.lower())
    if reader is None:
        print(f"ERREUR : extension {args.path.suffix} non prise en charge "
              f"({', '.join(sorted(READERS))})", file=sys.stderr)
        return 1

    print(f"lecture de {args.path.name}")
    rows = reader(args.path, args)
    if not rows:
        print("ERREUR : aucune sonde exploitable trouvée", file=sys.stderr)
        return 1

    west, south, east, north = LAKE_BOUNDS
    inside = [r for r in rows if west <= r[0] <= east and south <= r[1] <= north]
    outside = len(rows) - len(inside)
    positive = [r for r in inside if r[2] > 0]
    dropped = len(inside) - len(positive)

    if outside:
        print(f"  {outside} point(s) hors de l'emprise du lac, écartés")
    if dropped:
        print(f"  {dropped} point(s) de profondeur nulle ou négative, écartés")
    if not positive:
        print("ERREUR : plus aucune sonde après filtrage", file=sys.stderr)
        return 1

    adjusted = [(lon, lat, depth + args.transducer_depth, ts) for lon, lat, depth, ts in positive]

    depths = [r[2] for r in adjusted]
    timed = sum(1 for r in adjusted if r[3])
    dates = sorted({r[3][:10] for r in adjusted if r[3]})

    print(f"\n  {len(adjusted)} sondes retenues")
    print(f"  emprise    : lon {min(r[0] for r in adjusted):.5f} → {max(r[0] for r in adjusted):.5f} · "
          f"lat {min(r[1] for r in adjusted):.5f} → {max(r[1] for r in adjusted):.5f}")
    print(f"  profondeur : {min(depths):.2f} → {max(depths):.2f} m "
          f"(moyenne {sum(depths) / len(depths):.2f} m)")
    if args.transducer_depth:
        print(f"               immersion sonde {args.transducer_depth:+.2f} m déjà appliquée")
    print(f"  horodatées : {timed}/{len(adjusted)}"
          + (f" · dates {', '.join(dates[:6])}{'…' if len(dates) > 6 else ''}" if dates else ""))

    if args.reference_level is not None:
        reference = {"mode": "fixed_value", "value_m_ngf": args.reference_level}
        print(f"  référence  : cote fixe {args.reference_level} m NGF")
    elif timed == len(adjusted):
        reference = {"mode": "level_history"}
        print("  référence  : cote EDF à l'horodatage de chaque sonde")
    else:
        print("\nERREUR : sondes non horodatées et aucune --reference-level fournie.\n"
              "  Sans cote de référence, une profondeur n'est pas convertible en altitude\n"
              "  de fond sur une retenue qui marne. Voir data/imports/README.md.",
              file=sys.stderr)
        return 1

    if args.dry_run:
        print("\n(--dry-run : rien n'a été écrit)")
        return 0

    name = args.name or re.sub(r"[^a-z0-9_-]+", "-", args.path.stem.lower()).strip("-")
    path = write_soundings(
        name,
        adjusted,
        {
            "label": args.label or f"Relevé importé — {args.path.name}",
            "source": f"import local : {args.path.name}",
            "imported_from": args.path.name,
            "transducer_depth_m": args.transducer_depth,
            "reference": reference,
            "weight": args.weight,
            "survey_dates": dates,
        },
    )
    print(f"\n→ {path.relative_to(DATA_DIR.parent)}")
    print("  relancez `python tools/build_grid.py` pour reconstruire le modèle")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
