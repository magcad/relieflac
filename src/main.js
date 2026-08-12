// Assemblage de l'application : chargement des données, carte, réglages, étalonnage.

import { BedGrid, correctedAltitude } from './bed.js';
import { Calibration, makeRecord, ON_TRACK_RADIUS_M } from './calibration.js';
import { DepthLayer } from './depth-layer.js';
import { formatSpeed, Geolocator } from './geo.js';
import { formatAge, Level, LevelSource } from './level.js';
import { Compass } from './compass.js';
import { LakeMap } from './map.js';
import { applyPaletteOverride, bandColors, bandLimits, buildLut, depthColor, hexToVec4, legendEntries } from './palette.js';
import { Probes, makeProbe } from './probes.js';
import { SimPoints } from './sim.js';
import { CorrectionsSync, getToken, setToken } from './sync.js';
import { Soundings } from './soundings.js';
import { defaultsFrom, Settings } from './settings.js';
import { VERSION } from './version.js';

const $ = (id) => document.getElementById(id);
const ROUTES = { '#/': 'vue-carte', '#/parametres': 'vue-parametres', '#/etalonnage': 'vue-etalonnage', '#/a-propos': 'vue-apropos' };

const app = {
  palette: null, model: null, bed: null, soundings: null,
  settings: null, level: null, geo: null, calibration: null, probes: null,
  sim: null, compass: null,
  lakeMap: null, depthLayer: null,
  trackUp: false, alarmActive: false, lastAlarmAt: 0,
  editingProbeId: null, editingSimId: null, simMode: false,
  captureOpen: false,
  heading: null,
  lastBigDepth: null,
  wakeLock: null,
  sync: null, syncPushTimer: null, suppressPush: false,
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
    // Retouches de couleurs mémorisées : appliquées sur la palette en mémoire, dont tout
    // le rendu (table, légende, shader) dérive ensuite.
    applyAllPaletteOverrides();
    app.calibration = new Calibration();
    app.probes = new Probes();
    app.sim = new SimPoints();
    app.compass = new Compass();
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
    wireSim();
    wireCompass();
    wireMap();
    wireBigDepth();
    wireSync();
    route();

    refreshLevelUi();
    refreshDepthStyle();
    refreshSettingsUi();
    refreshCalibrationUi();
    refreshProbesUi();
    refreshProbesOnMap();
    refreshSimOnMap();
    refreshCaptureUi();
    applyBigDepthMode();
    applyModelCorrections(); // « carte 2009 corrigée » dès l'ouverture, s'il y a des relevés
    startWakeLock();
    initSync(); // récupère les relevés partagés puis les applique (asynchrone, sans bloquer)

    app.geo.addEventListener('position', onPosition);
    app.geo.addEventListener('status', onGeoStatus);
    app.geo.start();

    // La cote bouge de quelques centimètres par heure : un rafraîchissement toutes les
    // dix minutes suffit largement, et le fichier est servi depuis le cache si inchangé.
    setInterval(() => app.level.refresh().then(refreshLevelUi), 10 * 60e3);

    loadSoundingsLazily();
    registerServiceWorker();
    $('chargement').hidden = true;
    $('app-version').textContent = VERSION;
    $('apropos-version').textContent = `${VERSION} · levé ${app.bed.meta.sources?.ofb2009?.label ? '2009' : '—'} · grille ${app.bed.width}×${app.bed.height}`;
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
    const text = depth > 0 ? depth.toFixed(1) : '0';
    const color = depthColor(app.palette, presetName, depth);
    value.textContent = text;
    value.style.color = color;
    $('quille-value').textContent = depth > 0 ? `${(depth - draft).toFixed(1)} m` : '—';

    // Dire d'où vient le chiffre. Sur près de 38 % du lac il est interpolé entre des
    // traces distantes de plus de 60 m, et un haut-fond peut s'y cacher entièrement.
    const distance = app.bed.soundingDistanceAt(position.lon, position.lat);
    const unsurveyed = Number.isFinite(distance) && distance > app.settings.get('voidRadius_m');
    const label = depth <= 0
      ? 'fond émergé'
      : unsurveyed
        ? `interpolé — sonde à ${Math.round(distance)} m`
        : 'sous le bateau';
    const warning = unsurveyed && depth > 0;
    $('prof-label').textContent = label;
    $('prof-label').classList.toggle('is-warning', warning);
    app.lastBigDepth = { value: text, label, color, warning };
  } else {
    value.textContent = '—';
    value.style.color = '';
    $('prof-label').textContent = 'hors emprise du lac';
    $('quille-value').textContent = '—';
    app.lastBigDepth = { value: '—', label: 'hors emprise du lac', color: '', warning: false };
  }
  if (app.settings.get('bigDepth')) app.lakeMap.setBigDepth(app.lastBigDepth);

  $('vitesse-value').textContent = formatSpeed(position.speed, app.settings.get('speedUnit'));

  // Cap : la boussole de l'appareil est prioritaire (elle donne une orientation même à
  // l'arrêt) ; sans elle, on se rabat sur le cap déduit du déplacement GPS.
  if (app.compass?.heading == null && Number.isFinite(position.heading)) {
    updateHeading(position.heading, 'gps');
  }
  setGpsState(position.accuracy);

  updateAlarm(depth);
  if (location.hash === '#/etalonnage') refreshCalibrationContext();
}

