// Assemblage de l'application : chargement des données, carte, réglages, étalonnage.

import { BedGrid, correctedAltitude } from './bed.js';
import { Calibration, makeRecord, ON_TRACK_RADIUS_M } from './calibration.js';
import { DepthLayer } from './depth-layer.js';
import { formatSpeed, Geolocator } from './geo.js';
import { formatAge, Level, LevelSource } from './level.js';
import { LakeMap } from './map.js';
import { bandColors, bandLimits, buildLut, depthColor, hexToVec4, legendEntries } from './palette.js';
import { Probes, makeProbe } from './probes.js';
import { Soundings } from './soundings.js';
import { defaultsFrom, Settings } from './settings.js';

const $ = (id) => document.getElementById(id);
const ROUTES = { '#/': 'vue-carte', '#/parametres': 'vue-parametres', '#/etalonnage': 'vue-etalonnage', '#/a-propos': 'vue-apropos' };

const app = {
  palette: null, model: null, bed: null, soundings: null,
  settings: null, level: null, geo: null, calibration: null, probes: null,
  lakeMap: null, depthLayer: null,
  trackUp: false, alarmActive: false, lastAlarmAt: 0,
  editingProbeId: null,
};

// ---------------------------------------------------------------- démarrage

async function boot() {
  try {
    const [palette, model] = await Promise.all([
      fetchJson('config/palette.json'),
      fetchJson('config/model.json'),
    ]);
    app.palette = palette;
    app.model = model;
    app.settings = new Settings(defaultsFrom(palette, model));
    app.calibration = new Calibration();
    app.probes = new Probes();
    app.level = new Level('.');
    app.geo = new Geolocator();

    app.bed = await BedGrid.load('.');
    await app.level.refresh();

    // MapLibre s'initialise depuis sa boucle de rendu, suspendue tant que la page est
    // masquée : lancée dans un onglet en arrière-plan, la carte ne se construirait
    // jamais et l'écran de chargement resterait figé sans explication.
    await whenVisible('Application en arrière-plan — la carte se construira au retour.');

    app.lakeMap = new LakeMap('map', app.bed);
    await app.lakeMap.ready;

    app.depthLayer = new DepthLayer(app.bed, styleFromSettings());
    app.lakeMap.addDepthLayer(app.depthLayer);
    app.lakeMap.setBasemap(app.settings.get('basemap'));

    wireSettings();
    wireCalibration();
    wireProbes();
    wireMap();
    route();

    refreshLevelUi();
    refreshDepthStyle();
    refreshSettingsUi();
    refreshCalibrationUi();
    refreshProbesUi();
    refreshProbesOnMap();

    app.geo.addEventListener('position', onPosition);
    app.geo.addEventListener('status', onGeoStatus);
    app.geo.start();

    // La cote bouge de quelques centimètres par heure : un rafraîchissement toutes les
    // dix minutes suffit largement, et le fichier est servi depuis le cache si inchangé.
    setInterval(() => app.level.refresh().then(refreshLevelUi), 10 * 60e3);

    loadSoundingsLazily();
    $('chargement').hidden = true;
    $('apropos-version').textContent = `levé ${app.bed.meta.sources?.ofb2009?.label ? '2009' : '—'} · grille ${app.bed.width}×${app.bed.height}`;
  } catch (err) {
    $('chargement').innerHTML = `<p><strong>Chargement impossible</strong><br>${err.message}</p>`;
    console.error(err);
  }
}

const fetchJson = (url) => fetch(url, { cache: 'no-cache' }).then((r) => {
  if (!r.ok) throw new Error(`${url} : HTTP ${r.status}`);
  return r.json();
});

/** Attend que la page soit visible ; affiche pourquoi si l'attente dure. */
function whenVisible(message) {
  if (!document.hidden) return Promise.resolve();
  $('chargement').querySelector('p').textContent = message;
  return new Promise((resolve) => {
    document.addEventListener('visibilitychange', function onChange() {
      if (document.hidden) return;
      document.removeEventListener('visibilitychange', onChange);
      resolve();
    });
  });
}

// Les 8 118 sondes ne sont utiles qu'à l'affichage optionnel et à l'étalonnage :
// on ne bloque pas l'ouverture de la carte pour elles.
async function loadSoundingsLazily() {
  try {
    app.soundings = await Soundings.load('.');
    app.lakeMap.setSoundings(app.soundings.toGeoJSON(), app.settings.get('showSoundings'));
  } catch (err) {
    console.warn('sondes 2009 indisponibles', err);
  }
}

