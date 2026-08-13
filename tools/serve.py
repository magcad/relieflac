"""Serveur statique de développement.

    python tools/serve.py [port]

`python -m http.server` ne convient pas ici pour deux raisons :

- il met en cache — un module ES corrigé continue d'être servi depuis le cache du
  navigateur, et l'on débogue une version qui n'existe plus sur le disque ;
- il déduit les types MIME du registre Windows, où `.mjs` vaut `text/plain`, ce que la
  vérification stricte des modules ES rejette.

Ce serveur force `Cache-Control: no-store` et déclare les types utiles. Il ne sert qu'au
développement : en production, GitHub Pages fait le travail.
"""

from __future__ import annotations

import os
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

from common import ROOT

TYPES = {
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".json": "application/json",
    ".geojson": "application/geo+json",
    ".webmanifest": "application/manifest+json",
    ".css": "text/css",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".csv": "text/csv",
}


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, **TYPES}

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def log_message(self, fmt, *args):
        if "200" not in fmt % args:
            super().log_message(fmt, *args)


def main() -> int:
    # Argument d'abord, puis `PORT` : le second permet à un lanceur d'attribuer un port
    # libre quand 8123 est déjà pris par une autre session de développement.
    port = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get("PORT") or 8123)
    handler = partial(Handler, directory=str(ROOT))
    print(f"ReliefLac sur http://localhost:{port}/  (Ctrl+C pour arrêter)")
    ThreadingHTTPServer(("127.0.0.1", port), handler).serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