function onGeoStatus(event) {
  const { status, message } = event.detail;
  if (message) toast(message, status === 'denied' ? 8000 : 3000);
  if (status !== 'active') $('prof-label').textContent = 'position en attente';
  if (status === 'denied' || status === 'unsupported') setGpsState(null, status);
  else if (status !== 'active') setGpsState(null, 'searching');
}

// ----------------------------------------------- grand affichage sous le bateau

function wireBigDepth() {
  const box = $('depth-box');
  box.addEventListener('click', toggleBigDepth);
  box.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggleBigDepth(); }
  });
  // Le calque sous le bateau rebascule vers le bas quand on le touche.
  app.lakeMap.addEventListener('bigdepthtoggle', toggleBigDepth);
}

function toggleBigDepth() {
  app.settings.set('bigDepth', !app.settings.get('bigDepth'));
  applyBigDepthMode();
}

function applyBigDepthMode() {
  const on = app.settings.get('bigDepth');
  $('depth-box').hidden = on;
  app.lakeMap.setBigDepth(on ? (app.lastBigDepth ?? { value: '—', label: '', color: '' }) : null);
}

// ------------------------------------------------- veille écran (navigation)

/**
 * Empêche la mise en veille de l'écran tant que l'application est au premier plan : en
 * navigation on regarde la carte sans toucher l'écran, et un réveil manuel permanent est
 * intenable. Le verrou se relâche seul en arrière-plan (l'API le libère quand l'onglet est
 * masqué), et on le reprend au retour au premier plan.
 */
async function startWakeLock() {
  if (!('wakeLock' in navigator)) return;
  const acquire = async () => {
    if (document.visibilityState !== 'visible') return;
    try { app.wakeLock = await navigator.wakeLock.request('screen'); }
    catch { /* refusé (batterie faible, onglet inactif) : sans gravité */ }
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') acquire();
  });
  await acquire();
}

// ------------------------------------------- synchronisation des relevés (dépôt)

function syncMeta() {
  return {
    transducer_m: app.settings.get('transducer_m'),
    radius_m: app.settings.get('correctionRadius_m'),
  };
}

function wireSync() {
  app.sync = new CorrectionsSync({
    repo: app.settings.get('syncRepo'),
    path: app.settings.get('syncPath'),
    branch: app.settings.get('syncBranch'),
    waterbody: app.settings.get('syncWaterbody'),
    datum: 'NGF-IGN69',
    baseUrl: '.',
  });
  $('sync-token').value = getToken();

  $('btn-sync-save').addEventListener('click', () => {
    setToken($('sync-token').value);
    toast(getToken() ? 'Jeton enregistré' : 'Jeton effacé');
    refreshSyncUi();
    if (getToken()) syncNow();
  });
  $('btn-sync-forget').addEventListener('click', () => {
    setToken('');
    $('sync-token').value = '';
    toast('Jeton oublié — cet appareil ne peut plus écrire');
    refreshSyncUi();
  });
  $('btn-sync-now').addEventListener('click', syncNow);

  refreshSyncUi();
}

// Les relevés partagés sont les sondes ✎ « Relever ». Conversion vers le format de
// fichier (générique, réutilisable) et retour.
function probesToRecords() {
  return (app.probes?.records ?? []).map((p) => ({
    id: p.id, at: p.at, lon: p.lon, lat: p.lat, bedZ: p.bedZ,
    depth_m: p.sounderDepth ?? null, cote_m: p.level ?? null,
  }));
}

function recordsToProbes(records) {
  const transducer = app.settings.get('transducer_m');
  return records.map((r) => ({
    id: r.id, at: r.at, lon: r.lon, lat: r.lat, bedZ: r.bedZ,
    sounderDepth: r.depth_m ?? null, level: r.cote_m ?? null,
    transducerDepth: transducer, levelSource: 'sync',
    accuracy: null, modelBedZ: null, modelDepth: null,
  }));
}