// ------------------------------------------------------------- profondeurs

function currentLevel() {
  const manual = app.settings.get('manualLevel');
  app.level.setManual(manual);
  return app.level.current();
}

/**
 * Altitude du fond corrigée du décalage d'étalonnage, en m NGF.
 *
 * Interpolation bilinéaire, comme le shader : la profondeur annoncée sous le bateau
 * doit être exactement celle que montre la couleur au même endroit.
 */
function bedAltitude(lon, lat) {
  return correctedAltitude(
    app.bed.altitudeAt(lon, lat),
    app.settings.get('calibrationOffset_m'),
    app.settings.get('waterPlane_m_ngf'),
  );
}

function depthAt(lon, lat) {
  const level = currentLevel().value;
  const z = bedAltitude(lon, lat);
  return Number.isFinite(level) && Number.isFinite(z) ? level - z : NaN;
}

function styleFromSettings() {
  const palette = app.palette;
  const presetName = app.settings.get('preset');
  const preset = palette.presets[presetName];
  const safety = palette.safety_contour;

  return {
    lut: buildLut(palette, presetName),
    bands: bandLimits(preset, palette.lut_max_depth_m),
    bandColors: bandColors(preset),
    lutMax: palette.lut_max_depth_m,
    level: currentLevel().value ?? app.model.lake.normal_level_m_ngf,
    offset: app.settings.get('calibrationOffset_m'),
    waterPlane: app.settings.get('waterPlane_m_ngf'),
    safe: app.settings.safetyDepth,
    opacity: app.settings.get('opacity'),
    emerged: hexToVec4(preset.emerged_color),
    outline: hexToVec4(preset.band_outline_color ?? '#182028'),
    safetyColor: hexToVec4(safety.color),
    showOutlines: app.settings.get('showOutlines'),
    showSafety: app.settings.get('showSafety'),
    showVoids: app.settings.get('showVoids'),
    voidRadius: app.settings.get('voidRadius_m'),
  };
}

function refreshDepthStyle() {
  app.depthLayer?.setStyle(styleFromSettings());
}

// ---------------------------------------------------------------- position

function onPosition(event) {
  const position = event.detail;
  app.lakeMap.setPosition(position, {
    follow: app.settings.get('followBoat'),
    trackUp: app.trackUp,
  });

  const depth = depthAt(position.lon, position.lat);
  const draft = app.settings.get('draft_m');
  const presetName = app.settings.get('preset');

  const value = $('prof-value');
  if (Number.isFinite(depth)) {
    value.textContent = depth > 0 ? depth.toFixed(1) : '0';
    value.style.color = depthColor(app.palette, presetName, depth);
    $('quille-value').textContent = depth > 0 ? `${(depth - draft).toFixed(1)} m` : '—';

    // Dire d'où vient le chiffre. Sur près de 38 % du lac il est interpolé entre des
    // traces distantes de plus de 60 m, et un haut-fond peut s'y cacher entièrement.
    const distance = app.bed.soundingDistanceAt(position.lon, position.lat);
    const unsurveyed = Number.isFinite(distance) && distance > app.settings.get('voidRadius_m');
    $('prof-label').textContent = depth <= 0
      ? 'fond émergé'
      : unsurveyed
        ? `interpolé — sonde à ${Math.round(distance)} m`
        : 'sous le bateau';
    $('prof-label').classList.toggle('is-warning', unsurveyed && depth > 0);
  } else {
    value.textContent = '—';
    value.style.color = '';
    $('prof-label').textContent = 'hors emprise du lac';
    $('quille-value').textContent = '—';
  }

  $('vitesse-value').textContent = formatSpeed(position.speed, app.settings.get('speedUnit'));
  $('cap-value').textContent = Number.isFinite(position.heading)
    ? `${Math.round(position.heading)}°` : '—';

  updateAlarm(depth);
  if (location.hash === '#/etalonnage') refreshCalibrationContext();
}

function onGeoStatus(event) {
  const { status, message } = event.detail;
  if (message) toast(message, status === 'denied' ? 8000 : 3000);
  if (status !== 'active') $('prof-label').textContent = 'position en attente';
}

