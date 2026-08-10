// Assemblage de l'application : chargement des données, carte, réglages, étalonnage.

import { BedGrid, correctedAltitude } from './bed.js';
import { Calibration, makeRecord, ON_TRACK_RADIUS_M } from './calibration.js';
import { DepthLayer } from './depth-layer.js';
import { formatSpeed, Geolocator } from './geo.js';
import { formatAge, Level, LevelSource } from './level.js';
import { LakeMap } from './map.js';
import { bandLimits, buildLut, depthColor, hexToVec4, legendEntries } from './palette.js';
import { Soundings } from './soundings.js';
import { defaultsFrom, Settings } from './settings.js';

const $ = (id) => document.getElementById(id);
const ROUTES = { '#/': 'vue-carte', '#/parametres': 'vue-parametres', '#/etalonnage': 'vue-etalonnage', '#/a-propos': 'vue-apropos' };

const app = {
  palette: null, model: null, bed: null, soundings: null,
  settings: null, level: null, geo: null, calibration: null,
  lakeMap: null, depthLayer: null,
  trackUp: false, alarmActive: false, lastAlarmAt: 0,
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
    wireMap();
    route();

    refreshLevelUi();
    refreshDepthStyle();
    refreshSettingsUi();
    refreshCalibrationUi();

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

/** Altitude du fond corrigée du décalage d'étalonnage, en m NGF. */
function bedAltitude(lon, lat) {
  return correctedAltitude(
    app.bed.rawAltitudeAt(lon, lat),
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
    $('prof-label').textContent = depth > 0 ? 'sous le bateau' : 'fond émergé';
    $('quille-value').textContent = depth > 0 ? `${(depth - draft).toFixed(1)} m` : '—';
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
  $('set-draft').value = s.get('draft_m');
  $('set-margin').value = s.get('margin_m');
  $('set-alarm').checked = s.get('alarmEnabled');
  $('set-alarm-depth').value = s.get('alarmDepth_m');
  $('set-speed-unit').value = s.get('speedUnit');
  $('set-offset').value = s.get('calibrationOffset_m');
  $('set-manual-level').value = s.get('manualLevel') ?? '';

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
  const modelBedZ = app.bed.rawAltitudeAt(position.lon, position.lat);
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