/** Union par id, l'horodatage le plus récent gagne les conflits. Jamais destructif. */
function mergeById(remote, local) {
  const byId = new Map();
  for (const r of [...(remote || []), ...(local || [])]) {
    const prev = byId.get(r.id);
    if (!prev || String(r.at || '') >= String(prev.at || '')) byId.set(r.id, r);
  }
  return [...byId.values()];
}

/**
 * Au démarrage : on FUSIONNE le distant et le local (jamais d'écrasement qui perdrait des
 * relevés), on adopte la fusion, puis on publie si le local apportait des relevés absents
 * du distant. C'est ce qui fait remonter des sondes saisies avant l'installation du jeton.
 */
async function initSync() {
  if (!app.sync) return;
  try {
    const { records: remote } = await app.sync.pull();
    const local = probesToRecords();
    const merged = mergeById(remote, local);
    adoptRemote(merged);
    const remoteIds = new Set(remote.map((r) => r.id));
    const hasLocalExtra = local.some((r) => !remoteIds.has(r.id));
    if (app.sync.hasToken() && (app.sync.dirty || hasLocalExtra)) await pushCorrections();
  } catch {
    setSyncStatus('hors ligne — relevés locaux conservés');
  }
  refreshSyncUi();
}

/** Bouton « Synchroniser » : envoie l'état local (avec jeton), sinon récupère et fusionne. */
async function syncNow() {
  if (!app.sync) return;
  setSyncStatus('synchronisation…');
  try {
    if (app.sync.hasToken()) {
      await pushCorrections();
      toast('Relevés synchronisés');
    } else {
      const { records } = await app.sync.pull();
      adoptRemote(mergeById(records, probesToRecords()));
      toast('Relevés partagés récupérés');
    }
  } catch (err) {
    setSyncStatus(`échec : ${err.message}`);
    toast('Synchronisation impossible', 6000);
  }
  refreshSyncUi();
}

/** Adopte un jeu de relevés (fusionné) sans déclencher de renvoi. */
function adoptRemote(records) {
  if (!Array.isArray(records)) return;
  app.suppressPush = true;
  app.probes.replaceAll(recordsToProbes(records));
  app.suppressPush = false;
}

function scheduleSyncPush() {
  if (!app.sync?.hasToken()) { app.sync?.markDirty(); refreshSyncUi(); return; }
  clearTimeout(app.syncPushTimer);
  app.syncPushTimer = setTimeout(() => { pushCorrections().catch(() => {}); }, 1500);
}

async function pushCorrections() {
  if (!app.sync?.hasToken()) return;
  setSyncStatus('envoi…');
  try {
    await app.sync.push(probesToRecords(), syncMeta());
    setSyncStatus(`à jour · ${app.probes.count} relevé(s)`);
  } catch (err) {
    app.sync.markDirty();
    setSyncStatus(`non synchronisé : ${err.message}`);
    throw err;
  }
  refreshSyncUi();
}

function setSyncStatus(text) {
  const el = $('sync-status');
  if (el) el.textContent = text;
}

function refreshSyncUi() {
  if (!app.sync) return;
  $('btn-sync-now').textContent = app.sync.hasToken() ? 'Synchroniser maintenant' : 'Récupérer les relevés';
  const cur = $('sync-status').textContent || '';
  const transient = /^(envoi|synchronisation|non synchronisé|échec|hors ligne)/.test(cur);
  if (!transient) {
    setSyncStatus(app.sync.hasToken()
      ? (app.sync.dirty ? 'écritures en attente' : `à jour · ${app.probes.count} relevé(s)`)
      : 'lecture seule (aucun jeton)');
  }
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
  refreshSimOnMap();
  if (app.simMode) refreshSimReadout();
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
  $('btn-reload').addEventListener('click', reloadApp);

  s.addEventListener('change', () => {
    refreshSettingsUi();
    refreshDepthStyle();
    refreshProbesOnMap();
    refreshSimOnMap();
    app.lakeMap.setBasemap(s.get('basemap'));
    app.lakeMap.setSoundings(null, s.get('showSoundings'));
  });

  wirePaletteEditor();
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

  refreshPaletteEditor();
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

  // Bouton d'édition (fabs) : déploie ou replie la barre de saisie, encombrante en
  // navigation seule. Fermer annule aussi une correction en cours.
  $('btn-saisie').addEventListener('click', () => {
    app.captureOpen = !app.captureOpen;
    if (!app.captureOpen && app.editingProbeId) endProbeEdit();
    refreshCaptureUi();
  });

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
    applyModelCorrections(); // une sonde ✎ corrige la carte en direct
    if (!app.suppressPush) scheduleSyncPush(); // et se partage
  });
}