function updateAlarm(depth) {
  const enabled = app.settings.get('alarmEnabled');
  const threshold = app.settings.get('alarmDepth_m');
  const triggered = enabled && Number.isFinite(depth) && depth <= threshold;

  $('alarme').hidden = !triggered;
  if (triggered) {
    $('alarme-detail').textContent = depth > 0
      ? `${depth.toFixed(1)} m sous le bateau`
      : 'fond émergé';
    // Une vibration toutes les cinq secondes : assez pour alerter, pas au point
    // qu'on cherche à couper l'alarme.
    if (Date.now() - app.lastAlarmAt > 5000) {
      app.lastAlarmAt = Date.now();
      navigator.vibrate?.([200, 100, 200]);
    }
  }
  app.alarmActive = triggered;
}

// -------------------------------------------------------------------- cote

function refreshLevelUi() {
  const state = currentLevel();
  const chip = $('btn-cote');
  const value = $('cote-value');
  const meta = $('cote-meta');

  chip.classList.remove('chip--forbidden', 'chip--delicate', 'chip--stale');

  if (state.value == null) {
    value.textContent = '—';
    meta.textContent = state.label;
    chip.classList.add('chip--stale');
  } else {
    value.textContent = state.value.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    meta.textContent = state.source === LevelSource.MANUAL
      ? 'saisie manuelle'
      : `${state.condition.label} · ${formatAge(state.ageMs)}`;
    if (state.condition.key === 'forbidden') chip.classList.add('chip--forbidden');
    else if (state.condition.key === 'delicate') chip.classList.add('chip--delicate');
    if (state.source === LevelSource.STALE) chip.classList.add('chip--stale');
  }

  refreshDepthStyle();
  refreshProbesOnMap();
}

// --------------------------------------------------------------- réglages

function wireSettings() {
  const s = app.settings;

  const select = $('set-preset');
  Object.entries(app.palette.presets).forEach(([key, preset]) => {
    select.append(new Option(preset.label, key));
  });

  bind('set-preset', 'change', (el) => s.set('preset', el.value));
  bind('set-opacity', 'input', (el) => s.set('opacity', Number(el.value) / 100));
  bind('set-outlines', 'change', (el) => s.set('showOutlines', el.checked));
  bind('set-safety', 'change', (el) => s.set('showSafety', el.checked));
  bind('set-soundings', 'change', (el) => s.set('showSoundings', el.checked));
  bind('set-voids', 'change', (el) => s.set('showVoids', el.checked));
  bind('set-draft', 'change', (el) => s.set('draft_m', clampNumber(el, 0, 3)));
  bind('set-margin', 'change', (el) => s.set('margin_m', clampNumber(el, 0, 5)));
  bind('set-alarm', 'change', (el) => s.set('alarmEnabled', el.checked));
  bind('set-alarm-depth', 'change', (el) => s.set('alarmDepth_m', clampNumber(el, 0.2, 10)));
  bind('set-speed-unit', 'change', (el) => s.set('speedUnit', el.value));
  bind('set-offset', 'change', (el) => s.set('calibrationOffset_m', clampNumber(el, -5, 5)));
  bind('set-manual-level', 'change', (el) => {
    const value = Number(el.value);
    s.set('manualLevel', el.value === '' || !Number.isFinite(value) ? null : value);
  });

  $('btn-clear-manual').addEventListener('click', () => {
    s.set('manualLevel', null);
    $('set-manual-level').value = '';
  });
  $('btn-refresh-level').addEventListener('click', async () => {
    await app.level.refresh();
    refreshLevelUi();
    toast('Cote rafraîchie');
  });

  $('btn-export').addEventListener('click', () => download('relieflac-profil.json', s.export(), 'application/json'));
  $('btn-import').addEventListener('click', () => $('file-import').click());
  $('file-import').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      s.import(await file.text());
      toast('Profil importé');
    } catch (err) {
      toast(`Import impossible : ${err.message}`, 5000);
    }
    event.target.value = '';
  });
  $('btn-reset').addEventListener('click', () => {
    if (confirm('Revenir à tous les réglages par défaut ?')) {
      s.reset();
      toast('Réglages réinitialisés');
    }
  });

  s.addEventListener('change', () => {
    refreshSettingsUi();
    refreshDepthStyle();
    refreshProbesOnMap();
    app.lakeMap.setBasemap(s.get('basemap'));
    app.lakeMap.setSoundings(null, s.get('showSoundings'));
  });
}

