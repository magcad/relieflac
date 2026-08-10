// Rendu profondeur → couleur. Port JavaScript de tools/palette.py : les deux doivent
// produire la même table, de sorte que l'aperçu de contrôle et le téléphone montrent
// exactement les mêmes couleurs.
//
// Les deux modes passent par une table de 256 entrées couvrant 0 → lutMaxDepth. Un
// préréglage en bandes produit une table en marches, un préréglage continu une table
// lissée : le shader est identique dans les deux cas.

export const LUT_SIZE = 256;
export const MAX_BANDS = 8; // borne du tableau d'uniformes du shader

/**
 * Indice de table pour une profondeur.
 *
 * Règle unique, partagée par le JavaScript, le Python et le shader : l'entrée i couvre
 * l'intervalle [i/256, (i+1)/256) du domaine, donc indice = floor(ratio × 256). C'est
 * exactement ce que fait un échantillonnage de texture en NEAREST, ce qui évite au
 * shader de calculer autrement que les deux autres.
 *
 * Toute autre convention se paie : `Math.round()` arrondit au-dessus alors que `round()`
 * en Python arrondit au pair le plus proche, et les deux implémentations ne tombaient
 * pas dans la même bande aux profondeurs pile sur une borne.
 */
export function lutIndex(depth, lutMax) {
  const ratio = Math.min(Math.max(depth / lutMax, 0), 1);
  return Math.min(Math.floor(ratio * LUT_SIZE), LUT_SIZE - 1);
}

export function hexToRgb(hex) {
  const text = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(text.slice(i, i + 2), 16) / 255);
}

export function hexToVec4(hex, alpha = 1) {
  return [...hexToRgb(hex), alpha];
}

// --- sRGB ↔ OKLab (Björn Ottosson, 2020) --------------------------------------
// Interpoler un dégradé dans cet espace évite les teintes parasites du RVB brut :
// un rouge → vert en RVB passe par un brun sale.

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linearToSrgb = (c) => {
  const v = Math.min(Math.max(c, 0), 1);
  return v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
};

function srgbToOklab([r, g, b]) {
  const lr = srgbToLinear(r), lg = srgbToLinear(g), lb = srgbToLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklabToSrgb([L, A, B]) {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

// --- table -------------------------------------------------------------------

/** Couleurs des bandes, en vec4, dans le même ordre que bandLimits(). */
export function bandColors(preset) {
  if (preset.mode !== 'banded') return [];
  return preset.bands.map((band) => hexToVec4(band.color));
}

/** Bornes supérieures des bandes ; `null` dans la config signifie « jusqu'au fond ». */
export function bandLimits(preset, lutMax) {
  if (preset.mode !== 'banded') return [];
  const limits = preset.bands.map((b) => (b.max_depth_m == null ? lutMax : b.max_depth_m));
  limits[limits.length - 1] = Math.max(limits[limits.length - 1], lutMax);
  return limits;
}

function interpolate(samples, xs, ys) {
  return samples.map((x) => {
    let i = 1;
    while (i < xs.length - 1 && xs[i] < x) i += 1;
    const t = (x - xs[i - 1]) / (xs[i] - xs[i - 1] || 1);
    return ys[i - 1] + Math.min(Math.max(t, 0), 1) * (ys[i] - ys[i - 1]);
  });
}

/** Table RVBA de 256 entrées, en Uint8Array de 1024 octets. */
export function buildLut(palette, presetName) {
  const preset = palette.presets[presetName ?? palette.active_preset];
  const lutMax = palette.lut_max_depth_m;
  // Chaque entrée est évaluée au centre de l'intervalle qu'elle couvre, en cohérence
  // avec lutIndex().
  const samples = Array.from({ length: LUT_SIZE }, (_, i) => ((i + 0.5) / LUT_SIZE) * lutMax);
  const out = new Uint8Array(LUT_SIZE * 4);

  let colours;
  if (preset.mode === 'banded') {
    const limits = bandLimits(preset, lutMax);
    const bands = preset.bands.map((b) => hexToRgb(b.color));
    colours = samples.map((d) => {
      const index = limits.findIndex((limit) => d <= limit);
      return bands[index < 0 ? bands.length - 1 : index];
    });
  } else {
    const stops = [...preset.stops].sort((a, b) => a.depth_m - b.depth_m);
    const depths = stops.map((s) => s.depth_m);
    const rgbs = stops.map((s) => hexToRgb(s.color));
    if ((preset.interpolation ?? 'oklab') === 'oklab') {
      const labs = rgbs.map(srgbToOklab);
      const channels = [0, 1, 2].map((c) => interpolate(samples, depths, labs.map((l) => l[c])));
      colours = samples.map((_, i) => oklabToSrgb([channels[0][i], channels[1][i], channels[2][i]]));
    } else {
      const channels = [0, 1, 2].map((c) => interpolate(samples, depths, rgbs.map((v) => v[c])));
      colours = samples.map((_, i) => [channels[0][i], channels[1][i], channels[2][i]]);
    }
  }

  colours.forEach(([r, g, b], i) => {
    out[i * 4] = Math.round(r * 255);
    out[i * 4 + 1] = Math.round(g * 255);
    out[i * 4 + 2] = Math.round(b * 255);
    out[i * 4 + 3] = 255;
  });
  return out;
}

/** Couleur CSS correspondant à une profondeur — pour le gros chiffre et les pastilles. */
export function depthColor(palette, presetName, depth) {
  const preset = palette.presets[presetName ?? palette.active_preset];
  if (!(depth > 0)) return preset.emerged_color;
  const lut = buildLut(palette, presetName);
  const index = lutIndex(depth, palette.lut_max_depth_m) * 4;
  return `rgb(${lut[index]}, ${lut[index + 1]}, ${lut[index + 2]})`;
}

/** Entrées de légende du préréglage actif, prêtes à afficher. */
export function legendEntries(palette, presetName) {
  const preset = palette.presets[presetName ?? palette.active_preset];
  const entries = [{ color: preset.emerged_color, label: 'émergé' }];
  if (preset.mode === 'banded') {
    let previous = 0;
    preset.bands.forEach((band) => {
      const limit = band.max_depth_m;
      entries.push({
        color: band.color,
        label: limit == null ? `> ${previous} m` : previous === 0 ? `< ${limit} m` : `${previous}–${limit} m`,
      });
      if (limit != null) previous = limit;
    });
  } else {
    preset.stops.forEach((stop) => entries.push({ color: stop.color, label: `${stop.depth_m} m` }));
  }
  return entries;
}