/** Barre de saisie : visible seulement si demandée, et jamais pendant la simulation. */
function refreshCaptureUi() {
  const open = app.captureOpen && !app.simMode;
  $('capture').hidden = !open;
  $('btn-saisie').classList.toggle('is-on', open);
}

// -------------------------------------------------------- correction d'une sonde

function beginProbeEdit(id) {
  const record = app.probes.get(id);
  if (!record) return;

  app.editingProbeId = id;
  app.captureOpen = true; // corriger un point exige la barre de saisie déployée
  refreshCaptureUi();
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
    // Comparaison au levé 2009 BRUT (sinon on comparerait la sonde à une carte déjà
    // corrigée par les sondes précédentes — un écart artificiellement nul).
    modelBedZ: app.bed.baseAltitudeAt(position.lon, position.lat),
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

// ------------------------------------------------------ éditeur de couleurs

/** Réinjecte toutes les retouches mémorisées dans la palette en mémoire. */
function applyAllPaletteOverrides() {
  const overrides = app.settings.get('paletteOverrides') ?? {};
  Object.entries(overrides).forEach(([name, override]) => applyPaletteOverride(app.palette, name, override));
}

function wirePaletteEditor() {
  $('btn-band-add').addEventListener('click', addBand);
  $('btn-palette-reset').addEventListener('click', resetActivePalette);
  // Ne remplir l'éditeur qu'à l'ouverture évite de reconstruire ses lignes à chaque
  // réglage sans rapport (opacité, cote…), qui déclenchent tous refreshSettingsUi.
  $('palette-editor-box').addEventListener('toggle', refreshPaletteEditor);
}

/** Enregistre l'état courant du préréglage actif comme override, et rafraîchit tout. */
function commitPalette(preset, name) {
  const override = preset.mode === 'banded'
    ? { emerged_color: preset.emerged_color, bands: preset.bands.map((b) => ({ max_depth_m: b.max_depth_m, color: b.color })) }
    : { emerged_color: preset.emerged_color, stops: preset.stops.map((s) => ({ depth_m: s.depth_m, color: s.color })) };
  app.settings.update({ paletteOverrides: { ...app.settings.get('paletteOverrides'), [name]: override } });
}

function addBand() {
  const name = app.settings.get('preset');
  const preset = app.palette.presets[name];
  if (preset.mode !== 'banded') { toast('Ce préréglage est un dégradé continu'); return; }
  const bands = preset.bands;
  // Nouvelle plage insérée avant la dernière (qui va « jusqu'au fond »), à mi-chemin.
  const last = bands[bands.length - 1];
  const prev = bands.length > 1 ? bands[bands.length - 2].max_depth_m ?? app.palette.lut_max_depth_m : 0;
  const mid = Math.round((prev + app.palette.lut_max_depth_m) / 2);
  bands.splice(bands.length - 1, 0, { max_depth_m: mid, color: last.color });
  commitPalette(preset, name);
}

function removeBand(index) {
  const name = app.settings.get('preset');
  const preset = app.palette.presets[name];
  if (preset.bands.length <= 2) { toast('Au moins deux plages sont nécessaires'); return; }
  preset.bands.splice(index, 1);
  commitPalette(preset, name);
}

function resetActivePalette() {
  const name = app.settings.get('preset');
  const overrides = { ...app.settings.get('paletteOverrides') };
  delete overrides[name];
  app.settings.update({ paletteOverrides: overrides });
  // La palette en mémoire garde les valeurs retouchées : on recharge depuis le disque.
  reloadPalette();
}

// Recharge la palette d'origine puis réapplique les autres préréglages retouchés — le
// seul moyen d'annuler une retouche sans conserver de copie des valeurs d'usine en RAM.
async function reloadPalette() {
  try {
    app.palette = await fetchJson('config/palette.json');
    applyAllPaletteOverrides();
    refreshDepthStyle();
    refreshSettingsUi();
    toast('Couleurs d\'origine rétablies');
  } catch (err) {
    toast(`Rechargement impossible : ${err.message}`, 4000);
  }
}

/** Construit l'éditeur ligne par ligne pour le préréglage actif. */
function refreshPaletteEditor() {
  const box = $('palette-editor-box');
  const container = $('palette-editor');
  if (!container || !box.open) return;
  const name = app.settings.get('preset');
  const preset = app.palette.presets[name];
  const lutMax = app.palette.lut_max_depth_m;
  const rows = [];

  rows.push(editorRow('Terre émergée', preset.emerged_color, null, (color) => {
    preset.emerged_color = color;
    commitPalette(preset, name);
  }));

  if (preset.mode === 'banded') {
    $('btn-band-add').hidden = false;
    preset.bands.forEach((band, i) => {
      const isLast = i === preset.bands.length - 1;
      rows.push(editorRow(
        null, band.color,
        isLast ? null : band.max_depth_m ?? lutMax,
        (color) => { band.color = color; commitPalette(preset, name); },
        isLast ? null : (depth) => { band.max_depth_m = depth; commitPalette(preset, name); },
        isLast ? 'au-delà, jusqu\'au fond' : null,
        preset.bands.length > 2 ? () => removeBand(i) : null,
      ));
    });
  } else {
    $('btn-band-add').hidden = true;
    preset.stops.forEach((stop) => {
      rows.push(editorRow(`${stop.depth_m} m`, stop.color, null, (color) => {
        stop.color = color; commitPalette(preset, name);
      }));
    });
  }
  container.replaceChildren(...rows);
}

/**
 * Une ligne d'éditeur : pastille de couleur, libellé ou champ de profondeur, suppression.
 * `onDepth`/`onRemove` nuls masquent les contrôles correspondants.
 */
function editorRow(label, color, depth, onColor, onDepth, fixedLabel, onRemove) {
  const row = document.createElement('div');
  row.className = 'editor__row';

  const swatch = document.createElement('input');
  swatch.type = 'color';
  swatch.value = color;
  // 'change' (et non 'input') : on ne commit qu'à la fermeture du sélecteur, sinon
  // commitPalette reconstruirait la ligne sous le picker ouvert.
  swatch.addEventListener('change', () => onColor(swatch.value));
  row.append(swatch);

  if (onDepth) {
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '0.5'; input.max = '60'; input.step = '0.5';
    input.value = depth;
    input.setAttribute('aria-label', 'Profondeur maximale de la plage, en mètres');
    input.addEventListener('change', () => {
      const v = Number(input.value);
      if (Number.isFinite(v) && v > 0) onDepth(Math.min(v, 60));
    });
    const unit = document.createElement('span');
    unit.className = 'editor__unit';
    unit.textContent = 'm';
    row.append(input, unit);
  } else {
    const span = document.createElement('span');
    span.className = 'editor__label';
    span.textContent = fixedLabel ?? label ?? '';
    row.append(span);
  }

  if (onRemove) {
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'editor__del';
    remove.textContent = '×';
    remove.title = 'Supprimer cette plage';
    remove.addEventListener('click', onRemove);
    row.append(remove);
  }
  return row;
}

// ------------------------------------------------------------ boussole (cap)

const RIBBON_PX_PER_DEG = 3;
const WINDS = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];