function bind(id, event, handler) {
  const element = $(id);
  element.addEventListener(event, () => handler(element));
}

function clampNumber(element, min, max) {
  const value = Number(element.value);
  if (!Number.isFinite(value)) return Number(element.defaultValue) || min;
  return Math.min(Math.max(value, min), max);
}

function refreshSettingsUi() {
  const s = app.settings;
  $('set-preset').value = s.get('preset');
  $('set-opacity').value = Math.round(s.get('opacity') * 100);
  $('out-opacity').textContent = `${Math.round(s.get('opacity') * 100)} %`;
  $('set-outlines').checked = s.get('showOutlines');
  $('set-safety').checked = s.get('showSafety');
  $('set-soundings').checked = s.get('showSoundings');
  $('set-voids').checked = s.get('showVoids');
  $('set-draft').value = s.get('draft_m');
  $('set-margin').value = s.get('margin_m');
  $('set-alarm').checked = s.get('alarmEnabled');
  $('set-alarm-depth').value = s.get('alarmDepth_m');
  $('set-speed-unit').value = s.get('speedUnit');
  $('set-offset').value = s.get('calibrationOffset_m');
  $('set-manual-level').value = s.get('manualLevel') ?? '';
  $('set-transducer').value = s.get('transducer_m');
  $('set-probes').checked = s.get('showProbes');
  refreshProbesUi();

  $('hint-safety').textContent = `Contour de sécurité tracé à ${s.safetyDepth.toFixed(2)} m `
    + `(tirant d'eau ${s.get('draft_m')} + marge ${s.get('margin_m')}).`;

  const z = s.get('z2009_m_ngf') + s.get('calibrationOffset_m');
  $('hint-z2009').textContent = `Cote du levé retenue : ${z.toFixed(2)} m NGF `
    + `(valeur de départ ${s.get('z2009_m_ngf')}, non confirmée). `
    + `Une fois la valeur stabilisée, la reporter dans config/model.json et reconstruire la grille.`;

  const state = currentLevel();
  $('hint-level').textContent = state.value == null
    ? `Cote indisponible : ${state.label}.`
    : `Cote utilisée : ${state.value.toFixed(2)} m NGF (${state.label}${state.ageMs ? `, ${formatAge(state.ageMs)}` : ''}).`;

  const list = $('legende');
  list.replaceChildren(...legendEntries(app.palette, s.get('preset')).map((entry) => {
    const item = document.createElement('li');
    const swatch = document.createElement('i');
    swatch.style.background = entry.color;
    item.append(swatch, entry.label);
    return item;
  }));
}

// ------------------------------------------------------------- étalonnage

function wireCalibration() {
  $('btn-releve').addEventListener('click', recordCalibration);
  $('btn-apply-offset').addEventListener('click', () => {
    const stats = app.calibration.stats();
    if (!stats) return;
    app.settings.set('calibrationOffset_m', round2(stats.median));
    toast(`Correction de ${round2(stats.median) > 0 ? '+' : ''}${round2(stats.median)} m appliquée`);
  });
  $('btn-cal-csv').addEventListener('click', () => download('etalonnage.csv', app.calibration.toCsv(), 'text/csv'));
  $('btn-cal-json').addEventListener('click', () => download('etalonnage.json', app.calibration.toJson(), 'application/json'));
  $('btn-cal-clear').addEventListener('click', () => {
    if (confirm('Effacer tous les relevés d\'étalonnage ?')) app.calibration.clear();
  });
  app.calibration.addEventListener('change', refreshCalibrationUi);
}

function recordCalibration() {
  const position = app.geo.position;
  if (!position) { toast('Position GPS indisponible'); return; }

  const sounderDepth = Number($('cal-depth').value);
  if (!Number.isFinite(sounderDepth) || sounderDepth <= 0) {
    toast('Saisissez la profondeur lue au sondeur'); return;
  }

  const state = currentLevel();
  if (state.value == null) { toast('Cote du lac inconnue'); return; }

  // Altitude brute : le décalage cherché est précisément celui qu'on appliquera ensuite.
  const modelBedZ = app.bed.altitudeAt(position.lon, position.lat);
  if (!Number.isFinite(modelBedZ)) { toast('Hors emprise du modèle'); return; }

  app.calibration.add(makeRecord({
    position,
    level: state.value,
    levelSource: state.source,
    modelBedZ,
    sounderDepth,
    transducerDepth: Number($('cal-transducer').value) || 0,
    nearestSounding: app.soundings?.distanceToNearest(position.lon, position.lat) ?? Infinity,
  }));

  $('cal-depth').value = '';
  toast('Relevé enregistré');
}

