// Vérification du shader de profondeur, sans MapLibre.
//
// La carte ne peut pas être testée dans un onglet masqué : MapLibre s'initialise depuis
// requestAnimationFrame, qui y est suspendu. Le shader, lui, se rend très bien dans un
// canvas WebGL2 que l'on pilote soi-même — il suffit de fournir la matrice de projection
// que MapLibre passerait.
//
// C'est le code le plus risqué de l'application et celui que l'œil ne suffit pas à
// juger : on mesure ici la continuité du champ de profondeur et la largeur des contours,
// les deux propriétés qui distinguent un rendu net d'un rendu en gros carrés.

import { BedGrid } from '../src/bed.js';
import { DepthLayer } from '../src/depth-layer.js';
import { bandColors, bandLimits, buildLut, hexToVec4 } from '../src/palette.js';

const EARTH = 40075016.685578488;
const ORIGIN = EARTH / 2;

const toUnit = (x, y) => [(x + ORIGIN) / EARTH, (ORIGIN - y) / EARTH];

/** Projection orthographique d'un rectangle mercator unitaire vers le repère de clip. */
function orthoMatrix(vx0, vy0, vx1, vy1) {
  const m = new Float32Array(16);
  m[0] = 2 / (vx1 - vx0);
  m[5] = -2 / (vy1 - vy0);
  m[10] = 1;
  m[12] = (-2 * vx0) / (vx1 - vx0) - 1;
  m[13] = (2 * vy0) / (vy1 - vy0) + 1;
  m[15] = 1;
  return m;
}

function styleFor(palette, presetName, level, overrides = {}) {
  const preset = palette.presets[presetName];
  return {
    lut: buildLut(palette, presetName),
    bands: bandLimits(preset, palette.lut_max_depth_m),
    bandColors: bandColors(preset),
    lutMax: palette.lut_max_depth_m,
    level,
    offset: 0,
    waterPlane: 648.8,
    safe: palette.safety_contour.draft_m + palette.safety_contour.margin_m,
    opacity: 1,
    emerged: hexToVec4(preset.emerged_color),
    outline: hexToVec4(preset.band_outline_color ?? '#182028'),
    safetyColor: hexToVec4(palette.safety_contour.color),
    showOutlines: true,
    showSafety: true,
    ...overrides,
  };
}

/**
 * Rend une fenêtre de `spanMeters` de large autour d'un point, et retourne les pixels.
 * Un `spanMeters` petit pour une taille d'image donnée = fort zoom, donc beaucoup de
 * pixels écran par cellule de 5 m : c'est là que les gros carrés apparaissaient.
 */
function renderWindow(layer, gl, canvas, { lon, lat, spanMeters, size }) {
  const mx = (lon / 360) * EARTH;
  const my = (Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) * ORIGIN;
  // Mercator dilate les distances de 1/cos(latitude).
  const half = (spanMeters / Math.cos((lat * Math.PI) / 180)) / 2;

  const [x0, y1] = toUnit(mx - half, my - half);
  const [x1, y0] = toUnit(mx + half, my + half);

  canvas.width = size;
  canvas.height = size;
  gl.viewport(0, 0, size, size);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);

  layer.render(gl, { defaultProjectionData: { mainMatrix: orthoMatrix(x0, y0, x1, y1) } });

  const pixels = new Uint8Array(size * size * 4);
  gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  return pixels;
}

const keyAt = (pixels, size, x, y) => {
  const o = ((size - 1 - y) * size + x) * 4; // readPixels renvoie les lignes de bas en haut
  return `${pixels[o]},${pixels[o + 1]},${pixels[o + 2]},${pixels[o + 3]}`;
};