function wireCompass() {
  buildCompassRibbon();
  updateCompass(null);

  app.compass.addEventListener('heading', (event) => {
    updateHeading(event.detail.heading, event.detail.source);
  });

  // Android et navigateurs sans autorisation explicite : on démarre tout de suite.
  if (app.compass.available && !app.compass.needsPermission) app.compass.start();

  // iOS : l'accès à la boussole exige un geste. On l'accroche au voyant et au bouton de cap.
  const ask = () => ensureCompass();
  $('compass-gps').addEventListener('click', ask);
  $('compass').addEventListener('click', ask);

  // Recadrer le ruban quand la largeur change (rotation de l'écran).
  window.addEventListener('resize', () => updateCompass(app.heading, app.compass?.source));
}

async function ensureCompass() {
  if (!app.compass.available) { toast('Boussole indisponible sur cet appareil'); return; }
  if (app.compass.active) return;
  const ok = await app.compass.start();
  toast(ok ? 'Boussole activée' : 'Accès à la boussole refusé');
}

/** Ruban de cap : ticks tous les 5°, lettres cardinales, chiffres tous les 30°. Trois
 *  tours (0–1080°) pour que le défilement enjambe la couture 360/0 sans saut. */
function buildCompassRibbon() {
  const ribbon = $('compass-ribbon');
  const parts = [];
  for (let d = 0; d <= 1080; d += 5) {
    const a = ((d % 360) + 360) % 360;
    const major = a % 90 === 0;
    const mid = a % 45 === 0;
    const tick = document.createElement('span');
    tick.className = major ? 'ctick ctick--card' : mid ? 'ctick ctick--mid' : 'ctick';
    tick.style.left = `${d * RIBBON_PX_PER_DEG}px`;
    if (a % 45 === 0) {
      const lbl = document.createElement('b');
      lbl.textContent = WINDS[a / 45];
      tick.append(lbl);
    } else if (a % 30 === 0) {
      const lbl = document.createElement('i');
      lbl.textContent = a;
      tick.append(lbl);
    }
    parts.push(tick);
  }
  ribbon.replaceChildren(...parts);
}

