"""Relève la cote du lac de Vassivière auprès d'EDF et l'écrit dans data/.

Pourquoi ce script existe : l'API EDF ne renvoie aucun en-tête CORS, elle est donc
inappelable depuis une page GitHub Pages. Ce script tourne côté GitHub Actions,
toutes les heures, et commite le résultat dans le site statique.

En cas d'échec, la dernière valeur connue est conservée et marquée `stale`.
"""

from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone

from common import DATA_DIR, load_model_config, write_json

HISTORY_MAX_ENTRIES = 24 * 365 * 3  # ~3 ans d'historique horaire


def fetch_payload(url: str) -> dict:
    request = urllib.request.Request(
        url, headers={"User-Agent": "ReliefLac/0.1 (+https://github.com/)", "Accept": "application/json"}
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.loads(response.read().decode("utf-8"))


def extract_water_level(payload: dict) -> dict:
    charts = payload.get("charts") or []
    chart = next((c for c in charts if c.get("type") == "WATER_LEVEL"), None)
    if chart is None:
        raise ValueError("aucun graphique WATER_LEVEL dans la réponse")

    graph = chart.get("graph") or {}
    unit = graph.get("valueAxisUnit")
    if unit != "METER_NGF":
        raise ValueError(f"unité inattendue : {unit!r} (attendu METER_NGF)")

    last = graph.get("lastData") or {}
    if last.get("value") is None:
        raise ValueError("lastData vide")

    thresholds = {}
    for limit in graph.get("limits") or []:
        if limit.get("condition") == "NOT_APPROPRIATE" and limit.get("min") == 0.0:
            thresholds["forbidden_below"] = limit.get("max")
        elif limit.get("condition") == "DELICATE":
            thresholds["delicate_below"] = limit.get("max")
        elif limit.get("condition") == "APPROPRIATE":
            thresholds["normal_max"] = limit.get("max")

    series = [
        {"t": entry["dateTime"], "v": float(entry["value"])}
        for entry in graph.get("datas") or []
        if entry.get("value") is not None
    ]

    return {
        "level_m_ngf": float(last["value"]),
        "measured_at": last.get("dateTime"),
        "condition": last.get("condition"),
        "thresholds": thresholds,
        "recent": series[-48:],
    }


def load_previous() -> dict | None:
    path = DATA_DIR / "level.json"
    if not path.exists():
        return None
    with path.open(encoding="utf-8") as fh:
        return json.load(fh)


def update_history(series: list[dict]) -> int:
    path = DATA_DIR / "level-history.json"
    entries: dict[str, float] = {}
    if path.exists():
        with path.open(encoding="utf-8") as fh:
            for entry in json.load(fh).get("entries", []):
                entries[entry["t"]] = entry["v"]

    added = sum(1 for point in series if point["t"] not in entries)
    for point in series:
        entries[point["t"]] = point["v"]

    ordered = [{"t": t, "v": entries[t]} for t in sorted(entries)][-HISTORY_MAX_ENTRIES:]
    write_json(
        path,
        {
            "unit": "METER_NGF",
            "source": "EDF — Ma Rivière et Moi",
            "note": "Historique horaire de la cote, sert à dater les sondes importées.",
            "entries": ordered,
        },
    )
    return added


def main() -> int:
    config = load_model_config()
    source = config["level_source"]
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")

    try:
        payload = fetch_payload(source["url"])
        data = extract_water_level(payload)
    except (urllib.error.URLError, ValueError, KeyError, TimeoutError) as exc:
        print(f"ERREUR de récupération : {exc}", file=sys.stderr)
        previous = load_previous()
        if previous is None:
            print("aucune valeur antérieure à conserver", file=sys.stderr)
            return 1
        previous["stale"] = True
        previous["fetched_at"] = now
        previous["last_error"] = str(exc)
        write_json(DATA_DIR / "level.json", previous)
        print(f"valeur précédente conservée ({previous['level_m_ngf']} m NGF), marquée stale")
        return 0

    added = update_history(data.pop("recent"))

    write_json(
        DATA_DIR / "level.json",
        {
            **data,
            "fetched_at": now,
            "stale": False,
            "source": f"{source['provider']} — {config['lake']['name']}",
            "source_url": source["public_url"],
        },
    )

    print(f"cote {data['level_m_ngf']:.2f} m NGF "
          f"mesurée le {data['measured_at']} ({data['condition']})")
    print(f"  seuils : {data['thresholds']}")
    print(f"  historique : {added} nouveau(x) relevé(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
