"""Rendu profondeur → couleur : préréglages en bandes ou en dégradé, contour de sécurité.

Ce module est la référence de calcul ; l'application en porte l'équivalent en
JavaScript. Les deux passent par la même table de correspondance de 256 entrées, de
sorte que le shader est identique pour un préréglage en bandes ou en dégradé — un
préréglage en bandes produit simplement une table en marches.

Conventions reprises des cartes marines (norme S-52, Garmin BlueChart) :

- des **bandes discrètes** plutôt qu'un dégradé : l'œil détecte un bord
  instantanément et une variation progressive très mal ;
- un **contour de sécurité** tracé en gras à « tirant d'eau + marge », objet central
  de la carte, qui sépare le navigable du reste ;
- des **familles de couleurs porteuses de sens** : beige pour la terre, jamais
  confondable avec de l'eau ; rouge réservé au danger ; bleus pour l'eau navigable,
  le plus foncé pour le moins profond afin que l'eau profonde reste claire.

OKLab (Björn Ottosson, 2020) est utilisé pour les dégradés : interpoler dans cet
espace évite les teintes parasites d'un dégradé RVB brut, notamment la transition
rouge → vert qui passerait par un brun sale.
"""

from __future__ import annotations

import json

import numpy as np

from common import CONFIG_DIR

LUT_SIZE = 256


def load_palette() -> dict:
    with (CONFIG_DIR / "palette.json").open(encoding="utf-8") as fh:
        return json.load(fh)


def get_preset(palette: dict, name: str | None = None) -> tuple[str, dict]:
    name = name or palette["active_preset"]
    if name not in palette["presets"]:
        raise KeyError(f"préréglage inconnu : {name!r} "
                       f"(disponibles : {', '.join(palette['presets'])})")
    return name, palette["presets"][name]


def hex_to_rgb(value: str) -> tuple[float, float, float]:
    text = value.lstrip("#")
    return tuple(int(text[i : i + 2], 16) / 255.0 for i in (0, 2, 4))


def rgb8(value: str) -> np.ndarray:
    return np.rint(np.array(hex_to_rgb(value)) * 255).astype(np.uint8)


def safety_depth(palette: dict) -> float:
    cfg = palette["safety_contour"]
    return float(cfg["draft_m"]) + float(cfg["margin_m"])


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


# ------------------------------------------------------------------------- table

def band_limits(preset: dict, lut_max: float) -> list[float]:
    """Bornes supérieures des bandes ; `null` dans la config signifie « jusqu'au fond »."""
    limits = []
    for band in preset["bands"]:
        limit = band.get("max_depth_m")
        limits.append(lut_max if limit is None else float(limit))
    limits[-1] = max(limits[-1], lut_max)
    return limits


def build_lut(palette: dict | None = None, preset_name: str | None = None) -> tuple[np.ndarray, float]:
    """Table RVB de 256 entrées couvrant 0 → `lut_max_depth_m`."""
    palette = palette or load_palette()
    _, preset = get_preset(palette, preset_name)
    lut_max = float(palette["lut_max_depth_m"])
    samples = np.linspace(0.0, lut_max, LUT_SIZE)

    if preset["mode"] == "banded":
        limits = band_limits(preset, lut_max)
        colours = np.array([hex_to_rgb(b["color"]) for b in preset["bands"]])
        index = np.searchsorted(np.array(limits), samples, side="left")
        rgb = colours[np.clip(index, 0, len(colours) - 1)]
    else:
        stops = sorted(preset["stops"], key=lambda s: s["depth_m"])
        depths = np.array([s["depth_m"] for s in stops], dtype=np.float64)
        colours = np.array([hex_to_rgb(s["color"]) for s in stops], dtype=np.float64)
        if preset.get("interpolation", "oklab") == "oklab":
            labs = srgb_to_oklab(colours)
            rgb = oklab_to_srgb(
                np.column_stack([np.interp(samples, depths, labs[:, i]) for i in range(3)])
            )
        else:
            rgb = np.column_stack([np.interp(samples, depths, colours[:, i]) for i in range(3)])

    return np.rint(np.clip(rgb, 0, 1) * 255).astype(np.uint8), lut_max