function updateHeading(heading, source) {
  app.heading = heading;
  updateCompass(heading, source);
  $('cap-value').textContent = Number.isFinite(heading) ? `${Math.round(heading)}°` : '—';
  scheduleMapHeading();
}

// La boussole émet à haute fréquence ; on ne fait tourner la carte qu'une fois par image
// pour rester fluide sans saturer le rendu.
let headingRaf = 0;
function scheduleMapHeading() {
  if (headingRaf) return;
  headingRaf = requestAnimationFrame(() => {
    headingRaf = 0;
    if (app.lakeMap && Number.isFinite(app.heading)) app.lakeMap.setHeading(app.heading, app.trackUp);
  });
}

function updateCompass(heading, source) {
  const deg = $('compass-deg');
  const ribbon = $('compass-ribbon');
  const idle = !Number.isFinite(heading);
  deg.classList.toggle('is-idle', idle);
  // Sur iOS, la boussole exige un geste : tant qu'elle n'est pas accordée, on invite
  // explicitement à toucher la barre plutôt que d'afficher un cap muet.
  const needsTap = idle && app.compass?.needsPermission && !app.compass?.granted;
  deg.classList.toggle('is-tap', needsTap);
  if (idle) {
    deg.textContent = needsTap ? '🧭 activer' : '•••';
  } else {
    deg.textContent = `${Math.round(heading).toString().padStart(3, '0')}° ${cardinal(heading)}`;
    deg.dataset.source = source ?? '';
  }
  // On centre sur le deuxième tour (cap + 360) pour disposer d'un tour de marge de chaque
  // côté : le ruban défile dans les deux sens sans découvrir de vide. Au repos, on cadre
  // le nord pour que la barre paraisse posée plutôt que décalée.
  const half = $('compass').clientWidth / 2;
  const centre = (idle ? 0 : heading) + 360;
  ribbon.style.transform = `translateX(${half - centre * RIBBON_PX_PER_DEG}px)`;
}

function cardinal(heading) {
  return WINDS[Math.round(((heading % 360) + 360) % 360 / 45) % 8];
}

/** Voyant GPS de la barre : couleur d'état et précision courante. */
function setGpsState(accuracy, override) {
  const el = $('compass-gps');
  const text = $('compass-gps-text');
  if (override === 'denied' || override === 'unsupported') {
    el.dataset.state = 'denied'; text.textContent = 'GPS ✕'; return;
  }
  if (override === 'searching' || !Number.isFinite(accuracy)) {
    el.dataset.state = 'searching'; text.textContent = 'GPS…'; return;
  }
  el.dataset.state = accuracy <= 20 ? 'active' : 'coarse';
  text.textContent = `±${Math.round(accuracy)} m`;
}

// -------------------------------------------------------------- simulation

function wireSim() {
  $('btn-sim').addEventListener('click', () => (app.simMode ? exitSim() : enterSim()));
  $('btn-sim-exit').addEventListener('click', exitSim);
  $('btn-sim-reset').addEventListener('click', () => {
    setSimLevel(app.simBaseLevel);
    $('sim-slider').value = app.simBaseLevel;
  });
  $('btn-sim-clear').addEventListener('click', () => {
    if (app.sim.count && confirm('Effacer tous les points témoins ?')) {
      endSimEdit();
      app.sim.clear();
    }
  });
  $('sim-slider').addEventListener('input', (e) => setSimLevel(Number(e.target.value)));

  // « + » = plus profond : la profondeur mesurée augmente, donc le fond (bedZ) descend.
  $('btn-sim-up').addEventListener('click', () => nudgeSimPoint(-0.25));
  $('btn-sim-down').addEventListener('click', () => nudgeSimPoint(0.25));
  $('btn-sim-del').addEventListener('click', deleteSimPoint);
  app.lakeMap.addEventListener('simselect', (event) => selectSimPoint(event.detail));

  app.sim.addEventListener('change', () => {
    applyModelCorrections(); // les points de simulation corrigent la carte localement
    refreshSimOnMap();
    refreshSimReadout();
    // Volontairement pas de synchro : le mode 🌊 est un bac à sable local ; seules les
    // sondes ✎ « Relever » sont partagées.
  });
}