function refreshCalibrationContext() {
  const position = app.geo.position;
  const element = $('cal-context');
  if (!position) { element.textContent = 'Position en attente…'; return; }

  const depth = depthAt(position.lon, position.lat);
  const nearest = app.soundings?.distanceToNearest(position.lon, position.lat) ?? Infinity;
  const onTrack = nearest <= ON_TRACK_RADIUS_M;

  element.textContent = `Modèle : ${Number.isFinite(depth) ? `${depth.toFixed(1)} m` : '—'} · `
    + `GPS ±${position.accuracy ? Math.round(position.accuracy) : '?'} m · `
    + (Number.isFinite(nearest)
      ? `sonde 2009 la plus proche à ${Math.round(nearest)} m ${onTrack ? '— sur la trace' : '— entre deux traces, relevé peu fiable'}`
      : 'aucune sonde 2009 à proximité — relevé peu fiable');
}

function refreshCalibrationUi() {
  const stats = app.calibration.stats();
  const container = $('cal-stats');
  const apply = $('btn-apply-offset');

  if (!stats) {
    container.innerHTML = '<p class="hint">Aucun relevé.</p>';
    apply.disabled = true;
  } else {
    const verdict = stats.usable
      ? ['verdict--ok', `Écarts groupés (interquartile ${stats.iqr.toFixed(2)} m) : c'est bien un décalage de référence.`]
      : stats.count < 5
        ? ['verdict--wait', `Encore ${5 - stats.count} relevé(s) pour conclure.`]
        : ['verdict--spread', `Écarts dispersés (interquartile ${stats.iqr.toFixed(2)} m) : le problème est l'interpolation, pas la référence. Aucune constante ne le corrigera.`];

    container.innerHTML = `
      <div class="big-number">${stats.median > 0 ? '+' : ''}${stats.median.toFixed(2)} m</div>
      <p class="hint">Médiane des écarts sur ${stats.count} relevé(s)
        ${stats.trustedCount ? `dont ${stats.trustedCount} sur trace` : ''} ·
        étendue ${stats.min.toFixed(2)} à ${stats.max.toFixed(2)} m</p>
      <p class="verdict ${verdict[0]}">${verdict[1]}</p>`;
    apply.disabled = !stats.usable;
  }

  const list = $('cal-records');
  list.replaceChildren(...app.calibration.records.slice().reverse().map((r) => {
    const item = document.createElement('li');
    const when = new Date(r.at).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
    item.innerHTML = `<span class="residual">${r.residual > 0 ? '+' : ''}${r.residual.toFixed(2)} m</span>
      <span class="tag ${r.onTrack ? 'tag--on' : 'tag--off'}">${r.onTrack ? 'sur trace' : 'hors trace'}</span>
      <span class="hint">${r.sounderDepth.toFixed(1)} m au sondeur · ${when}</span>`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.title = 'Supprimer ce relevé';
    remove.addEventListener('click', () => app.calibration.remove(r.id));
    item.append(remove);
    return item;
  }));

  app.lakeMap?.setMarkers(app.calibration.records);
}

// ---------------------------------------------------------------- mes sondes

function wireProbes() {
  $('capture').addEventListener('submit', (event) => {
    event.preventDefault();
    if (app.editingProbeId) saveProbeEdit(); else recordProbe();
  });
  $('btn-cap-delete').addEventListener('click', deleteEditedProbe);
  $('btn-cap-cancel').addEventListener('click', endProbeEdit);
  app.lakeMap.addEventListener('probeselect', (event) => beginProbeEdit(event.detail));

  bind('set-transducer', 'change', (el) => app.settings.set('transducer_m', clampNumber(el, 0, 2)));
  bind('set-probes', 'change', (el) => app.settings.set('showProbes', el.checked));

  $('btn-probe-csv').addEventListener('click', () => download('relieflac-sondes.csv', app.probes.toCsv(), 'text/csv'));
  $('btn-probe-geojson').addEventListener('click', () => download('relieflac-sondes.geojson', app.probes.toGeoJson(), 'application/geo+json'));
  $('btn-probe-clear').addEventListener('click', () => {
    if (app.probes.count && confirm('Effacer toutes les sondes enregistrées ?')) {
      endProbeEdit();
      app.probes.clear();
    }
  });

  app.probes.addEventListener('change', () => {
    refreshProbesUi();
    refreshProbesOnMap();
  });
}

