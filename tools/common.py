"""Utilitaires partagés par les scripts de préparation des données ReliefLac."""

from __future__ import annotations

import bisect
import csv
import json
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG_DIR = ROOT / "config"
DATA_DIR = ROOT / "data"
SOUNDINGS_DIR = DATA_DIR / "soundings"
IMPORTS_DIR = DATA_DIR / "imports"
CACHE_DIR = ROOT / ".cache"

# Colonnes du format normalisé : toute source de sondes est convertie vers ceci.
SOUNDING_FIELDS = ["lon", "lat", "depth_m", "timestamp"]


def load_model_config() -> dict:
    with (CONFIG_DIR / "model.json").open(encoding="utf-8") as fh:
        return json.load(fh)


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)
        fh.write("\n")


def write_soundings(name: str, rows, meta: dict) -> Path:
    """Écrit un jeu de sondes normalisé `<name>.csv` et son descripteur `<name>.json`.

    `rows` est un itérable de tuples (lon, lat, depth_m, timestamp|None).
    """
    SOUNDINGS_DIR.mkdir(parents=True, exist_ok=True)
    csv_path = SOUNDINGS_DIR / f"{name}.csv"
    count = 0
    with csv_path.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.writer(fh)
        writer.writerow(SOUNDING_FIELDS)
        for lon, lat, depth, ts in rows:
            writer.writerow([f"{lon:.6f}", f"{lat:.6f}", f"{depth:.2f}", ts or ""])
            count += 1
    meta = dict(meta)
    meta["count"] = count
    meta["generated_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    write_json(SOUNDINGS_DIR / f"{name}.json", meta)
    return csv_path


def read_soundings(name: str) -> tuple[list[tuple[float, float, float, str]], dict]:
    with (SOUNDINGS_DIR / f"{name}.json").open(encoding="utf-8") as fh:
        meta = json.load(fh)
    rows = []
    with (SOUNDINGS_DIR / f"{name}.csv").open(encoding="utf-8", newline="") as fh:
        for rec in csv.DictReader(fh):
            rows.append(
                (
                    float(rec["lon"]),
                    float(rec["lat"]),
                    float(rec["depth_m"]),
                    rec.get("timestamp") or "",
                )
            )
    return rows, meta


def list_sounding_sets() -> list[str]:
    if not SOUNDINGS_DIR.exists():
        return []
    return sorted(p.stem for p in SOUNDINGS_DIR.glob("*.json"))


class LevelHistory:
    """Historique horaire de la cote du lac, pour dater les sondes importées.

    Les sondes d'un enregistreur (Garmin, Lowrance…) donnent une profondeur sous
    la surface à un instant donné. Sur une retenue dont la cote varie de plusieurs
    mètres dans l'année, l'altitude du fond ne se déduit qu'en connaissant la cote
    à cet instant précis — d'où cet index.
    """

    def __init__(self, path: Path | None = None):
        self.times: list[datetime] = []
        self.values: list[float] = []
        path = path or (DATA_DIR / "level-history.json")
        if not path.exists():
            return
        with path.open(encoding="utf-8") as fh:
            payload = json.load(fh)
        pairs = sorted(
            (parse_time(entry["t"]), float(entry["v"]))
            for entry in payload.get("entries", [])
            if entry.get("t") and entry.get("v") is not None
        )
        self.times = [p[0] for p in pairs]
        self.values = [p[1] for p in pairs]

    def __bool__(self) -> bool:
        return bool(self.times)

    def at(self, when: datetime, max_gap_hours: float = 12.0) -> float | None:
        """Cote interpolée à l'instant demandé, ou None si l'historique est trop lacunaire."""
        if not self.times:
            return None
        idx = bisect.bisect_left(self.times, when)
        if idx == 0:
            return self._if_close(self.times[0], self.values[0], when, max_gap_hours)
        if idx >= len(self.times):
            return self._if_close(self.times[-1], self.values[-1], when, max_gap_hours)
        t0, t1 = self.times[idx - 1], self.times[idx]
        v0, v1 = self.values[idx - 1], self.values[idx]
        span = (t1 - t0).total_seconds()
        if span <= 0:
            return v0
        if span > max_gap_hours * 3600:
            return None
        ratio = (when - t0).total_seconds() / span
        return v0 + ratio * (v1 - v0)

    @staticmethod
    def _if_close(t: datetime, v: float, when: datetime, max_gap_hours: float) -> float | None:
        return v if abs((when - t).total_seconds()) <= max_gap_hours * 3600 else None


def parse_time(value: str) -> datetime:
    text = value.strip().replace("Z", "+00:00")
    parsed = datetime.fromisoformat(text)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def resolve_reference_level(
    meta: dict, timestamp: str, config: dict, history: LevelHistory
) -> float | None:
    """Cote du plan d'eau à laquelle se rapporte une profondeur, en m NGF.

    Trois modes, déclarés dans le descripteur `<name>.json` du jeu de sondes :

    - `fixed_key`    : une entrée de `config/model.json` → `reference_levels`
                       (cas du levé OFB 2009, dont la cote est un paramètre à caler) ;
    - `fixed_value`  : une cote connue, saisie à la main ;
    - `level_history`: cote lue dans l'historique EDF à l'horodatage de la sonde
                       (cas des enregistrements de sondeur de bord).
    """
    ref = meta.get("reference", {})
    mode = ref.get("mode")

    if mode == "fixed_key":
        entry = config["reference_levels"].get(ref["key"])
        return float(entry["value_m_ngf"]) if entry else None

    if mode == "fixed_value":
        return float(ref["value_m_ngf"])

    if mode == "level_history":
        if not timestamp:
            return None
        return history.at(parse_time(timestamp))

    return None