/**
 * Reporte les relevés sur la grille et renvoie la texture corrigée au GPU. La correction
 * s'applique en permanence — pas seulement en mode simulation — pour que la carte affichée
 * en navigation soit bien la « 2009 corrigée ».
 *
 * Deux sources se cumulent : les sondes ✎ « Relever » (mesures réelles, ancrées au GPS,
 * partagées) et les points 🌊 de simulation (locaux, pour tester un étiage). Toutes deux
 * portent une altitude de fond invariante `bedZ`.
 */
function correctionRecords() {
  const fromProbes = (app.probes?.records ?? [])
    .filter((p) => Number.isFinite(p.bedZ))
    .map((p) => ({ lon: p.lon, lat: p.lat, bedZ: p.bedZ }));
  const fromSim = app.sim?.records ?? [];
  return [...fromProbes, ...fromSim];
}

function applyModelCorrections() {
  if (!app.bed || !app.depthLayer) return;
  app.bed.applyCorrections(correctionRecords(), app.settings.get('correctionRadius_m'));
  app.depthLayer.updateBed();
}

function enterSim() {
  app.simMode = true;
  // Cote réelle du moment, référence des écarts ; et réglage manuel d'avant la simulation,
  // à restaurer en sortie pour ne pas détourner durablement l'affichage.
  app.simEnteredWithManual = app.settings.get('manualLevel');
  app.simBaseLevel = round2(currentLevel().value ?? app.model.lake.normal_level_m_ngf);
  $('btn-sim').classList.add('is-on');
  $('sim').hidden = false;
  refreshCaptureUi(); // en simulation on pose des témoins, pas des sondes
  const slider = $('sim-slider');
  slider.min = 641; slider.max = 651; slider.step = 0.05;
  slider.value = app.simBaseLevel;
  setSimLevel(app.simBaseLevel);
  refreshSimOnMap();
  toast('Simulation : glissez le niveau, touchez la carte pour poser un témoin');
}

function exitSim() {
  app.simMode = false;
  app.editingSimId = null;
  $('btn-sim').classList.remove('is-on');
  $('sim').hidden = true;
  refreshCaptureUi();
  $('sim-sel').hidden = true;
  app.settings.set('manualLevel', app.simEnteredWithManual ?? null);
  app.simEnteredWithManual = undefined;
  refreshSimOnMap();
}

/** Pilote la cote via le réglage manuel : le shader recolore tout, l'émergé apparaît. */
function setSimLevel(value) {
  app.settings.set('manualLevel', round2(value));
  refreshLevelUi(); // recolore la carte, met à jour le bandeau de cote et les témoins
}

function refreshSimReadout() {
  const level = currentLevel().value;
  if (!Number.isFinite(level)) return;
  $('sim-cote').textContent = level.toFixed(2);
  const delta = level - (app.simBaseLevel ?? level);
  const el = $('sim-delta');
  if (Math.abs(delta) < 0.005) {
    el.textContent = 'cote actuelle';
    el.className = 'sim__delta';
  } else {
    el.textContent = `${delta > 0 ? '+' : '−'}${Math.abs(delta).toFixed(2)} m vs cote actuelle`;
    el.className = delta < 0 ? 'sim__delta sim__delta--down' : 'sim__delta sim__delta--up';
  }
  $('btn-sim-clear').hidden = !app.sim.count;
}

function addSimPoint(lon, lat) {
  // On lit la grille BRUTE : un nouveau relevé part de la carte 2009, pas d'une correction
  // déjà posée à côté, sinon les corrections s'empileraient à chaque pose.
  const bedZ = correctedAltitude(
    app.bed.baseAltitudeAt(lon, lat),
    app.settings.get('calibrationOffset_m'),
    app.settings.get('waterPlane_m_ngf'),
  );
  if (!Number.isFinite(bedZ)) { toast('Hors emprise du modèle'); return; }
  const cote = currentLevel().value;
  const depth = Number.isFinite(cote) ? round2(cote - bedZ) : null;
  const entry = app.sim.add({ lon, lat, bedZ, depth_m: depth, cote_m: Number.isFinite(cote) ? round2(cote) : null });
  selectSimPoint(entry.id);
  toast(depth != null
    ? `Relevé posé · ${depth.toFixed(1)} m — ajustez à la profondeur lue`
    : `Relevé posé · fond ${bedZ.toFixed(1)} m NGF`);
}

function selectSimPoint(id) {
  app.editingSimId = app.editingSimId === id ? null : id;
  refreshSimOnMap();
  refreshSimSelection();
}

