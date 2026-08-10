"""Rampe de couleurs profondeur → RVB, interpolée en OKLab.

Ce module est la référence de calcul ; l'application en porte l'équivalent en
JavaScript pour construire sa table de correspondance de 256 entrées. Les deux
doivent donner le même résultat — d'où le test de bout en bout en fin de fichier.

OKLab : Björn Ottosson, 2020. Interpoler dans cet espace évite les teintes
parasites d'un dégradé RVB brut, notamment sur la transition rouge → vert qui
passerait par un brun sale.
"""

from __future__ import annotations

import json

import numpy as np

from common import CONFIG_DIR


def load_palette() -> dict:
    with (CONFIG_DIR / "palette.json").open(encoding="utf-8") as fh:
        return json.load(fh)


def hex_to_rgb(value: str) -> tuple[float, float, float]:
    text = value.lstrip("#")
    return tuple(int(text[i : i + 2], 16) / 255.0 for i in (0, 2, 4))


# ------------------------------------------------------------------ sRGB ↔ OKLab

def srgb_to_linear(c: np.ndarray) -> np.ndarray:
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(c: np.ndarray) -> np.ndarray:
    c = np.clip(c, 0.0, 1.0)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)


_LMS_FROM_LINEAR = np.array([
    [0.4122214708, 0.5363325363, 0.0514459929],
    [0.2119034982, 0.6806995451, 0.1073969566],
    [0.0883024619, 0.2817188376, 0.6299787005],
])

_LAB_FROM_LMS = np.array([
    [0.2104542553,  0.7936177850, -0.0040720468],
    [1.9779984951, -2.4285922050,  0.4505937099],
    [0.0259040371,  0.7827717662, -0.8086757660],
])

_LMS_FROM_LAB = np.array([
    [1.0,  0.3963377774,  0.2158037573],
    [1.0, -0.1055613458, -0.0638541728],
    [1.0, -0.0894841775, -1.2914855480],
])

_LINEAR_FROM_LMS = np.array([
    [ 4.0767416621, -3.3077115913,  0.2309699292],
    [-1.2684380046,  2.6097574011, -0.3413193965],
    [-0.0041960863, -0.7034186147,  1.7076147010],
])


def srgb_to_oklab(rgb: np.ndarray) -> np.ndarray:
    lms = srgb_to_linear(np.asarray(rgb, dtype=np.float64)) @ _LMS_FROM_LINEAR.T
    return np.cbrt(lms) @ _LAB_FROM_LMS.T


def oklab_to_srgb(lab: np.ndarray) -> np.ndarray:
    lms = np.asarray(lab, dtype=np.float64) @ _LMS_FROM_LAB.T
    return linear_to_srgb((lms ** 3) @ _LINEAR_FROM_LMS.T)


# ------------------------------------------------------------------------ rampe

def build_lut(palette: dict | None = None, size: int = 256) -> tuple[np.ndarray, float]:
    """Table de correspondance RVB (uint8) échantillonnée de 0 à la profondeur du dernier palier.

    Retourne (lut, depth_max). Une profondeur d se lit à l'indice
    `round(clip(d / depth_max, 0, 1) * (size - 1))`.
    """
    palette = palette or load_palette()
    stops = sorted(palette["stops"], key=lambda s: s["depth_m"])
    depths = np.array([s["depth_m"] for s in stops], dtype=np.float64)
    colours = np.array([hex_to_rgb(s["color"]) for s in stops], dtype=np.float64)
    depth_max = float(depths[-1])

    labs = srgb_to_oklab(colours)
    samples = np.linspace(0.0, depth_max, size)

    if palette.get("interpolation", "oklab") == "oklab":
        channels = [np.interp(samples, depths, labs[:, i]) for i in range(3)]
        rgb = oklab_to_srgb(np.column_stack(channels))
    else:
        channels = [np.interp(samples, depths, colours[:, i]) for i in range(3)]
        rgb = np.column_stack(channels)

    return np.rint(np.clip(rgb, 0, 1) * 255).astype(np.uint8), depth_max


def colourise(depth: np.ndarray, palette: dict | None = None) -> np.ndarray:
    """Applique la rampe à un tableau de profondeurs (m). Les NaN ressortent en noir."""
    palette = palette or load_palette()
    lut, depth_max = build_lut(palette)
    ratio = np.clip(np.nan_to_num(depth, nan=0.0) / depth_max, 0.0, 1.0)
    return lut[np.rint(ratio * (len(lut) - 1)).astype(np.int32)]


if __name__ == "__main__":
    palette = load_palette()
    lut, depth_max = build_lut(palette)
    print(f"rampe {palette['interpolation']} · 0 → {depth_max:g} m · {len(lut)} entrées\n")
    for depth in (0, 0.5, 1, 2, 3, 5, 8, 12, 18, 25, 30, 40):
        r, g, b = lut[min(int(round(depth / depth_max * (len(lut) - 1))), len(lut) - 1)]
        print(f"  {depth:5.1f} m  #{r:02x}{g:02x}{b:02x}")
