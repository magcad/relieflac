"""Copie MapLibre GL JS depuis node_modules vers vendor/, en .js plutôt qu'en .mjs.

Pourquoi renommer : un module ES chargé par `<script type="module">` est soumis à une
vérification stricte du type MIME. Tous les serveurs ne déclarent pas `.mjs` comme du
JavaScript — `python -m http.server` le sert en `text/plain`, ce qui bloque le
chargement. L'extension `.js` est reconnue partout ; le risque disparaît au lieu d'être
contourné au cas par cas.

    python tools/vendor_maplibre.py
"""

from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

from common import ROOT

SOURCE = ROOT / "node_modules" / "maplibre-gl"
TARGET = ROOT / "vendor"
MODULES = ["maplibre-gl.mjs", "maplibre-gl-shared.mjs", "maplibre-gl-worker.mjs"]


def main() -> int:
    if not SOURCE.exists():
        print("ERREUR : node_modules/maplibre-gl absent — lancez `npm install`", file=sys.stderr)
        return 1

    version = json.loads((SOURCE / "package.json").read_text(encoding="utf-8"))["version"]
    TARGET.mkdir(exist_ok=True)

    for name in MODULES:
        text = (SOURCE / "dist" / name).read_text(encoding="utf-8")
        for other in MODULES:
            text = text.replace(f"./{other}", f"./{other[:-4]}.js")
        destination = TARGET / f"{name[:-4]}.js"
        destination.write_text(text, encoding="utf-8", newline="\n")
        print(f"  {destination.name}  {len(text) / 1000:.0f} ko")

    for name in ("maplibre-gl.css",):
        shutil.copy(SOURCE / "dist" / name, TARGET / name)
        print(f"  {name}")
    shutil.copy(SOURCE / "LICENSE.txt", TARGET / "maplibre-gl.LICENSE.txt")

    (TARGET / "VERSION.txt").write_text(
        f"maplibre-gl {version}\n"
        f"Copié depuis node_modules par tools/vendor_maplibre.py.\n"
        f"Renommé .mjs → .js : voir l'en-tête du script.\n",
        encoding="utf-8", newline="\n",
    )
    print(f"\nmaplibre-gl {version} vendorisé dans vendor/")

    for stale in TARGET.glob("*.mjs"):
        stale.unlink()
        print(f"  ancien {stale.name} supprimé")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
