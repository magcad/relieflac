// Vérifications de la logique de l'application, exécutables dans un navigateur.
//
// Ne couvre volontairement pas le rendu cartographique : MapLibre s'initialise depuis
// requestAnimationFrame, suspendu dans un onglet masqué, donc invérifiable sans page
// affichée. Tout le reste — table de couleurs, décodage de la grille, statistiques
// d'étalonnage, index des sondes, géométrie — l'est.
//
// La table de couleurs est comparée à test/reference.json, produit par le Python. Les
// deux implémentations doivent coïncider, sinon l'aperçu de contrôle et le téléphone
// afficheraient des couleurs différentes pour la même profondeur.

import { BedGrid, correctedAltitude } from '../src/bed.js';
import { Calibration, makeRecord } from '../src/calibration.js';
import { bearing, distanceMeters, formatSpeed } from '../src/geo.js';
import { formatAge, Level } from '../src/level.js';
import { applyPaletteOverride, bandLimits, buildLut, LUT_SIZE, lutIndex } from '../src/palette.js';
import { Probes, makeProbe } from '../src/probes.js';
import { SimPoints } from '../src/sim.js';
import { Soundings } from '../src/soundings.js';
import { runShaderChecks } from './shader.js';

const results = [];

function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition), detail });
}

function near(a, b, tolerance) {
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tolerance;
}

function hexAt(lut, depth, lutMax) {
  const index = lutIndex(depth, lutMax) * 4;
  return `#${[0, 1, 2].map((i) => lut[index + i].toString(16).padStart(2, '0')).join('')}`;
}