# ------------------------------------------------------------------------ rendu

def _boundary(mask: np.ndarray) -> np.ndarray:
    """Cellules du masque adjacentes à une cellule hors masque, dans les 4 directions."""
    edge = np.zeros(mask.shape, dtype=bool)
    edge[:-1, :] |= mask[:-1, :] != mask[1:, :]
    edge[1:, :] |= mask[1:, :] != mask[:-1, :]
    edge[:, :-1] |= mask[:, :-1] != mask[:, 1:]
    edge[:, 1:] |= mask[:, 1:] != mask[:, :-1]
    return edge


def _adjacency(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Cellules de `a` touchant une cellule de `b` dans les 4 directions."""
    touch = np.zeros(a.shape, dtype=bool)
    touch[:-1, :] |= a[:-1, :] & b[1:, :]
    touch[1:, :] |= a[1:, :] & b[:-1, :]
    touch[:, :-1] |= a[:, :-1] & b[:, 1:]
    touch[:, 1:] |= a[:, 1:] & b[:, :-1]
    return touch


def _thicken(mask: np.ndarray, width: int) -> np.ndarray:
    out = mask.copy()
    for _ in range(max(0, width - 1)):
        grown = out.copy()
        grown[:-1, :] |= out[1:, :]
        grown[1:, :] |= out[:-1, :]
        grown[:, :-1] |= out[:, 1:]
        grown[:, 1:] |= out[:, :-1]
        out = grown
    return out


def render(
    depth: np.ndarray,
    valid: np.ndarray,
    palette: dict | None = None,
    preset_name: str | None = None,
    outlines: bool = True,
    safety: bool = True,
) -> np.ndarray:
    """Colorise un tableau de profondeurs (m). Retourne un tableau (h, w, 3) uint8."""
    palette = palette or load_palette()
    _, preset = get_preset(palette, preset_name)
    lut, lut_max = build_lut(palette, preset_name)

    ratio = np.clip(np.nan_to_num(depth, nan=0.0) / lut_max, 0.0, 1.0)
    out = lut[np.rint(ratio * (LUT_SIZE - 1)).astype(np.int32)]

    emerged = valid & (depth <= 0)
    out[emerged] = rgb8(preset["emerged_color"])

    if outlines and preset["mode"] == "banded":
        limits = band_limits(preset, lut_max)
        index = np.searchsorted(np.array(limits), np.nan_to_num(depth, nan=0.0), side="left")
        index = np.where(emerged, -1, index)
        out[_boundary(index) & valid] = rgb8(preset["band_outline_color"])

    if safety:
        cfg = palette["safety_contour"]
        safe = safety_depth(palette)
        # Limite *interne* de la zone peu profonde, pas le rivage : sans cette
        # distinction le contour suit tout le trait de côte, où la profondeur est
        # de toute façon inférieure à la cote de sécurité.
        shallow = valid & (depth > 0) & (depth <= safe)
        deep = valid & (depth > safe)
        line = _thicken(_adjacency(deep, shallow), int(cfg["width_px"]))
        out[line & valid] = rgb8(cfg["color"])

    return out


if __name__ == "__main__":
    palette = load_palette()
    print(f"profondeur de sécurité : {safety_depth(palette):.2f} m "
          f"(tirant {palette['safety_contour']['draft_m']} + "
          f"marge {palette['safety_contour']['margin_m']})\n")
    for name in palette["presets"]:
        active = " ← actif" if name == palette["active_preset"] else ""
        preset = palette["presets"][name]
        lut, lut_max = build_lut(palette, name)
        print(f"{name}  ({preset['mode']}){active}")
        for depth in (0.5, 1, 2, 3, 5, 8, 12, 18, 25, 30):
            r, g, b = lut[min(int(round(depth / lut_max * (LUT_SIZE - 1))), LUT_SIZE - 1)]
            print(f"    {depth:5.1f} m  #{r:02x}{g:02x}{b:02x}")
        print()