// -------------------------------------------------------- correction d'une sonde

function beginProbeEdit(id) {
  const record = app.probes.get(id);
  if (!record) return;

  app.editingProbeId = id;
  location.hash = '#/'; // ramène sur la carte si l'on éditait depuis la liste des réglages

  const input = $('cap-input');
  input.value = record.sounderDepth;
  $('btn-capture').textContent = 'Enregistrer';
  $('btn-cap-delete').hidden = false;
  $('btn-cap-cancel').hidden = false;
  $('capture').classList.add('is-editing');

  refreshProbesOnMap();
  input.focus();
  input.select?.();
  toast('Corrigez la profondeur, ou supprimez le point');
}

function endProbeEdit() {
  app.editingProbeId = null;
  const input = $('cap-input');
  input.value = '';
  input.blur();
  $('btn-capture').textContent = 'Relever';
  $('btn-cap-delete').hidden = true;
  $('btn-cap-cancel').hidden = true;
  $('capture').classList.remove('is-editing');
  refreshProbesOnMap();
}

function saveProbeEdit() {
  const depth = Number($('cap-input').value);
  if (!Number.isFinite(depth) || depth <= 0) { toast('Saisissez une profondeur valide'); return; }
  app.probes.update(app.editingProbeId, { sounderDepth: depth });
  endProbeEdit();
  toast(`Sonde corrigée : ${depth.toFixed(1)} m`);
}

function deleteEditedProbe() {
  if (!app.editingProbeId) return;
  if (!confirm('Supprimer cette sonde ?')) return;
  const id = app.editingProbeId;
  endProbeEdit();
  app.probes.remove(id);
  toast('Sonde supprimée');
}

function recordProbe() {
  const position = app.geo.position;
  if (!position) { toast('Position GPS indisponible'); return; }

  const input = $('cap-input');
  const depth = Number(input.value);
  if (!Number.isFinite(depth) || depth <= 0) { toast('Saisissez la profondeur lue au sondeur'); return; }

  const state = currentLevel();
  if (state.value == null) { toast('Cote du lac inconnue — impossible de caler la sonde'); return; }

  app.probes.add(makeProbe({
    position,
    level: state.value,
    levelSource: state.source,
    sounderDepth: depth,
    transducerDepth: app.settings.get('transducer_m'),
    modelBedZ: app.bed.altitudeAt(position.lon, position.lat),
  }));

  input.value = '';
  input.blur(); // referme le clavier tactile pour dégager la carte
  toast(`Sonde ${depth.toFixed(1)} m enregistrée · ${app.probes.count} au total`);
}

/** Recalcule la profondeur affichée depuis la cote courante, comme le reste de la carte. */
function refreshProbesOnMap() {
  if (!app.probes || !app.lakeMap) return;
  if (!app.settings.get('showProbes')) { app.lakeMap.setProbes([]); return; }

  const level = currentLevel().value;
  const points = app.probes.records.map((r) => {
    const depth = Number.isFinite(level) && Number.isFinite(r.bedZ) ? level - r.bedZ : r.sounderDepth;
    return {
      id: r.id,
      lon: r.lon,
      lat: r.lat,
      label: depth > 0 ? depth.toFixed(1) : '0',
      editing: r.id === app.editingProbeId,
    };
  });
  app.lakeMap.setProbes(points);
}