export async function run(base = '..') {
  const reference = await fetch(`${base}/test/reference.json`).then((r) => r.json());
  const palette = await fetch(`${base}/config/palette.json`).then((r) => r.json());
  const model = await fetch(`${base}/config/model.json`).then((r) => r.json());

  // --- table de couleurs : le JavaScript doit reproduire le Python ------------
  for (const [name, samples] of Object.entries(reference.presets)) {
    const lut = buildLut(palette, name);
    const wrong = Object.entries(samples)
      .filter(([depth, hex]) => hexAt(lut, Number(depth), reference.lut_max_depth_m) !== hex)
      .map(([depth, hex]) => `${depth} m : attendu ${hex}, obtenu ${hexAt(lut, Number(depth), reference.lut_max_depth_m)}`);
    check(`palette « ${name} » identique à la référence Python`, wrong.length === 0, wrong.slice(0, 3).join(' · '));
  }

  check('table de 256 entrées RVBA', buildLut(palette, 'marine').length === LUT_SIZE * 4);

  // Règle d'indexation : celle du shader, floor(ratio × 256) borné à 255.
  check('indexation de la table cohérente avec le shader',
    lutIndex(0, 30) === 0 && lutIndex(30, 30) === LUT_SIZE - 1
    && lutIndex(15, 30) === 128 && lutIndex(1e6, 30) === LUT_SIZE - 1,
    `0→${lutIndex(0, 30)} · 15→${lutIndex(15, 30)} · 30→${lutIndex(30, 30)}`);

  const marineLimits = bandLimits(palette.presets.marine, palette.lut_max_depth_m);
  check('bandes marine ordonnées et bornées',
    marineLimits.length === 6 && marineLimits[0] === 1 && marineLimits.at(-1) >= palette.lut_max_depth_m,
    marineLimits.join(', '));

  check('profondeur de sécurité = tirant + marge',
    near(palette.safety_contour.draft_m + palette.safety_contour.margin_m, reference.safety_depth_m, 1e-9));

  // --- grille : décodage et échantillonnage ----------------------------------
  const bed = await BedGrid.load(base);
  check('dimensions de la grille',
    bed.width === reference.bed.width && bed.height === reference.bed.height,
    `${bed.width}×${bed.height}`);

  const bad = reference.bed.probes.filter((probe) => {
    const z = bed.rawAltitudeAt(probe.lon, probe.lat);
    return probe.z === null ? Number.isFinite(z) : !near(z, probe.z, 0.02);
  });
  check(`altitude correcte sur ${reference.bed.probes.length} points de contrôle`, bad.length === 0,
    bad.map((p) => `${p.lat},${p.lon} attendu ${p.z}`).join(' · '));

  // Couverture du levé : c'est ce qui distingue une valeur mesurée d'une invention.
  check('carte de couverture chargée', bed.coverage instanceof Uint8Array,
    bed.coverage ? `${bed.coverage.length} cellules` : 'absente');
  if (bed.coverage) {
    const stats = reference.coverage;
    const inLake = Array.from(bed.coverage).filter((_, i) => Number.isFinite(bed.altitudes[i]));
    const beyond = inLake.filter((d) => d > 60).length / inLake.length;
    check('part du lac à plus de 60 m d\'une sonde conforme au calcul Python',
      Math.abs(beyond - stats.share_beyond_60m) < 0.01,
      `${(beyond * 100).toFixed(1)} % · attendu ${(stats.share_beyond_60m * 100).toFixed(1)} %`);
    check('distance nulle sur une trace du levé',
      bed.soundingDistanceAt(1.87132, 45.79328) <= 6,
      `${bed.soundingDistanceAt(1.87132, 45.79328)} m`);
  }

  // Le décalage d'étalonnage ne doit toucher que ce qui vient du levé de 2009.
  const waterPlane = model.reference_levels.rge_alti.value_m_ngf;
  check('décalage appliqué sous le plan d\'eau LiDAR',
    near(correctedAltitude(630, -1.5, waterPlane), 628.5, 1e-9));
  check('décalage ignoré sur le terrain mesuré au LiDAR',
    near(correctedAltitude(650.61, -1.5, waterPlane), 650.61, 1e-9));
  check('altitude absente reste absente', Number.isNaN(correctedAltitude(NaN, -1.5, waterPlane)));

  // --- étalonnage -------------------------------------------------------------
  const record = makeRecord({
    position: { lon: 1.87, lat: 45.79, accuracy: 8 },
    level: 647.0, levelSource: 'live', modelBedZ: 630.0,
    sounderDepth: 16.5, transducerDepth: 0.3, nearestSounding: 12,
  });
  // fond réel = 647,0 − 16,5 − 0,3 = 630,2 ; le modèle dit 630,0 → écart +0,2
  check('résidu d\'étalonnage', near(record.residual, 0.2, 1e-9), `${record.residual}`);
  check('modèle plus profond que la mesure', near(record.modelDepth, 17.0, 1e-9));
  check('relevé classé sur trace', record.onTrack === true);

  const calibration = new Calibration();
  calibration.clear();
  [0.1, 0.2, 0.25, 0.3, 0.9].forEach((residual, i) => calibration.add({
    lon: 1.87, lat: 45.79, accuracy: 8, level: 647, levelSource: 'live',
    modelBedZ: 630, sounderDepth: 16 + i * 0.1, transducerDepth: 0.3,
    residual, nearestSounding: 10, onTrack: true,
  }));
  const stats = calibration.stats();
  check('médiane des résidus insensible à l\'aberrant', near(stats.median, 0.25, 1e-9), `${stats.median}`);
  check('dispersion faible jugée exploitable', stats.usable === true, `IQR ${stats.iqr.toFixed(2)}`);

  calibration.clear();
  [-2, -0.5, 0.4, 1.8, 3.1].forEach((residual) => calibration.add({
    lon: 1.87, lat: 45.79, accuracy: 8, level: 647, levelSource: 'live',
    modelBedZ: 630, sounderDepth: 17, transducerDepth: 0.3,
    residual, nearestSounding: 10, onTrack: true,
  }));
  check('dispersion forte jugée inexploitable', calibration.stats().usable === false);
  calibration.clear();

  // --- sondes saisies à la main -----------------------------------------------
  // fond = 647,0 − 8,1 − 0,3 = 638,6 ; le modèle dit 630,0 → il annonçait 17,0 m d'eau
  // là où le sondeur en mesure 8,1 : c'est exactement le haut-fond que le levé a comblé.
  const probe = makeProbe({
    position: { lon: 1.87, lat: 45.79, accuracy: 8 },
    level: 647.0, levelSource: 'live', sounderDepth: 8.1, transducerDepth: 0.3, modelBedZ: 630.0,
  });
  check('altitude de fond d\'une sonde manuelle', near(probe.bedZ, 638.6, 1e-9), `${probe.bedZ}`);
  check('profondeur du modèle au même point', near(probe.modelDepth, 17.0, 1e-9));

  const probes = new Probes();
  probes.clear();
  const entry = probes.add(probe);
  check('sonde mémorisée', probes.count === 1);
  const csv = probes.toCsv().split('\n');
  check('export CSV : en-tête import_soundings + une ligne',
    csv[0].startsWith('lon,lat,depth,time') && csv.length === 2 && csv[1].split(',')[2] === '8.10',
    csv[0]);
  const geo = JSON.parse(probes.toGeoJson());
  check('export GeoJSON exploitable',
    geo.features.length === 1 && near(geo.features[0].properties.depth, 8.1, 1e-9)
    && geo.features[0].geometry.coordinates[0] === 1.87);

  // Correction : nouvelle profondeur, même cote d'origine (647,0 − 5,0 − 0,3 = 641,7).
  probes.update(entry.id, { sounderDepth: 5.0 });
  const fixed = probes.get(entry.id);
  check('correction d\'une sonde recalcule l\'altitude',
    near(fixed.sounderDepth, 5.0, 1e-9) && near(fixed.bedZ, 641.7, 1e-9), `${fixed.bedZ}`);
  probes.remove(entry.id);
  check('suppression d\'une sonde', probes.count === 0 && probes.get(entry.id) === null);
  probes.clear();

  // --- retouche de palette -----------------------------------------------------
  // On travaille sur une copie profonde pour ne pas polluer la palette de référence.
  const editable = JSON.parse(JSON.stringify(palette));
  applyPaletteOverride(editable, 'marine', {
    emerged_color: '#123456',
    bands: [{ max_depth_m: 2, color: '#ff0000' }, { max_depth_m: null, color: '#0000ff' }],
  });
  check('retouche : couleur émergée appliquée', editable.presets.marine.emerged_color === '#123456');
  check('retouche : bandes remplacées', editable.presets.marine.bands.length === 2);
  // À 5 m, la table doit désormais renvoyer le bleu de la dernière bande (au-delà de 2 m).
  check('retouche : la table suit la nouvelle bande',
    hexAt(buildLut(editable, 'marine'), 5, reference.lut_max_depth_m) === '#0000ff',
    hexAt(buildLut(editable, 'marine'), 5, reference.lut_max_depth_m));

  // --- points de simulation ----------------------------------------------------
  const sim = new SimPoints();
  sim.clear();
  const simPoint = sim.add({ lon: 1.87, lat: 45.79, bedZ: 645.0 });
  check('point de simulation mémorisé', sim.count === 1 && sim.get(simPoint.id).bedZ === 645.0);
  // À 647 m NGF le fond à 645 est sous 2 m d'eau ; à 644 il émerge de 1 m.
  check('émergence pilotée par la cote',
    647 - simPoint.bedZ === 2.0 && 644 - simPoint.bedZ === -1.0);
  sim.update(simPoint.id, { bedZ: 646.0 });
  check('altitude d\'un témoin ajustable', sim.get(simPoint.id).bedZ === 646.0);
  sim.remove(simPoint.id);
  check('suppression d\'un témoin', sim.count === 0);
  sim.clear();

  // --- sondes de 2009 ---------------------------------------------------------
  const soundings = await Soundings.load(base);
  check('8 118 sondes chargées', soundings.count === 8118, `${soundings.count}`);
  const first = [soundings.points[0], soundings.points[1]];
  check('distance nulle sur une sonde', soundings.distanceToNearest(first[0], first[1]) < 0.5);
  check('éloignement détecté hors du lac',
    !Number.isFinite(soundings.distanceToNearest(1.5, 45.5))
    || soundings.distanceToNearest(1.5, 45.5) > 1000);

  // --- cote --------------------------------------------------------------------
  const level = new Level(base);
  await level.refresh();
  const state = level.current();
  check('cote lue et plausible',
    near(state.value, 647, 8) && state.condition != null,
    `${state.value} m NGF · ${state.condition?.label}`);

  level.setManual(641.0);
  check('cote manuelle sous le seuil = navigation interdite',
    level.current().condition.key === 'forbidden');
  level.setManual(642.5);
  check('cote manuelle entre les seuils = délicat',
    level.current().condition.key === 'delicate');
  level.setManual(null);

  check('âge formaté', formatAge(90 * 60e3) === 'il y a 2 h', formatAge(90 * 60e3));

  // --- géométrie ----------------------------------------------------------------
  check('distance est-ouest à 45,8°',
    near(distanceMeters(1.87, 45.8, 1.88, 45.8), 776, 5),
    `${distanceMeters(1.87, 45.8, 1.88, 45.8).toFixed(0)} m`);
  check('distance nord-sud', near(distanceMeters(1.87, 45.8, 1.87, 45.81), 1113, 5));
  check('cap vers le nord', near(bearing(1.87, 45.8, 1.87, 45.81), 0, 0.5));
  check('cap vers l\'est', near(bearing(1.87, 45.8, 1.88, 45.8), 90, 0.5));
  check('vitesse en nœuds', formatSpeed(5, 'kn') === '9.7 nd', formatSpeed(5, 'kn'));
  check('vitesse en km/h', formatSpeed(5, 'kmh') === '18.0 km/h', formatSpeed(5, 'kmh'));

  // --- shader de profondeur -----------------------------------------------------
  await runShaderChecks(base, check);

  return results;
}
