"""Copie MapLibre GL JS depuis node_modules vers vendor/, en .js plutôt qu'en .mjs.

Pourquoi renommer : un module ES chargé par `<script type="module">` est soumis à une
vérification stricte du type MIME. Tous les serveurs ne déclarent pas `.mjs` comme du
JavaScript — `python -m http.server` le sert en `text/plain`, ce qui bloque le
chargement. L'extension `.js` est reconnue partout ; le risque disparaît au lieu d'être
contourné au cas par cas.

Attention : renommer ne suffit pas. Le bundle reconstruit AUSSI l'URL de son worker à
l'exécution, à partir de `import.meta.url` et d'un nom de fichier écrit en dur sans le
préfixe `./` (`new URL(`./${t}`, e)`). La réécriture ci-dessous couvre donc les deux
formes, avec et sans `./`. À défaut, le worker est demandé en `.mjs`, répond 404 sans
qu'aucune erreur ne remonte, et toutes les couches `geojson` restent vides — panne
diagnostiquée dans docs/BUG-sondes-2009-invisibles.md. Par sécurité, src/map.js fixe de
toute façon l'URL explicitement via `setWorkerUrl`.

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
        for other in MODULES + ["maplibre-gl-worker-dev.mjs"]:
            # Nom nu (URL de worker recomposée à l'exécution) autant que spécificateur
            # d'import : voir l'avertissement en tête de fichier.
            text = text.replace(other, f"{other[:-4]}.js")
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