function refreshProbesUi() {
  const probes = app.probes;
  const count = probes?.count ?? 0;

  $('probe-count').textContent = count
    ? `${count} sonde${count > 1 ? 's' : ''} enregistrée${count > 1 ? 's' : ''}.`
    : 'Aucune sonde enregistrée.';
  $('btn-probe-csv').disabled = !count;
  $('btn-probe-geojson').disabled = !count;
  $('btn-probe-clear').disabled = !count;

  const list = $('probe-records');
  list.replaceChildren(...(probes?.records ?? []).slice().reverse().map((r) => {
    const item = document.createElement('li');
    const when = new Date(r.at).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
    const modelText = Number.isFinite(r.modelDepth) && r.modelDepth > 0
      ? ` · modèle ${r.modelDepth.toFixed(1)} m` : '';
    item.innerHTML = `<span class="residual">${r.sounderDepth.toFixed(1)} m</span>
      <span class="hint">${when}${modelText}</span>`;

    const edit = document.createElement('button');
    edit.type = 'button';
    edit.textContent = '✎';
    edit.title = 'Corriger cette sonde sur la carte';
    edit.addEventListener('click', () => beginProbeEdit(r.id));

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.title = 'Supprimer cette sonde';
    remove.addEventListener('click', () => {
      if (app.editingProbeId === r.id) endProbeEdit();
      app.probes.remove(r.id);
    });

    item.append(edit, remove);
    return item;
  }));
}

// -------------------------------------------------------------------- carte

function wireMap() {
  $('btn-fond').addEventListener('click', () => {
    const next = app.settings.get('basemap') === 'plan' ? 'ortho' : 'plan';
    app.settings.set('basemap', next);
    toast(next === 'plan' ? 'Plan IGN' : 'Photo aérienne');
  });

  $('btn-suivi').addEventListener('click', () => {
    const follow = !app.settings.get('followBoat');
    app.settings.set('followBoat', follow);
    $('btn-suivi').classList.toggle('is-on', follow);
    if (follow && app.geo.position) {
      app.lakeMap.setPosition(app.geo.position, { follow: true, trackUp: app.trackUp });
    }
  });

  $('btn-cap').addEventListener('click', () => {
    app.trackUp = !app.trackUp;
    $('btn-cap').classList.toggle('is-on', app.trackUp);
    $('btn-cap').textContent = app.trackUp ? '⇧' : '↑';
    if (!app.trackUp) app.lakeMap.resetNorth();
  });

  // Faire glisser la carte coupe le suivi : sinon l'écran ramène le bateau au centre
  // à chaque relevé GPS et il devient impossible de regarder devant soi.
  app.lakeMap.addEventListener('userpan', () => {
    if (app.settings.get('followBoat')) {
      app.settings.set('followBoat', false);
      $('btn-suivi').classList.remove('is-on');
    }
  });

  // Sonde ponctuelle : profondeur au point touché.
  app.lakeMap.addEventListener('probe', (event) => {
    const { lng, lat } = event.detail;
    const depth = depthAt(lng, lat);
    toast(Number.isFinite(depth)
      ? (depth > 0 ? `${depth.toFixed(1)} m à cet endroit` : 'Fond émergé à cet endroit')
      : 'Hors emprise du modèle');
  });

  $('btn-cote').addEventListener('click', () => { location.hash = '#/parametres'; });
  $('btn-suivi').classList.toggle('is-on', app.settings.get('followBoat'));
}

// ------------------------------------------------------------------ routeur

function route() {
  const target = ROUTES[location.hash] ?? 'vue-carte';
  Object.values(ROUTES).forEach((id) => {
    $(id).classList.toggle('is-active', id === target);
  });
  if (target === 'vue-carte') app.lakeMap?.map.resize();
  if (target === 'vue-parametres') refreshSettingsUi();
  if (target === 'vue-etalonnage') { refreshCalibrationUi(); refreshCalibrationContext(); }
}

window.addEventListener('hashchange', route);

// ------------------------------------------------------------------- divers

let toastTimer = null;
function toast(message, duration = 2500) {
  const element = $('toast');
  element.textContent = message;
  element.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { element.hidden = true; }, duration);
}

function download(filename, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = Object.assign(document.createElement('a'), { href: url, download: filename });
  link.click();
  URL.revokeObjectURL(url);
}

const round2 = (value) => Math.round(value * 100) / 100;

// Garder l'écran allumé tant que la carte est affichée : sur l'eau, se rallumer et
// rechercher le GPS toutes les trente secondes est inutilisable.
async function keepAwake() {
  if (!('wakeLock' in navigator)) return;
  try {
    await navigator.wakeLock.request('screen');
  } catch { /* refusé ou onglet en arrière-plan : sans conséquence */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') keepAwake();
});

boot().then(keepAwake);
