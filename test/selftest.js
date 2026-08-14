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
import { angleDelta, CameraFollow, catchUp, deadReckon } from '../src/camera.js';
import { anchoredMatrix } from '../src/depth-layer.js';
import { CorrectionsSync } from '../src/sync.js';
import { Calibration, makeRecord } from '../src/calibration.js';
import { bearing, distanceMeters, formatSpeed } from '../src/geo.js';
import { formatAge, Level } from '../src/level.js';
import { applyPaletteOverride, bandLimits, buildLut, LUT_SIZE, lutIndex } from '../src/palette.js';
import { Probes, makeProbe } from '../src/probes.js';
import { SimPoints } from '../src/sim.js';
import { Soundings } from '../src/soundings.js';
import { closeRing, dedupeRing, groundAltitude, ringArea, Zones } from '../src/zones.js';
import { runShaderChecks } from './shader.js';

const results = [];

function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition), detail });
}

function near(a, b, tolerance) {
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tolerance;
}

/** Centre d'une cellule de la grille, en lon/lat — l'inverse de `BedGrid.indexAt`. */
function cellCentre(bed, index) {
  const col = index % bed.width;
  const row = Math.floor(index / bed.width);
  const mx = bed.x0 + ((col + 0.5) / bed.width) * (bed.x1 - bed.x0);
  const my = bed.y1 - ((row + 0.5) / bed.height) * (bed.y1 - bed.y0);
  const circumference = 40075016.685578488;
  return [
    (mx / circumference) * 360,
    (Math.atan(Math.exp((my / (circumference / 2)) * Math.PI)) * 2 - Math.PI / 2) * (180 / Math.PI),
  ];
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
    marineLimits.length === 7 && marineLimits[0] === 1 && marineLimits.at(-1) >= palette.lut_max_depth_m,
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

  // Troisième état de la carte de fiabilité : l'encadrement communautaire Quickdraw.
  // Ni mesuré, ni inconnu — un sondeur est passé, sa bande borne la profondeur.
  const community = bed.meta.quickdraw_source;
  check('borne communautaire chargée', bed.bound instanceof Uint8Array,
    bed.bound ? `${bed.bound.length} cellules` : 'absente');
  if (bed.bound && community && community.available) {
    const inLake = [];
    for (let i = 0; i < bed.bound.length; i += 1) {
      if (Number.isFinite(bed.baseAltitudes[i])) inLake.push(i);
    }
    const bounded = inLake.filter((i) => bed.bound[i] > 0).length / inLake.length;
    check('part du lac encadrée par la communauté conforme au calcul Python',
      Math.abs(bounded - reference.coverage.share_bounded) < 0.01,
      `${(bounded * 100).toFixed(1)} % · attendu ${(reference.coverage.share_bounded * 100).toFixed(1)} %`);

    // L'invariant de toute la couche, et le seul qui compte : la grille publiée ne doit
    // nulle part être plus profonde que ce que la communauté autorise. Il tient sur chaque
    // cellule encadrée, puisque le relèvement est un maximum et que rien, ensuite, ne
    // creuse. Un calage qui aurait glissé d'une emprise le ferait tomber en masse.
    const zAc = community.z_ac_m_ngf;
    const violations = inLake.filter(
      (i) => bed.bound[i] > 0 && bed.baseAltitudes[i] < zAc - bed.bound[i] - 0.02,
    );
    check('aucune cellule plus profonde que la borne communautaire',
      violations.length === 0,
      violations.length
        ? `${violations.length} cellules, pire ${Math.min(...violations.map(
          (i) => bed.baseAltitudes[i] - (zAc - bed.bound[i]))).toFixed(2)} m`
        : `${inLake.filter((i) => bed.bound[i] > 0).length} cellules encadrées vérifiées`);

    const raised = inLake.find((i) => bed.bound[i] > 0);
    check('lecture de la borne au point', bed.bound[raised] > 0
      && bed.communityBoundAt(...cellCentre(bed, raised)) === bed.bound[raised],
      `${bed.bound[raised]} m`);
  }

  // --- second fond : la carte communautaire seule -----------------------------
  //
  // Les deux grilles doivent partager la maille au pixel près — c'est ce qui autorise
  // l'échange en place — sans partager leurs valeurs, faute de quoi la bascule ne
  // changerait rien tout en prétendant le contraire.
  if (reference.bed_quickdraw) {
    const qd = reference.bed_quickdraw;
    const survey = bed.baseAltitudes;
    const switched = await bed.useSource('quickdraw');
    check('bascule vers le fond communautaire',
      switched && bed.source === 'quickdraw', bed.source);
    check('même maille que le fond du levé',
      bed.width === qd.width && bed.height === qd.height
      && bed.baseAltitudes.length === survey.length,
      `${bed.width}×${bed.height}`);

    const wrong = qd.probes.filter((probe) => {
      const z = bed.rawAltitudeAt(probe.lon, probe.lat);
      return probe.z === null ? Number.isFinite(z) : !near(z, probe.z, 0.02);
    });
    check(`altitude communautaire correcte sur ${qd.probes.length} points de contrôle`,
      wrong.length === 0,
      wrong.map((p) => `${p.lat},${p.lon} attendu ${p.z}`).join(' · '));

    let differing = 0;
    for (let i = 0; i < survey.length; i += 1) {
      if (Math.abs(survey[i] - bed.baseAltitudes[i]) > 0.02) differing += 1;
    }
    check('les deux fonds ne sont pas la même carte', differing > survey.length / 100,
      `${differing} cellules diffèrent`);

    // L'invariant de cette carte-ci : chaque cellule reste dans la bande que la communauté
    // lui donne. Le canal vert porte la borne profonde arrondie au-dessus, donc
    // z >= z_ac - G est vrai sans marge d'arrondi — à ceci près que le plan d'eau de
    // référence est le plan d'eau **effectif**, recalage de terrain compris : le décalage
    // est uniforme, il déplace l'encadrement avec la carte au lieu de l'en faire sortir.
    // Là où le MNT a écrasé la bande, le canal vert vaut zéro : l'altitude n'en sort plus
    // et la règle ne s'y applique pas — c'est le fichier qui le dit, non le test qui le
    // devine.
    const datum = qd.effective_z_ac_m_ngf;
    let outside = 0;
    let framed = 0;
    let valid = 0;
    for (let i = 0; i < bed.baseAltitudes.length; i += 1) {
      const z = bed.baseAltitudes[i];
      if (!Number.isFinite(z)) continue;
      valid += 1;
      if (bed.coverage[i] !== 0) continue; // aucune bande ici
      framed += 1;
      if (bed.bound[i] > 0 && z < datum - bed.bound[i] - 0.02) outside += 1;
    }
    check('aucune cellule sous la bande que la communauté lui donne', outside === 0,
      `${framed} cellules encadrées vérifiées, ${outside} hors bande`);
    check('le recalage de terrain est bien celui de la configuration',
      Math.abs((qd.z_ac_m_ngf + qd.datum_offset_m) - datum) < 0.005,
      `${qd.datum_offset_m} m → plan d'eau de référence ${datum} m NGF`);
    // Presque tout ce que cette carte affiche vient d'une bande : le reste est le terrain
    // du MNT qui comble les îlots. Si la proportion s'effondrait, c'est que la mosaïque
    // n'aurait pas été décodée.
    check('la carte communautaire est faite de bandes, pas de remplissage',
      framed / valid > 0.95, `${(100 * framed / valid).toFixed(1)} % des cellules affichées`);

    // Un relevé manuel doit mordre sur le fond affiché, quel qu'il soit.
    {
      const lon = 1.87132; const lat = 45.79328;
      const before = bed.baseAltitudeAt(lon, lat);
      bed.applyCorrections([{ lon, lat, bedZ: before + 3 }], 20);
      check('relevé appliqué sur le fond communautaire',
        near(bed.altitudeAt(lon, lat), before + 3, 0.05),
        `${bed.altitudeAt(lon, lat).toFixed(2)} m`);
      bed.applyCorrections([], 20);
      check('relevé retiré : retour exact au fond communautaire',
        bed.altitudes === bed.baseAltitudes);
    }

    await bed.useSource('ofb2009');
    check('retour au fond du levé', bed.source === 'ofb2009'
      && bed.baseAltitudes === survey);
  }

  // --- correction manuelle de la carte (« 2009 corrigée ») --------------------
  {
    const lon = 1.87132; const lat = 45.79328;
    const before = bed.baseAltitudeAt(lon, lat);
    const target = before - 3; // on creuse le fond de 3 m au relevé
    // Point témoin lointain (point de contrôle à ~2 km), bien au-delà du rayon de 20 m.
    const far = reference.bed.probes[2];
    const farBefore = bed.altitudeAt(far.lon, far.lat);
    bed.applyCorrections([{ lon, lat, bedZ: target }], 20);
    // Lecture bilinéaire sur une grille mélangée au cosinus : on tombe à quelques cm du
    // relevé, pas au centimètre — largement sous le pas d'ajustement de 25 cm.
    check('correction : le fond au point suit le relevé',
      Math.abs(bed.altitudeAt(lon, lat) - target) < 0.25,
      `${bed.altitudeAt(lon, lat).toFixed(2)} attendu ${target.toFixed(2)}`);
    check('correction : couverture rendue « mesurée » au point',
      bed.soundingDistanceAt(lon, lat) <= 3, `${bed.soundingDistanceAt(lon, lat)} m`);
    check('correction : hors rayon, le fond reste celui de 2009',
      near(bed.altitudeAt(far.lon, far.lat), farBefore, 1e-9));
    bed.applyCorrections([], 20); // retrait : retour au levé brut
    check('correction retirée : retour exact au 2009',
      near(bed.altitudeAt(lon, lat), before, 1e-9),
      `${bed.altitudeAt(lon, lat)} vs ${before}`);
  }

  // --- forme de la correction : plateau, fondu, fusion ------------------------
  //
  // Ce que la version précédente faisait mal, et qui se vérifie ici : la valeur relevée
  // n'existait qu'au centre exact (un pic, pas une plaque), et les relevés étaient
  // appliqués l'un après l'autre sur le résultat du précédent — deux points voisins se
  // corrigeaient donc mutuellement, et le résultat dépendait de leur ordre de saisie.
  {
    const lon = 1.87132; const lat = 45.79328;
    const east = (metres) => lon + metres / (111320 * Math.cos((lat * Math.PI) / 180));
    // Valeur 2009 de la MÊME cellule que celle que lira `rawAltitudeAt` : comparer une
    // lecture bilinéaire à une lecture de cellule ferait échouer des vérifications justes.
    const cell2009 = (x, y) => bed.baseAltitudes[bed.indexAt(x, y)];
    // La grille est en Float32 : une altitude vers 640 m n'y tient qu'à 6·10⁻⁵ près. La
    // tolérance dit « exactement », au bruit du stockage — le rendu, lui, arrondit au cm.
    const EXACT = 1e-3;
    const raw2009 = bed.baseAltitudeAt(lon, lat);
    const target = raw2009 + 8; // haut-fond relevé : le fond remonte de 8 m

    // Plateau : sur la moitié centrale du rayon, la carte vaut EXACTEMENT la valeur relevée.
    bed.applyCorrections([{ lon, lat, bedZ: target, radius_m: 40 }], 20);
    check('plateau : la valeur relevée tient sur la moitié centrale du rayon',
      near(bed.rawAltitudeAt(east(15), lat), target, EXACT),
      `à 15 m : ${bed.rawAltitudeAt(east(15), lat).toFixed(3)} attendu ${target.toFixed(3)}`);
    const edge = bed.rawAltitudeAt(east(30), lat);
    check('fondu : entre le plateau et le bord, la carte rejoint le levé',
      edge > Math.min(raw2009, target) && edge < Math.max(raw2009, target),
      `à 30 m : ${edge.toFixed(2)} entre ${raw2009.toFixed(2)} et ${target.toFixed(2)}`);
    check('portée : au-delà du rayon, le levé est intact',
      near(bed.rawAltitudeAt(east(45), lat), cell2009(east(45), lat), 1e-9));

    // Rayon propre à chaque relevé : le réglage général n'est qu'un défaut.
    bed.applyCorrections([{ lon, lat, bedZ: target, radius_m: 8 }], 60);
    check('rayon propre au relevé : il l\'emporte sur le réglage général',
      near(bed.rawAltitudeAt(east(30), lat), cell2009(east(30), lat), 1e-9),
      `${bed.rawAltitudeAt(east(30), lat).toFixed(2)}`);

    // Fusion : deux relevés qui se recouvrent donnent le même résultat dans les deux sens.
    const a = { lon, lat, bedZ: target, radius_m: 30 };
    const b = { lon: east(25), lat, bedZ: raw2009 + 3, radius_m: 30 };
    bed.applyCorrections([a, b], 20);
    const ab = Array.from(bed.altitudes.slice(0, bed.altitudes.length));
    bed.applyCorrections([b, a], 20);
    const differing = ab.reduce((n, z, i) => {
      const other = bed.altitudes[i];
      return n + (Number.isFinite(z) === Number.isFinite(other) && (!Number.isFinite(z) || Math.abs(z - other) < 1e-9) ? 0 : 1);
    }, 0);
    check('fusion : le résultat ne dépend plus de l\'ordre des relevés', differing === 0,
      `${differing} cellule(s) divergentes`);

    // Et un plateau reste maître chez lui : le fondu d'un voisin ne déplace pas une valeur
    // mesurée ici — sans quoi une sonde afficherait autre chose que ce qu'on a saisi.
    check('un relevé voisin n\'entame pas le plateau d\'un autre',
      near(bed.rawAltitudeAt(lon, lat), target, EXACT),
      `${bed.rawAltitudeAt(lon, lat).toFixed(3)} attendu ${target.toFixed(3)}`);

    bed.applyCorrections([], 20);
  }

  // --- zones émergées tracées à la main ---------------------------------------
  {
    const lon = 1.87132; const lat = 45.79328;
    const dLon = 25 / (111320 * Math.cos((lat * Math.PI) / 180));
    const dLat = 25 / 111320;
    const ring = [
      [lon - dLon, lat - dLat], [lon + dLon, lat - dLat],
      [lon + dLon, lat + dLat], [lon - dLon, lat + dLat],
    ];
    const cote = 647;
    const sol = groundAltitude(cote, 0.5); // 50 cm au-dessus de l'eau
    const far = reference.bed.probes[2];
    const farBefore = bed.baseAltitudeAt(far.lon, far.lat);

    const cell2009 = (x, y) => bed.baseAltitudes[bed.indexAt(x, y)];
    bed.applyCorrections([{ ring, bedZ: sol, radius_m: 10 }], 20);
    check('zone : tout l\'intérieur du contour est porté à l\'altitude du sol',
      near(bed.rawAltitudeAt(lon, lat), sol, 1e-3)
      && near(bed.rawAltitudeAt(lon + dLon / 2, lat + dLat / 2), sol, 1e-3),
      `centre ${bed.rawAltitudeAt(lon, lat).toFixed(3)} attendu ${sol.toFixed(3)}`);
    check('zone : elle émerge à la cote qui a servi à la tracer',
      cote - bed.rawAltitudeAt(lon, lat) < 0);
    check('zone : au-delà du fondu, le levé est intact',
      near(bed.altitudeAt(far.lon, far.lat), farBefore, 1e-9));
    bed.applyCorrections([], 20);
    check('zone retirée : retour exact au 2009',
      near(bed.rawAltitudeAt(lon, lat), cell2009(lon, lat), 1e-9));

    check('aire d\'un contour de 50 m de côté', Math.abs(ringArea(ring) - 2500) < 30,
      `${ringArea(ring).toFixed(0)} m²`);
    check('anneau refermé pour GeoJSON',
      closeRing(ring).length === 5 && closeRing(ring)[4][0] === ring[0][0]
      && closeRing(closeRing(ring)).length === 5);

    // Fermeture au double-clic : le geste émet deux `click` avant de fermer, donc un sommet
    // en double. Et un tracé bouclé à la main répète le premier sommet à la fin.
    const doubled = [...ring, ring[3], ring[0]];
    check('sommets confondus retirés du tracé',
      dedupeRing(doubled).length === 4 && dedupeRing(ring).length === 4,
      `${dedupeRing(doubled).length} sommets`);
    check('un tracé de moins de trois sommets reste refusé',
      dedupeRing([ring[0], ring[0]]).length === 1);

    const zones = new Zones();
    zones.clear();
    const zone = zones.add({ ring, bedZ: sol, height_m: 0.5, cote_m: cote, feather_m: 10 });
    check('zone mémorisée', zones.count === 1 && near(zones.get(zone.id).bedZ, sol, 1e-9));
    // La hauteur se rectifie contre la cote du tracé, jamais contre celle du jour : une zone
    // qui se déplacerait verticalement à chaque montée du lac ne voudrait plus rien dire.
    zones.update(zone.id, { height_m: 1.5 });
    check('hauteur corrigée : recalée sur la cote du tracé',
      near(zones.get(zone.id).bedZ, cote + 1.5, 1e-9), `${zones.get(zone.id).bedZ}`);
    const geo = JSON.parse(zones.toGeoJson());
    check('export GeoJSON d\'une zone exploitable',
      geo.features[0].geometry.type === 'Polygon'
      && geo.features[0].geometry.coordinates[0].length === 5
      && near(geo.features[0].properties.ground_m_ngf, cote + 1.5, 1e-9));
    zones.remove(zone.id);
    check('suppression d\'une zone', zones.count === 0 && zones.get(zone.id) === null);
    zones.clear();
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

  // Même geste, à pied sur un haut-fond découvert : fond réel = 647,0 + 0,4 = 647,4, sans
  // immersion de sonde puisqu'il n'y a pas de sonde. Le modèle dit 630,0 → écart +17,4.
  const walkedRecord = makeRecord({
    position: { lon: 1.87, lat: 45.79, accuracy: 8 },
    level: 647.0, levelSource: 'live', modelBedZ: 630.0,
    sounderDepth: -0.4, transducerDepth: 0.3, nearestSounding: 12,
  });
  check('résidu d\'un relevé à pied sur haut-fond émergé',
    near(walkedRecord.residual, 17.4, 1e-9), `${walkedRecord.residual}`);

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

  // Forme du résidu : constante ou proportionnelle à la profondeur ?
  //
  // Le piège que ces trois cas verrouillent : relevé en petit fond seulement, une erreur
  // d'échelle du sondeur se groupe aussi bien qu'un décalage de référence, et la constante
  // qu'on en tirerait fausserait le large d'autant plus qu'il est profond.
  const shaped = (pairs) => {
    calibration.clear();
    pairs.forEach(([depth, residual]) => calibration.add({
      lon: 1.87, lat: 45.79, accuracy: 8, level: 647, levelSource: 'live',
      modelBedZ: 630, sounderDepth: depth - 0.3, transducerDepth: 0.3,
      residual, nearestSounding: 10, onTrack: true,
    }));
    return calibration.stats();
  };

  const wide = [3, 5, 9, 15, 22, 28];
  const flat = shaped(wide.map((d) => [d, 1.0]));
  check('écart constant sur une large plage : décalage de référence',
    flat.model === 'constant' && flat.usable === true, `${flat.model}`);

  const sloped = shaped(wide.map((d) => [d, 0.27 * d]));
  check('écart proportionnel à la profondeur : erreur d\'échelle détectée',
    sloped.model === 'proportionnel', `${sloped.model}`);
  check('erreur proportionnelle : la correction constante est refusée',
    sloped.usable === false, `usable ${sloped.usable}`);
  check('pente rapportée en % de la profondeur',
    near(sloped.slopePercent, 27, 0.5), `${sloped.slopePercent}`);

  // Écarts de l'ordre de ceux relevés à Vauveix, tous entre 3,4 et 4,1 m. Les deux modèles
  // y collent aussi bien — l'app doit refuser de trancher plutôt que de rassurer à tort.
  const narrow = shaped([[3.4, 0.85], [3.5, 0.95], [3.6, 1.09], [3.8, 1.02], [4.1, 1.10]]);
  check('bande de profondeurs trop étroite : aucune conclusion',
    narrow.model === 'indetermine', `${narrow.model}`);
  check('profondeurs sondées rapportées',
    near(narrow.depthMin, 3.4, 1e-9) && near(narrow.depthMax, 4.1, 1e-9));

  // Relevé à pied sur un haut-fond découvert : il compte dans la médiane — le plan d'eau
  // est une référence directement visible — mais il ne peut pas porter le verdict de
  // forme, puisque les deux modèles concurrents se rejoignent à profondeur nulle.
  const walked = {
    lon: 1.87, lat: 45.79, accuracy: 8, level: 647, levelSource: 'live',
    modelBedZ: 630, sounderDepth: -0.4, transducerDepth: 0.3,
    residual: 1.0, nearestSounding: 10, onTrack: true,
  };
  calibration.clear();
  wide.forEach((d) => calibration.add({ ...walked, sounderDepth: d - 0.3 }));
  calibration.add(walked);
  const mixed = calibration.stats();
  check('relevé à pied compté dans la médiane',
    mixed.count === wide.length + 1 && near(mixed.median, 1.0, 1e-9), `${mixed.count}`);
  check('relevé à pied écarté du verdict de forme',
    mixed.model === 'constant' && near(mixed.depthMin, 3, 1e-9), `${mixed.model} / ${mixed.depthMin}`);
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
  // Haut-fond découvert par l'étiage, relevé à pied : on saisit sa hauteur au-dessus de
  // l'eau en négatif. L'immersion du transducteur ne doit alors PAS être retranchée — il
  // n'y a rien dans l'eau — sinon le fond serait annoncé 30 cm trop bas, du côté dangereux,
  // et sur les seuls points où le modèle est déjà gravement faux.
  const shoal = makeProbe({
    position: { lon: 1.87, lat: 45.79, accuracy: 8 },
    level: 647.0, levelSource: 'live', sounderDepth: -0.4, transducerDepth: 0.3, modelBedZ: 630.0,
  });
  check('haut-fond émergé : immersion de la sonde ignorée',
    near(shoal.bedZ, 647.4, 1e-9), `${shoal.bedZ}`);
  check('haut-fond émergé : le modèle le noyait sous 17 m',
    near(shoal.modelDepth, 17.0, 1e-9));

  probes.update(entry.id, { sounderDepth: -0.4 });
  check('correction en haut-fond émergé : immersion neutralisée',
    near(probes.get(entry.id).bedZ, 647.4, 1e-9), `${probes.get(entry.id).bedZ}`);
  // Neutralisée au calcul et non à l'enregistrement : une saisie corrigée en sens inverse
  // doit retrouver l'immersion, sans quoi la correction serait un aller sans retour.
  probes.update(entry.id, { sounderDepth: 5.0 });
  check('retour en profondeur positive : immersion retrouvée',
    near(probes.get(entry.id).bedZ, 641.7, 1e-9), `${probes.get(entry.id).bedZ}`);

  probes.remove(entry.id);
  check('suppression d\'une sonde', probes.count === 0 && probes.get(entry.id) === null);
  probes.clear();

  // Position désignée à la main sur la carte, faute de GPS. La distinction doit survivre à
  // l'export : un point pointé au doigt ne vaut pas un point relevé sur place, et sans cette
  // marque plus rien ne permet d'arbitrer entre deux relevés qui se contredisent.
  const pinned = makeProbe({
    position: { lon: 1.87, lat: 45.79 },
    level: 647.0, levelSource: 'live', sounderDepth: 3.0, transducerDepth: 0.3,
    modelBedZ: 630.0, radius_m: 35, fixSource: 'map',
  });
  check('point désigné : provenance et rayon retenus',
    pinned.fixSource === 'map' && pinned.radius_m === 35 && pinned.accuracy === null);
  check('relevé au GPS : provenance par défaut', probe.fixSource === 'gps' && probe.radius_m === null);
  check('rayon d\'une sonde : le sien, ou le réglage à défaut',
    Probes.radiusOf(pinned, 20) === 35 && Probes.radiusOf(probe, 20) === 20);

  probes.add(pinned);
  const pinnedCsv = probes.toCsv().split('\n');
  check('export CSV : rayon et provenance en colonnes',
    pinnedCsv[0].endsWith('radius_m,fix') && pinnedCsv[1].endsWith(',35,map'), pinnedCsv[1]);
  probes.clear();

  // Suppression mémorisée. Sans cela, la fusion des relevés partagés — une union, donc non
  // destructive par construction — ramène à chaque ouverture la sonde qu'on vient
  // d'effacer : la suppression paraît sans effet. Voir `mergeById` dans src/main.js.
  localStorage.removeItem('relieflac.probes.deleted.v1');
  const buried = probes.add(probe);
  const kept = probes.add(pinned);
  probes.remove(buried.id);
  const graves = Probes.deletedIds();
  check('une suppression laisse une trace horodatée',
    graves.has(buried.id) && !graves.has(kept.id) && !Number.isNaN(Date.parse(graves.get(buried.id))),
    `${graves.size} trace(s)`);
  // Adopter une version partagée n'est pas supprimer : `replaceAll` ne doit rien enterrer,
  // sans quoi le démarrage enterrerait tout ce que l'appareil détient.
  probes.replaceAll([]);
  check('adopter une version partagée n\'enterre rien',
    Probes.deletedIds().size === graves.size, `${Probes.deletedIds().size}`);
  probes.clear();
  localStorage.removeItem('relieflac.probes.deleted.v1');

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

  // --- format de synchronisation (aller-retour) -------------------------------
  const sync = new CorrectionsSync({
    repo: 'x/y', path: 'data/corrections/vassiviere.json', waterbody: 'vassiviere', datum: 'NGF-IGN69',
  });
  const rec = { id: 'abc', at: '2026-08-11T10:00:00Z', lon: 1.87, lat: 45.79, bedZ: 644.7, depth_m: 2.3, cote_m: 647.0 };
  const file = sync.toFile([rec], { transducer_m: 0.3, radius_m: 20 });
  check('format : en-tête réutilisable', file.schema === 'relieflac.corrections/1' && file.waterbody === 'vassiviere');
  check('format : profondeur et cote conservées',
    file.points[0].depth_m === 2.3 && file.points[0].cote_m_ngf === 647.0 && file.points[0].z_fond_m_ngf === 644.7);
  const back = CorrectionsSync.fromFile(file);
  check('format : aller-retour fidèle',
    back.length === 1 && back[0].bedZ === 644.7 && back[0].cote_m === 647.0 && back[0].id === 'abc');
  check('format : point sans altitude ignoré',
    CorrectionsSync.fromFile({ points: [{ lon: 1, lat: 2 }] }).length === 0);

  // Le rayon suit le même sort que l'immersion : c'est l'étendue sur laquelle l'auteur a
  // jugé sa mesure représentative, pas un réglage d'affichage. Et la provenance de la
  // position voyage avec elle, sinon un point désigné à la main devient indiscernable.
  const spread = sync.toFile(
    [{ ...rec, radius_m: 45, position_source: 'map' }, { ...rec, id: 'def' }],
    { transducer_m: 0.3, radius_m: 20 },
  );
  check('format : rayon propre au relevé, réglage en repli',
    spread.points[0].radius_m === 45 && spread.points[1].radius_m === 20,
    `${spread.points[0].radius_m} / ${spread.points[1].radius_m}`);
  check('format : provenance de la position transportée',
    spread.points[0].position_source === 'map' && spread.points[1].position_source === 'gps');
  const spreadBack = CorrectionsSync.fromFile(spread);
  check('format : rayon et provenance relus tels quels',
    spreadBack[0].radius_m === 45 && spreadBack[0].position_source === 'map'
    && spreadBack[1].radius_m === 20 && spreadBack[1].position_source === 'gps');

  // L'immersion appartient à la mesure, pas au réglage du jour. Deux relevés pris avec
  // deux immersions différentes doivent garder chacun la sienne, à l'écriture comme à la
  // relecture — sans quoi `z_fond = cote − profondeur − immersion` n'est plus refaisable,
  // et toute correction ultérieure (échelle du sondeur) recalculerait de travers.
  const twoRigs = [
    { ...rec, id: 'r030', transducer_m: 0.30 },
    { ...rec, id: 'r025', transducer_m: 0.25 },
  ];
  const rigFile = sync.toFile(twoRigs, { transducer_m: 0.25, radius_m: 20 });
  check('immersion : propre à chaque relevé à l\'écriture',
    rigFile.points[0].transducer_m === 0.30 && rigFile.points[1].transducer_m === 0.25,
    `${rigFile.points[0].transducer_m} / ${rigFile.points[1].transducer_m}`);
  const rigBack = CorrectionsSync.fromFile(rigFile);
  check('immersion : relue depuis le fichier, pas du réglage courant',
    rigBack[0].transducer_m === 0.30 && rigBack[1].transducer_m === 0.25,
    `${rigBack[0].transducer_m} / ${rigBack[1].transducer_m}`);
  check('immersion : aller-retour stable sur un second passage',
    sync.toFile(rigBack, { transducer_m: 0.10, radius_m: 20 })
      .points.map((p) => p.transducer_m).join() === '0.3,0.25');
  // Relevé d'avant cette règle : rien à relire, le repli reprend la main.
  const legacy = CorrectionsSync.fromFile({
    points: [{ lon: 1.87, lat: 45.79, z_fond_m_ngf: 644.7, depth_m: 2.3, cote_m_ngf: 647.0 }],
  });
  check('immersion : absente du fichier → repli explicite', legacy[0].transducer_m === null);
  check('immersion : repli appliqué à l\'écriture suivante',
    sync.toFile(legacy, { transducer_m: 0.3, radius_m: 20 }).points[0].transducer_m === 0.3);

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

  // --- caméra de suivi ------------------------------------------------------------
  // Le rendu cartographique n'est pas vérifiable ici (voir l'en-tête), mais la décision
  // de caméra, elle, est du calcul pur — et c'est là que se sont logés les deux bugs de
  // suivi : le recentrage annulé par le cap en haut, puis la carte qui sursautait à chaque
  // point GPS. Les contrôles ci-dessous mesurent donc la *fluidité*, pas seulement
  // l'arrivée à destination.
  const LON = 1.87;
  const LAT = 45.8;
  const DEG = Math.PI / 180;
  const M_PER_DEG = 111320;
  const FRAME_MS = 1000 / 60;
  const gapTo = (a, b) => distanceMeters(a[0], a[1], b[0], b[1]);

  check('rattrapage indépendant de la cadence',
    near(catchUp(1 / 60, 0.22), 1 - (1 - catchUp(1 / 120, 0.22)) ** 2, 1e-12),
    'deux images à 120 Hz avancent autant qu\'une à 60 Hz');

  check('retour au nord par le plus court chemin',
    angleDelta(350, 0) === 10 && angleDelta(10, 0) === -10,
    `350°→0° : ${angleDelta(350, 0)}° · 10°→0° : ${angleDelta(10, 0)}°`);

  // --- estime entre deux points GPS ---
  {
    const fix = { lon: LON, lat: LAT, speed: 5, heading: 90, at: 0 };
    const after2s = deadReckon(fix, 2000);
    check('estime : 5 m/s vers l\'est pendant 2 s = 10 m à l\'est',
      near(gapTo([LON, LAT], after2s), 10, 0.05)
      && near(bearing(LON, LAT, after2s[0], after2s[1]), 90, 0.5),
      `${gapTo([LON, LAT], after2s).toFixed(2)} m au cap `
      + `${bearing(LON, LAT, after2s[0], after2s[1]).toFixed(1)}°`);

    // GPS perdu : sans plafond, le bateau continuerait tout seul jusqu'à l'autre rive.
    check('estime plafonnée quand le GPS se tait',
      near(gapTo([LON, LAT], deadReckon(fix, 60000)), 20, 0.05),
      `${gapTo([LON, LAT], deadReckon(fix, 60000)).toFixed(1)} m après une minute sans point`);

    // À l'arrêt le GPS ne donne pas de cap fiable : extrapoler ferait dériver le bateau.
    check('à l\'arrêt, aucune estime',
      gapTo([LON, LAT], deadReckon({ ...fix, speed: 0 }, 5000)) === 0);
  }

  // --- fluidité : le contrôle qui compte ---
  // Bateau à 10 km/h, point GPS chaque seconde avec du bruit, boussole à chaque image.
  // Le bateau affiché ne doit jamais bondir : c'est la définition du « ça sursaute ».
  {
    const speed = 10e3 / 3600;
    const course = 45;
    const truthAt = (ms) => {
      const s = ms / 1000;
      return [
        LON + (speed * Math.sin(course * DEG) * s) / (M_PER_DEG * Math.cos(LAT * DEG)),
        LAT + (speed * Math.cos(course * DEG) * s) / M_PER_DEG,
      ];
    };
    // Bruit GPS reproductible : ±2 m, l'ordre de grandeur d'un téléphone en vue du ciel.
    let seed = 7;
    const noise = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return ((seed / 2147483648) - 0.5) * 4;
    };

    const follow = new CameraFollow();
    follow.setFollow(true);
    follow.setTrackUp(true);
    const view = { center: null, bearing: 0 };
    let previous = null;
    let biggestStep = 0;
    let offCentre = 0;
    const nominal = speed / 60; // déplacement attendu par image : ~4,7 cm

    for (let frame = 0; frame < 60 * 20; frame += 1) {
      const now = frame * FRAME_MS;
      if (frame % 60 === 0) {
        const [lon, lat] = truthAt(now);
        follow.setFix({
          lon: lon + noise() / (M_PER_DEG * Math.cos(LAT * DEG)),
          lat: lat + noise() / M_PER_DEG,
          speed, heading: course, at: now,
        });
      }
      follow.setHeading(course);
      const out = follow.step(now, view);
      if (out.center) view.center = out.center;
      if (out.bearing !== null) view.bearing = out.bearing;

      if (frame > 120) { // après la convergence initiale
        if (previous) biggestStep = Math.max(biggestStep, gapTo(previous, out.position));
        offCentre = Math.max(offCentre, gapTo(view.center, out.position));
      }
      previous = out.position;
    }

    // Avant correction, une image sur soixante déplaçait le bateau de 2,8 m d'un coup —
    // soixante fois le pas nominal. C'est cela qu'on interdit ici.
    check('aucune image ne fait bondir le bateau',
      biggestStep < nominal * 3,
      `pas maximal ${(biggestStep * 100).toFixed(1)} cm par image, `
      + `pour ${(nominal * 100).toFixed(1)} cm attendus`);

    check('bateau verrouillé au centre de l\'écran',
      offCentre < 0.1, `écart maximal au centre ${(offCentre * 100).toFixed(1)} cm`);
  }

  // --- le cap ne doit pas faire vibrer la carte ---
  // La boussole tremble de ±1,5° : appliqué tel quel au cap de la carte, c'est le monde
  // entier qui frissonne à chaque image.
  {
    const follow = new CameraFollow();
    follow.setTrackUp(true);
    const view = { center: null, bearing: 90 };
    let low = 360;
    let high = 0;
    for (let frame = 0; frame < 600; frame += 1) {
      follow.setHeading(90 + (frame % 2 ? 1.5 : -1.5));
      const out = follow.step(frame * FRAME_MS, view);
      if (out.bearing !== null) view.bearing = out.bearing;
      if (frame > 120) { low = Math.min(low, view.bearing); high = Math.max(high, view.bearing); }
    }
    check('le tremblement de la boussole ne passe pas dans la carte',
      high - low < 0.3,
      `${(high - low).toFixed(3)}° d'amplitude en sortie, pour 3° en entrée`);
  }

  // --- verrous de caméra ---
  {
    const follow = new CameraFollow();
    follow.setFix({ lon: LON + 0.01, lat: LAT, speed: 0, heading: 90, at: 0 });
    follow.step(0, { center: [LON, LAT], bearing: 0 });
    check('suivi désactivé : la carte n\'est pas recentrée',
      follow.step(FRAME_MS, { center: [LON, LAT], bearing: 0 }).center === null);
  }

  // Au mouillage, la boucle doit s'arrêter. Une image de plus, c'est du GPU pour rien :
  // donc un téléphone qui chauffe, donc iOS qui baisse la luminosité de lui-même. On part
  // d'un écart à résorber — bateau qui vient de stopper, GPS qui se recale d'un mètre —
  // pour vérifier que la boucle converge puis se tait, au lieu de tourner indéfiniment.
  {
    const follow = new CameraFollow();
    follow.setFollow(true);
    follow.setTrackUp(true);
    follow.setFix({ lon: LON, lat: LAT, speed: 0, heading: 42, at: 0 });
    follow.setHeading(42);
    const view = { center: null, bearing: 0 };
    follow.step(0, view); // premier point : le bateau se pose ici
    follow.setFix({ lon: LON, lat: LAT + 1 / M_PER_DEG, speed: 0, heading: 42, at: 0 });

    let frame = 1;
    let out = null;
    for (; frame < 900; frame += 1) {
      out = follow.step(frame * FRAME_MS, view);
      if (out.center) view.center = out.center;
      if (out.bearing !== null) view.bearing = out.bearing;
      if (out.done) break;
    }
    check('au mouillage, la boucle s\'arrête',
      out.done === true && frame < 400 && gapTo(out.position, [LON, LAT + 1 / M_PER_DEG]) < 0.1,
      `recalage d'un mètre absorbé puis arrêt en ${frame} images`);
  }

  // Régression : « cap en haut » annulait le recentrage. Chaque mesure de boussole — une
  // par image — passait par setBearing → jumpTo → stop(), qui tuait l'easeTo de suivi avant
  // qu'il n'ait parcouru 1 % de sa course. La garantie est désormais structurelle : centre
  // et cap sortent du même pas, donc partent dans le même ordre de caméra.
  {
    const follow = new CameraFollow();
    follow.setFollow(true);
    follow.setTrackUp(true);
    follow.setFix({ lon: LON, lat: LAT, speed: 2.8, heading: 0, at: 0 });
    const view = { center: [LON - 0.002, LAT], bearing: 0 };
    let together = 0;
    for (let frame = 0; frame < 120; frame += 1) {
      follow.setHeading((frame * 3) % 360);
      const out = follow.step(frame * FRAME_MS, view);
      if (out.center && out.bearing !== null) together += 1;
      if (out.center) view.center = out.center;
      if (out.bearing !== null) view.bearing = out.bearing;
    }
    check('cap en haut n\'annule plus le recentrage',
      together > 100, `${together} images sur 120 portant centre et cap ensemble`);
  }

  // Le zoom des boutons passe par la même boucle que le centre et le cap : un easeTo
  // serait annulé dès l'image suivante par le jumpTo du suivi — le piège d'origine. Une
  // fois arrivé, la cible est relâchée, sinon le pincement suivant serait ramené de force.
  {
    const follow = new CameraFollow();
    follow.setZoom(16);
    const view = { center: null, bearing: 0, zoom: 18 };
    let frames = 0;
    let out = null;
    for (; frames < 600; frames += 1) {
      out = follow.step(frames * FRAME_MS, view);
      if (out.zoom !== null) view.zoom = out.zoom;
      if (out.done) break;
    }
    check('zoom des boutons : amorti, atteint, puis relâché',
      view.zoom === 16 && follow.zoomTarget === null && frames < 120,
      `zoom ${view.zoom} atteint en ${frames} images`);
  }

  // Relâcher « cap en haut » ramène au nord en douceur, et s'arrête exactement dessus.
  {
    const follow = new CameraFollow();
    follow.setTrackUp(true);
    follow.setTrackUp(false); // c'est le relâchement qui arme le retour au nord
    const view = { center: null, bearing: 120 };
    let frames = 0;
    for (; frames < 600; frames += 1) {
      const out = follow.step(frames * FRAME_MS, view);
      if (out.bearing !== null) view.bearing = out.bearing;
      if (out.done) break;
    }
    check('retour au nord amorti puis exact',
      view.bearing === 0 && frames < 200, `nord atteint en ${frames} images`);
  }

  // --- calage de la carte des fonds ------------------------------------------------
  // La couche des fonds sautait dès que la carte tournait, alors que les sondes — couche
  // MapLibre native, dessinée en coordonnées locales de tuile — restaient fixes. Cause :
  // nos sommets étaient en mercator absolu, et le vertex shader devait en soustraire deux
  // nombres de 1,4×10⁸ pour obtenir 8,6×10³. On reproduit ici l'arithmétique simple
  // précision du GPU avec Math.fround, sur la matrice réellement relevée dans
  // l'application au zoom de navigation.
  {
    const f = Math.fround;
    // Ordres de grandeur relevés dans l'application au zoom de navigation.
    const SCALE = 277414379;
    const W = 1545;
    const SCREEN_PX = 966;
    const px = 0.5051944;    // un coin de la grille, en mercator unitaire
    const py = 0.34170512;
    const anchorX = 0.5052611; // centre de la grille
    const anchorY = 0.34174233;

    /** Matrice de MapLibre pour un cap donné, bateau au centre de la vue. */
    const matrixFor = (deg) => {
      const r = deg * DEG;
      const m = new Float64Array(16);
      m[0] = SCALE * Math.cos(r); m[4] = -SCALE * Math.sin(r);
      m[1] = -SCALE * Math.sin(r); m[5] = -SCALE * Math.cos(r);
      m[10] = 1; m[15] = W;
      m[12] = -(m[0] * anchorX + m[4] * anchorY);
      m[13] = -(m[1] * anchorX + m[5] * anchorY);
      return m;
    };

    // Le tremblement n'est pas l'erreur à une image donnée, mais sa *variation* d'une
    // image à l'autre : c'est elle que l'œil voit quand la carte tourne. On balaie donc
    // un tour complet, cap par cap, et on mesure l'amplitude de l'erreur de position.
    const out = new Float32Array(16);
    let oldLow = Infinity; let oldHigh = -Infinity;
    let newLow = Infinity; let newHigh = -Infinity;
    for (let deg = 0; deg < 360; deg += 0.25) {
      const m = matrixFor(deg);
      const toPixels = (clip) => (clip / W) * (SCREEN_PX / 2);
      const ref = m[0] * px + m[4] * py + m[12];

      // Ancien trajet : sommet en mercator absolu, tout arrondi en simple précision.
      const before = toPixels(
        f(f(f(m[0]) * f(px)) + f(f(m[4]) * f(py))) + f(m[12]) - ref,
      );
      // Nouveau trajet : sommet relatif à l'ancre, translation recomposée en double.
      anchoredMatrix(m, anchorX, anchorY, out);
      const after = toPixels(
        f(f(out[0] * f(px - anchorX)) + f(out[4] * f(py - anchorY))) + out[12] - ref,
      );

      oldLow = Math.min(oldLow, before); oldHigh = Math.max(oldHigh, before);
      newLow = Math.min(newLow, after); newHigh = Math.max(newHigh, after);
    }
    const avant = oldHigh - oldLow;
    const apres = newHigh - newLow;

    check('carte des fonds : plus de tremblement en rotation',
      apres < 0.05 && apres < avant / 20,
      `amplitude sur un tour complet : ${avant.toFixed(2)} px avant, ${apres.toFixed(3)} px après`);

    // Les trois premières colonnes ne doivent pas bouger : une translation ne les touche
    // pas, et les altérer déformerait la carte au lieu de la déplacer.
    anchoredMatrix(matrixFor(37), anchorX, anchorY, out);
    const ref37 = matrixFor(37);
    check('ancrage : seule la translation est modifiée',
      [0, 1, 4, 5, 10].every((i) => out[i] === f(ref37[i])));
  }

  // --- shader de profondeur -----------------------------------------------------
  await runShaderChecks(base, check);

  return results;
}