export async function runShaderChecks(base = '..', check) {
  const palette = await fetch(`${base}/config/palette.json`).then((r) => r.json());
  const bed = await BedGrid.load(base);

  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true });
  if (!gl) { check('contexte WebGL2 disponible', false, 'aucun contexte'); return; }
  check('contexte WebGL2 disponible', true, gl.getParameter(gl.VERSION));

  const layer = new DepthLayer(bed, styleFor(palette, 'degrade', 647.06));
  try {
    layer.onAdd({ triggerRepaint() {} }, gl);
    check('shader de profondeur compilé et lié', true);
  } catch (err) {
    check('shader de profondeur compilé et lié', false, err.message);
    return;
  }

  // Zone étendue du bassin est, couvrant plusieurs bandes de profondeur.
  const spot = { lon: 1.8985, lat: 45.7975 };
  const size = 128;
  const level = 647.06;
  const limits = bandLimits(palette.presets.marine, palette.lut_max_depth_m);
  const colours = bandColors(palette.presets.marine);

  const bandFor = (depth) => {
    const index = limits.findIndex((limit) => depth <= limit);
    return colours[index < 0 ? limits.length - 1 : index].slice(0, 3).map((c) => Math.round(c * 255));
  };

  /** Coordonnées géographiques du centre du pixel (x, y) d'une fenêtre rendue. */
  const pixelToLngLat = ({ lon, lat, spanMeters }, x, y) => {
    const mx = (lon / 360) * EARTH;
    const my = (Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) * ORIGIN;
    const half = (spanMeters / Math.cos((lat * Math.PI) / 180)) / 2;
    const px = mx - half + ((x + 0.5) / size) * 2 * half;
    const py = my + half - ((y + 0.5) / size) * 2 * half;
    return [
      (px / EARTH) * 360,
      (Math.atan(Math.exp((py / ORIGIN) * Math.PI)) - Math.PI / 4) * (360 / Math.PI),
    ];
  };

  // --- le rendu suit-il l'interpolation bilinéaire ? ---------------------------
  //
  // Compter les teintes ne prouverait rien : la table de couleurs quantifie de toute
  // façon. On compare donc la couleur rendue à la bande calculée côté processeur, une
  // fois en bilinéaire et une fois à la cellule la plus proche. Si le shader
  // interpolait encore en NEAREST, c'est la seconde qui l'emporterait.
  layer.setStyle(styleFor(palette, 'marine', level));
  const window120 = { ...spot, spanMeters: 120 };
  const pixels120 = renderWindow(layer, gl, canvas, { ...window120, size });

  let agreeBilinear = 0;
  let agreeNearest = 0;
  let compared = 0;
  let discriminating = 0;

  for (let y = 8; y < size - 8; y += 3) {
    for (let x = 8; x < size - 8; x += 3) {
      const [lon, lat] = pixelToLngLat(window120, x, y);
      const zBilinear = bed.altitudeAt(lon, lat);
      const zNearest = bed.rawAltitudeAt(lon, lat);
      if (!Number.isFinite(zBilinear) || !Number.isFinite(zNearest)) continue;

      const wantedBilinear = bandFor(level - zBilinear);
      const wantedNearest = bandFor(level - zNearest);
      const same = wantedBilinear.every((c, i) => c === wantedNearest[i]);
      if (same) continue; // ce pixel ne départage pas les deux hypothèses
      discriminating += 1;

      const o = ((size - 1 - y) * size + x) * 4;
      const actual = [pixels120[o], pixels120[o + 1], pixels120[o + 2]];
      if (pixels120[o + 3] < 250) continue; // pixel de contour ou de bord
      compared += 1;
      if (wantedBilinear.every((c, i) => Math.abs(c - actual[i]) < 6)) agreeBilinear += 1;
      if (wantedNearest.every((c, i) => Math.abs(c - actual[i]) < 6)) agreeNearest += 1;
    }
  }

  check('le test départage bien les deux interpolations', discriminating >= 20,
    `${discriminating} pixels où bilinéaire et plus-proche-voisin diffèrent`);
  check('le rendu suit l\'interpolation bilinéaire, pas la maille',
    compared > 0 && agreeBilinear > agreeNearest * 3,
    `bilinéaire ${agreeBilinear}/${compared} · plus proche voisin ${agreeNearest}/${compared}`);

  // --- largeur des contours indépendante du zoom ------------------------------
  //
  // Le point de mesure est cherché plutôt que choisi : au zoom serré, une fenêtre prise
  // au hasard peut ne traverser aucune limite de bande, et l'absence de contour serait
  // alors imputée au shader.
  const onBoundary = (() => {
    const { west, south, east, north } = bed.meta.bounds_wgs84;
    for (let i = 1; i < 200; i += 1) {
      for (let j = 1; j < 200; j += 1) {
        const lon = west + ((east - west) * i) / 200;
        const lat = south + ((north - south) * j) / 200;
        const z = bed.altitudeAt(lon, lat);
        if (!Number.isFinite(z)) continue;
        const depth = level - z;
        // Une limite franchie, et un fond assez pentu pour que le contour traverse la
        // fenêtre la plus serrée.
        if (Math.abs(depth - 5) > 0.05) continue;
        const gradient = Math.abs(bed.altitudeAt(lon + 0.0004, lat) - z);
        if (gradient > 0.15 && gradient < 2) return { lon, lat };
      }
    }
    return null;
  })();
  check('limite de bande trouvée pour mesurer les contours', onBoundary !== null,
    onBoundary ? `${onBoundary.lat.toFixed(5)}, ${onBoundary.lon.toFixed(5)}` : 'aucune');
  const probe = onBoundary ?? spot;

  const outlineHex = palette.presets.marine.band_outline_color.replace('#', '');
  const target = [0, 2, 4].map((i) => parseInt(outlineHex.slice(i, i + 2), 16));
  const isOutline = (pixels, x, y) => {
    const o = ((size - 1 - y) * size + x) * 4;
    return pixels[o + 3] > 200
      && Math.abs(pixels[o] - target[0]) < 45
      && Math.abs(pixels[o + 1] - target[1]) < 45
      && Math.abs(pixels[o + 2] - target[2]) < 45;
  };

  // Longueur moyenne des segments de contour rencontrés le long des lignes, sur toute
  // l'image : c'est l'épaisseur apparente du trait. Elle doit rester la même quel que
  // soit le zoom — c'est précisément ce qu'apporte la normalisation par fwidth().
  const measure = (spanMeters) => {
    const pixels = renderWindow(layer, gl, canvas, { ...probe, spanMeters, size });
    let hits = 0;
    let runs = 0;
    for (let y = 0; y < size; y += 1) {
      let inside = false;
      for (let x = 0; x < size; x += 1) {
        const hit = isOutline(pixels, x, y);
        if (hit) { hits += 1; if (!inside) runs += 1; }
        inside = hit;
      }
    }
    return { hits, runs, width: runs ? hits / runs : 0 };
  };

  const close = measure(120);
  const far = measure(600);
  check('contours effectivement tracés', close.hits > 50 && far.hits > 50,
    `${close.hits} px à 120 m · ${far.hits} px à 600 m`);
  check('épaisseur des contours constante d\'un zoom à l\'autre',
    close.width > 0 && far.width > 0 && Math.abs(close.width - far.width) < 1.5,
    `${close.width.toFixed(2)} px à 120 m de large · ${far.width.toFixed(2)} px à 600 m (rapport de zoom ×5)`);

  // --- hors du lac ------------------------------------------------------------
  const outside = renderWindow(layer, gl, canvas, { lon: 1.75, lat: 45.70, spanMeters: 400, size });
  const opaque = Array.from({ length: size }, (_, x) => outside[((size >> 1) * size + x) * 4 + 3])
    .filter((a) => a > 10).length;
  check('rien n\'est peint hors de l\'emprise', opaque === 0, `${opaque} px opaques`);

  layer.onRemove(null, gl);
}