function endSimEdit() {
  app.editingSimId = null;
  $('sim-sel').hidden = true;
  refreshSimOnMap();
}

function refreshSimSelection() {
  const record = app.editingSimId ? app.sim.get(app.editingSimId) : null;
  $('sim-sel').hidden = !record;
  if (!record) return;
  const level = currentLevel().value;
  const depth = Number.isFinite(level) ? level - record.bedZ : NaN;
  const head = !Number.isFinite(depth)
    ? `Fond ${record.bedZ.toFixed(2)} m NGF`
    : depth <= 0
      ? `Émergé de ${(-depth).toFixed(1)} m`
      : `${depth.toFixed(1)} m d'eau`;
  $('sim-sel-label').textContent = `${head} · fond ${record.bedZ.toFixed(2)} m NGF`;
}

function nudgeSimPoint(delta) {
  if (!app.editingSimId) return;
  const record = app.sim.get(app.editingSimId);
  if (!record) return;
  const bedZ = round2(record.bedZ + delta);
  // On garde la provenance cohérente : la profondeur mesurée suit la cote du relevé.
  const changes = { bedZ };
  if (Number.isFinite(record.cote_m)) changes.depth_m = round2(record.cote_m - bedZ);
  app.sim.update(app.editingSimId, changes);
  refreshSimSelection();
}

function deleteSimPoint() {
  if (!app.editingSimId) return;
  const id = app.editingSimId;
  endSimEdit();
  app.sim.remove(id);
  toast('Point témoin supprimé');
}

/** Pastilles des points témoins, avec bascule émergé/immergé selon la cote simulée. */
function refreshSimOnMap() {
  if (!app.sim || !app.lakeMap) return;
  if (!app.simMode) { app.lakeMap.setSimPoints([]); return; }

  const level = currentLevel().value;
  const points = app.sim.records.map((r) => {
    const depth = Number.isFinite(level) ? level - r.bedZ : NaN;
    const emerged = Number.isFinite(depth) && depth <= 0;
    return {
      id: r.id,
      lon: r.lon,
      lat: r.lat,
      emerged,
      label: !Number.isFinite(depth) ? '?' : emerged ? `+${(-depth).toFixed(1)}` : depth.toFixed(1),
      editing: r.id === app.editingSimId,
    };
  });
  app.lakeMap.setSimPoints(points);
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
    // Bascule immédiate, sans attendre la prochaine mesure de cap.
    if (app.trackUp) app.lakeMap.setHeading(app.heading, true);
    else app.lakeMap.resetNorth();
    // « Cap en haut » sans boussole accordée ne sert à rien : on la demande au passage.
    if (app.trackUp) ensureCompass();
  });

  // Faire glisser la carte coupe le suivi : sinon l'écran ramène le bateau au centre
  // à chaque relevé GPS et il devient impossible de regarder devant soi.
  app.lakeMap.addEventListener('userpan', () => {
    if (app.settings.get('followBoat')) {
      app.settings.set('followBoat', false);
      $('btn-suivi').classList.remove('is-on');
    }
  });

  // Clic carte : en simulation, pose un point témoin ; sinon, sonde ponctuelle.
  app.lakeMap.addEventListener('probe', (event) => {
    const { lng, lat } = event.detail;
    if (app.simMode) { addSimPoint(lng, lat); return; }
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

/**
 * Force le chargement de la dernière version. Sans service worker, le levier réel est le
 * cache HTTP : on purge d'abord tout cache applicatif (Cache Storage, service workers —
 * inexistants ici, mais la purge est sans risque et pare l'avenir), puis on recharge le
 * document avec une adresse neuve pour éviter qu'il ne revienne du cache. Le témoin de
 * version dira ensuite si les modules ont, eux aussi, été rafraîchis.
 */
async function reloadApp() {
  toast('Rechargement…');
  try {
    // On garde le service worker (c'est lui qui garantit la fraîcheur), mais on vide son
    // cache et on le force à vérifier une mise à jour : au rechargement, il ira au réseau.
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
    const reg = await navigator.serviceWorker?.getRegistration();
    await reg?.update();
  } catch { /* purge best-effort : on recharge quoi qu'il arrive */ }
  location.replace(`${location.pathname}?r=${Date.now()}${location.hash}`);
}

/** Enregistre le service worker « réseau d'abord » (mises à jour auto + hors ligne). */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    navigator.serviceWorker.register(new URL('../sw.js', import.meta.url)).catch(() => {});
  } catch { /* contexte sans service worker (ex. certains navigateurs privés) */ }
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
