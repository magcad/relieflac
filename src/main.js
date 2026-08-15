// Assemblage de l'application : chargement des données, carte, réglages, étalonnage.

import { BedGrid, BED_SOURCES, correctedAltitude, DEFAULT_BED_SOURCE } from './bed.js';
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
import { closeRing, dedupeRing, DEFAULT_FEATHER_M, formatArea, groundAltitude, ringArea, Zones } from './zones.js';

const $ = (id) => document.getElementById(id);
/** Pas des boutons de zoom : un niveau, donc un facteur deux — franc et prévisible. */
const ZOOM_STEP = 1;
const ROUTES = { '#/': 'vue-carte', '#/parametres': 'vue-parametres', '#/etalonnage': 'vue-etalonnage', '#/a-propos': 'vue-apropos' };

const app = {
  palette: null, model: null, bed: null, soundings: null,
  settings: null, level: null, geo: null, calibration: null, probes: null,
  sim: null, compass: null, zones: null,
  lakeMap: null, depthLayer: null,
  alarmActive: false, lastAlarmAt: 0,
  editingProbeId: null, editingSimId: null, simMode: false,
  captureOpen: false,
  // Point désigné à la main sur la carte, en attente de sa profondeur — le seul moyen de
  // poser une sonde sans signal GPS, donc de manipuler l'application sur un ordinateur.
  pin: null,
  // Zones émergées. Trois états, et non deux : le panneau ouvert (`zoneMode`), le tracé en
  // cours (`zoneTracing`), la zone reprise pour réglage (`editingZoneId`). Les confondre
  // rendait un contour injoignable dès qu'un sommet avait été posé par mégarde.
  zoneMode: false, zoneTracing: false, zoneDraft: [], editingZoneId: null,
  heading: null,
  lastBigDepth: null,
  wakeLock: null, wakeState: 'lost', wakePending: false, wakeWarned: false,
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
    // Une simulation d'étiage interrompue — application fermée, onglet tué, batterie à
    // plat — laissait sa cote inventée dans les réglages, où elle passait ensuite pour la
    // cote du lac. On la retire avant que quoi que ce soit ne la lise, et l'on rend celle
    // qui était en vigueur avant.
    if (app.settings.get('manualFromSim')) {
      app.simLevelDropped = app.settings.get('manualLevel');
      app.settings.update({
        manualLevel: app.settings.get('manualBeforeSim') ?? null,
        manualFromSim: false,
        manualBeforeSim: null,
      });
    }
    // Retouches de couleurs mémorisées : appliquées sur la palette en mémoire, dont tout
    // le rendu (table, légende, shader) dérive ensuite.
    applyAllPaletteOverrides();
    app.calibration = new Calibration();
    app.probes = new Probes();
    app.sim = new SimPoints();
    app.zones = new Zones();
    app.compass = new Compass();
    app.level = new Level('.');
    app.geo = new Geolocator();

    // Un réglage mémorisé peut désigner un fond que ce déploiement-ci ne contient pas
    // (fichier absent, version antérieure resservie par le cache) : on se rabat sur le
    // levé plutôt que de refuser de démarrer sur l'eau.
    try {
      app.bed = await BedGrid.load('.', app.settings.get('bedSource'));
    } catch (err) {
      if (app.settings.get('bedSource') === DEFAULT_BED_SOURCE) throw err;
      console.warn('fond indisponible, retour au levé de 2009', err);
      app.settings.set('bedSource', DEFAULT_BED_SOURCE);
      app.bed = await BedGrid.load('.', DEFAULT_BED_SOURCE);
    }
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
    // Cadrage de navigation dès l'ouverture, avant même le premier point GPS : le zoom
    // initial du constructeur montre le lac entier, inutilisable pour barrer. On reprend
    // le cadrage de la dernière sortie, et à défaut on vise la largeur de référence.
    const savedZoom = app.settings.get('zoom');
    if (Number.isFinite(savedZoom)) app.lakeMap.setZoom(savedZoom);
    else app.lakeMap.setVisibleWidth(app.settings.get('initialWidth_m'));

    wireSettings();
    wireCalibration();
    wireProbes();
    wireSim();
    wireZones();
    wireCompass();
    wireMap();
    wireBigDepth();
    wireSync();
    wireTools();
    wireQuickNav();
    route();

    refreshLevelUi();
    refreshDepthStyle();
    refreshSettingsUi();
    refreshCalibrationUi();
    refreshProbesUi();
    refreshProbesOnMap();
    refreshSimOnMap();
    refreshZonesUi();
    refreshZonesOnMap();
    refreshCaptureUi();
    applyBigDepthMode();
    applySunMode();
    applyBedDatum(); // recalage mémorisé, avant que les relevés ne se posent dessus
    applyModelCorrections(); // « carte 2009 corrigée » dès l'ouverture, s'il y a des relevés
    initSync(); // récupère les relevés partagés puis les applique (asynchrone, sans bloquer)

    app.geo.addEventListener('position', onPosition);
    app.geo.addEventListener('status', onGeoStatus);
    app.geo.start();

    // La cote bouge de quelques centimètres par heure : un rafraîchissement toutes les
    // dix minutes suffit largement, et le fichier est servi depuis le cache si inchangé.
    setInterval(() => app.level.refresh().then(refreshLevelUi), 10 * 60e3);

    if (Number.isFinite(app.simLevelDropped)) {
      toast(`Cote de simulation ${app.simLevelDropped.toFixed(2)} m abandonnée — `
        + 'retour à la cote du lac', 8000);
    }

    loadSoundingsLazily();
    registerServiceWorker();
    $('chargement').hidden = true;
    $('app-version').textContent = VERSION;
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
  const status = $('soundings-status');
  try {
    app.soundings = await Soundings.load('.');
    app.lakeMap.setSoundings(app.soundings.toGeoJSON(), app.settings.get('showSoundings'));
    if (status) status.textContent = `Sondes 2009 : ${app.soundings.count} chargées`;
    setTimeout(refreshSoundingsDiag, 800);
    setTimeout(refreshSoundingsDiag, 3000); // après que MapLibre a fini de tuiler la source
  } catch (err) {
    console.warn('sondes 2009 indisponibles', err);
    if (status) status.textContent = `Sondes 2009 : échec du chargement (${err.message})`;
  }
}

/** Rapporte à l'écran l'état de rendu du calque des sondes (données présentes mais invisibles ?). */
function refreshSoundingsDiag() {
  const status = $('soundings-status');
  if (!status || !app.soundings || !app.lakeMap) return;
  const d = app.lakeMap.soundingsDebug();
  status.textContent = `Sondes 2009 : ${app.soundings.count} chargées · couche ${d.vis}`
    + ` · source ${d.data} · tuilées ${d.tiled} · rendues ${d.rendered} · err: ${d.err}`;
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
  // Suivi et cap en haut sont détenus par la carte (voir refreshCameraUi) : ici on ne fait
  // que lui livrer la position, elle sait quoi en faire.
  app.lakeMap.setPosition(position);

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

    // Dire d'où vient le chiffre, en trois états et non plus deux. Loin de toute sonde de
    // 2009, la valeur est une interpolation entre des traces distantes de plus de 60 m, et
    // un haut-fond peut s'y cacher entièrement — c'est là qu'il faut alerter. Mais là où la
    // cartographie communautaire est passée, le fond est encadré par la bande qu'elle
    // donne : ce n'est pas une mesure au décimètre, c'est tout de même un sondeur qui est
    // passé, et le haut-fond invisible est exclu. On le dit, sans crier.
    //
    // Sur le fond communautaire la question ne se pose plus dans les mêmes termes : il n'y
    // a pas de zone interpolée, chaque cellule affichée porte le passage d'un sondeur. Mais
    // aucune n'est mesurée au décimètre non plus, et il serait faux de laisser croire le
    // contraire — l'étiquette dit donc toujours la bande, ce qui rappelle en même temps
    // quelle carte est sous les pieds.
    const distance = app.bed.soundingDistanceAt(position.lon, position.lat);
    const unsurveyed = Number.isFinite(distance) && distance > app.settings.get('voidRadius_m');
    const bound = app.bed.communityBoundAt(position.lon, position.lat);
    const community = app.bed.source === 'quickdraw';
    // Sur l'émergé, dire d'où vient l'altitude n'est pas un détail d'affichage : le recalage
    // de la carte communautaire ne déplace QUE les cellules encadrées par une bande. Debout
    // sur la rive, c'est la seule façon de savoir si le point qu'on relève mesure le décalage
    // cherché — ou le terrain LiDAR, qui est absolu et ne bouge pas, et qui tirerait la
    // médiane vers zéro sans que rien ne le signale.
    const label = depth <= 0
      ? (bound > 0 ? `fond émergé — bande ≤ ${bound} m` : 'fond émergé — hors bande')
      : community
        ? (bound > 0 ? `communauté — bande ≤ ${bound} m` : 'communauté — hors bande')
        : unsurveyed
          ? (bound > 0
            ? `encadré — communauté ≤ ${bound} m`
            : `interpolé — sonde à ${Math.round(distance)} m`)
          : 'sous le bateau';
    const warning = depth > 0 && bound === 0 && (community || unsurveyed);
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

// --------------------------------------- veille écran et lisibilité au soleil

/** Reprise de sécurité du verrou d'écran (ms) : sans coût quand le verrou tient déjà. */
const WAKE_LOCK_CHECK_MS = 30e3;

/**
 * Garde l'écran allumé tant que l'application est au premier plan.
 *
 * En navigation on regarde la carte sans y toucher : laisser l'iPhone s'assoupir est
 * intenable — il commence par baisser fortement la luminosité, puis verrouille, et le
 * réveil relance une recherche GPS. C'est la seule des baisses de luminosité de l'iPhone
 * qu'un site web puisse empêcher ; les autres (capteur de lumière, bridage thermique) ne
 * sont pilotables par aucune API, d'où le mode « plein soleil » ci-dessous, qui joue sur
 * ce qui reste : le contraste de l'affichage.
 *
 * Le verrou est repris à plusieurs occasions, car aucune ne suffit seule : le système le
 * relâche en arrière-plan, mais aussi lors d'un appel ou d'une bannière de notification,
 * sans toujours émettre `visibilitychange`. La reprise périodique rattrape ces cas sans
 * risquer la boucle qu'aurait provoquée une redemande immédiate à chaque relâchement.
 */
function keepScreenAwake() {
  if (!('wakeLock' in navigator)) { app.wakeState = 'unsupported'; refreshWakeUi(); return; }

  const acquire = async () => {
    // On interroge `released` plutôt que de se fier au seul événement `release` : WebKit ne
    // l'émet pas toujours quand le système reprend le verrou (appel, bannière, bascule
    // d'application). Le croire sur parole laissait une référence morte en main, `acquire`
    // repartait aussitôt, et l'écran s'éteignait sans que rien ne le signale — c'est très
    // probablement ce qui s'est passé pendant la sortie.
    if (screenLockHeld() || document.visibilityState !== 'visible') return;
    if (app.wakePending) return;
    app.wakePending = true;
    try {
      app.wakeLock = await navigator.wakeLock.request('screen');
      app.wakeState = 'held';
    } catch {
      // Refus le plus courant : le mode économie d'énergie de l'iPhone, qui interdit le
      // verrou d'écran. Aucune application web ne peut passer outre — d'où l'affichage.
      app.wakeLock = null;
      app.wakeState = 'refused';
    } finally {
      app.wakePending = false;
      refreshWakeUi();
    }
  };

  document.addEventListener('visibilitychange', () => { if (!document.hidden) acquire(); });
  window.addEventListener('focus', acquire);
  document.addEventListener('pointerdown', acquire, { passive: true });
  setInterval(() => { refreshWakeUi(); acquire(); }, WAKE_LOCK_CHECK_MS);
  acquire();
}

/** Le verrou est-il réellement tenu ? Une sentinelle relâchée en est une morte. */
function screenLockHeld() {
  return Boolean(app.wakeLock) && app.wakeLock.released !== true;
}

/**
 * Rend l'état de la veille écran visible.
 *
 * Sans cela le barreur navigue à l'aveugle : le verrou peut être refusé en silence, et il
 * ne le découvre qu'en voyant l'écran s'éteindre au milieu du lac. On avertit une fois, au
 * moment du refus, et l'état reste consultable dans les Paramètres.
 */
function refreshWakeUi() {
  if (!('wakeLock' in navigator)) app.wakeState = 'unsupported';
  else if (screenLockHeld()) app.wakeState = 'held';
  else if (app.wakeState !== 'refused') app.wakeState = 'lost';

  const hint = $('hint-veille');
  if (hint) hint.textContent = WAKE_MESSAGES[app.wakeState] ?? '';

  if (app.wakeState !== 'held' && app.wakeState !== 'unsupported' && !app.wakeWarned) {
    app.wakeWarned = true;
    toast("L'écran n'est pas maintenu allumé — désactivez le mode économie d'énergie", 6000);
  }
}

const WAKE_MESSAGES = {
  held: 'Écran maintenu allumé : oui.',
  refused: "Écran maintenu allumé : non — refusé par l'appareil. C'est presque toujours le "
    + "mode économie d'énergie de l'iPhone, qu'aucune application web ne peut contourner. "
    + 'Le désactiver, ou brancher le téléphone, rétablit le maintien.',
  lost: 'Écran maintenu allumé : pas pour le moment. La reprise est automatique dès que la '
    + 'page revient au premier plan.',
  unsupported: 'Écran maintenu allumé : impossible, ce navigateur ne fournit pas le verrou '
    + "d'écran. Régler la mise en veille sur « Jamais » dans les réglages de l'appareil.",
};

/**
 * Mode « plein soleil » : contraste maximal de l'habillage.
 *
 * Aucune API du web ne règle la luminosité de la dalle — ni celle du réglage, ni celle
 * qu'iOS impose de lui-même. Ce qui reste jouable est ce que l'application émet : en plein
 * soleil, la dalle renvoie plus de lumière ambiante qu'elle n'en produit, et tout ce qui
 * est translucide, flouté ou gris se noie. Ce mode supprime les fonds semi-transparents et
 * les flous, passe les textes secondaires en blanc franc et épaissit les bordures. Les
 * couleurs des fonds, elles, ne sont pas touchées : elles portent la lecture des
 * profondeurs, on ne les repeint pas.
 */
function applySunMode() {
  const on = app.settings.get('sunMode');
  document.body.classList.toggle('is-sun', on);
  $('btn-soleil').classList.toggle('is-on', on);
  $('btn-soleil').setAttribute('aria-pressed', String(on));
}

// ------------------------------------------- synchronisation des relevés (dépôt)

// `transducer_m` n'est plus qu'un repli : chaque relevé porte désormais la sienne, celle
// qui était réglée quand la mesure a été prise. Voir `CorrectionsSync.toFile`.
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

// Les relevés partagés sont les sondes « Relever ». Conversion vers le format de
// fichier (générique, réutilisable) et retour.
function probesToRecords() {
  return (app.probes?.records ?? []).map((p) => ({
    id: p.id, at: p.at, lon: p.lon, lat: p.lat, bedZ: p.bedZ,
    depth_m: p.sounderDepth ?? null, cote_m: p.level ?? null,
    transducer_m: p.transducerDepth ?? null,
    radius_m: p.radius_m ?? null,
    position_source: p.fixSource ?? 'gps',
  }));
}

// L'immersion revient du relevé lui-même. Le réglage courant ne sert que de repli, pour
// les relevés partagés avant que le fichier ne la transporte : leur attribuer la valeur
// du jour donnerait un `z_fond` différent de celui qui a été mesuré.
function recordsToProbes(records) {
  const fallback = app.settings.get('transducer_m');
  return records.map((r) => ({
    id: r.id, at: r.at, lon: r.lon, lat: r.lat, bedZ: r.bedZ,
    sounderDepth: r.depth_m ?? null, level: r.cote_m ?? null,
    transducerDepth: Number.isFinite(r.transducer_m) ? r.transducer_m : fallback,
    radius_m: Number.isFinite(r.radius_m) ? r.radius_m : null,
    fixSource: r.position_source ?? 'gps',
    levelSource: 'sync',
    accuracy: null, modelBedZ: null, modelDepth: null,
  }));
}

/**
 * Union par id, l'horodatage le plus récent gagne les conflits.
 *
 * Non destructive par principe : deux appareils qui relèvent chacun de leur côté doivent
 * additionner leurs sondes, jamais s'effacer l'un l'autre. Une union pure, en revanche, ne
 * sait pas exprimer une suppression — le relevé effacé ici est toujours dans le fichier
 * partagé, et la fusion le ramène à l'ouverture suivante. C'était le cas : la suppression
 * paraissait sans effet sur les quatre sondes publiées, puisqu'elles revenaient à chaque
 * démarrage.
 *
 * D'où les pierres tombales (`Probes.deletedIds`) : un relevé distant plus ancien que sa
 * propre suppression est écarté. Plus récent, il repasse — c'est alors qu'il a été mesuré à
 * nouveau depuis, et la même règle d'horodatage doit valoir.
 */
function mergeById(remote, local) {
  const graves = Probes.deletedIds();
  const byId = new Map();
  for (const r of [...(remote || []), ...(local || [])]) {
    const buried = graves.get(r.id);
    if (buried && String(r.at || '') <= buried) continue;
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

/**
 * Cote du lac : une pastille compacte dans le bandeau, le détail dans la feuille.
 *
 * La cote bouge de quelques centimètres par heure — elle n'a pas à occuper deux lignes en
 * permanence au-dessus de la carte. Ne reste affiché en navigation que le chiffre, plus un
 * complément court quand il change la lecture : saisie manuelle, ou relevé périmé. Le
 * libellé complet (état de navigation et âge) est repris dans la feuille « Outils », qui
 * s'ouvre au même geste que l'ancien chip.
 */
function refreshLevelUi() {
  const state = currentLevel();
  const chip = $('btn-cote');
  const value = $('cote-value');
  const meta = $('cote-meta');

  chip.classList.remove('level--forbidden', 'level--delicate', 'level--stale', 'level--manual');

  if (state.value == null) {
    value.textContent = '—';
    meta.textContent = '';
    chip.title = `Cote du lac : ${state.label}`;
    $('sheet-level').textContent = `Cote du lac — ${state.label}`;
    chip.classList.add('level--stale');
  } else {
    value.textContent = state.value.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const manual = state.source === LevelSource.MANUAL;
    const detail = manual ? 'saisie manuelle' : `${state.condition.label} · ${formatAge(state.ageMs)}`;
    // Le complément ne paraît que lorsqu'il porte un avertissement : une cote fraîche et
    // automatique se passe de commentaire, et l'espace du bandeau est compté.
    meta.textContent = manual ? 'saisie' : state.source === LevelSource.STALE ? formatAge(state.ageMs) : '';
    chip.title = `Cote du lac : ${detail} — toucher pour les réglages`;
    $('sheet-level').textContent = `Cote du lac ${value.textContent} m NGF — ${detail}`;
    if (state.condition.key === 'forbidden') chip.classList.add('level--forbidden');
    else if (state.condition.key === 'delicate') chip.classList.add('level--delicate');
    if (state.source === LevelSource.STALE) chip.classList.add('level--stale');
    // Une cote saisie à la main n'est pas la cote du lac : tant qu'elle est en place, toutes
    // les profondeurs affichées sont fausses d'autant. Le liseré pointillé le dit sans avoir
    // à lire la mention « saisie ».
    if (manual) chip.classList.add('level--manual');
  }

  refreshDepthStyle();
  refreshProbesOnMap();
  refreshSimOnMap();
  // La zone sélectionnée annonce si elle émerge à la cote courante : le curseur d'étiage
  // doit faire basculer ce verdict en même temps que la couleur du fond.
  if (app.zoneMode) refreshZonePanel();
  if (app.simMode) refreshSimReadout();
}

// --------------------------------------------------------------- réglages

function wireSettings() {
  const s = app.settings;

  const select = $('set-preset');
  Object.entries(app.palette.presets).forEach(([key, preset]) => {
    select.append(new Option(preset.label, key));
  });

  bind('set-bed-source', 'change', (el) => s.set('bedSource', el.value));
  bind('set-qd-datum', 'change', (el) => {
    const value = Number(el.value);
    s.set('quickdrawDatum_m', el.value === '' || !Number.isFinite(value)
      ? null
      : Math.max(-10, Math.min(10, round2(value))));
  });
  $('btn-qd-datum-reset').addEventListener('click', () => s.set('quickdrawDatum_m', null));
  bind('set-preset', 'change', (el) => s.set('preset', el.value));
  bind('set-opacity', 'input', (el) => s.set('opacity', Number(el.value) / 100));
  bind('set-outlines', 'change', (el) => s.set('showOutlines', el.checked));
  bind('set-safety', 'change', (el) => s.set('showSafety', el.checked));
  bind('set-soundings', 'change', (el) => s.set('showSoundings', el.checked));
  bind('set-voids', 'change', (el) => s.set('showVoids', el.checked));
  bind('set-sun', 'change', (el) => s.set('sunMode', el.checked));
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
    // Une cote posée par la simulation laisse un marqueur : la retirer à la main, c'est
    // aussi sortir de cet état, sinon le démarrage suivant abandonnerait une cote que
    // l'utilisateur aurait pu saisir entre-temps.
    if (s.get('manualFromSim')) s.set('manualFromSim', false);
    $('set-manual-level').value = '';
    // Appelé sans condition : `set` ne notifie personne si la valeur était déjà `null`, et
    // un bouton qui ne répond pas quand il n'y avait rien à effacer passe pour cassé.
    refreshLevelUi();
    const state = currentLevel();
    toast(state.value == null
      ? `Cote EDF indisponible — ${state.label}`
      : `Cote EDF ${state.value.toFixed(2)} m NGF`);
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
  wireArmed('btn-reset', 'Confirmer ?', () => {
    s.reset();
    toast('Réglages réinitialisés');
  });
  $('btn-reload').addEventListener('click', reloadApp);

  s.addEventListener('change', (event) => {
    refreshSettingsUi();
    // La cote affichée dépend d'un réglage — `manualLevel` — qui change par le champ de
    // saisie, le bouton « Revenir à la cote EDF », la sortie de simulation, un profil
    // importé ou une réinitialisation. Sans cette relecture, le bandeau gardait la cote
    // précédente jusqu'au prochain rafraîchissement automatique : le réglage était bien
    // remis, l'écran disait le contraire. refreshLevelUi enchaîne le fond et les
    // surcouches, d'où les trois appels qu'elle remplace ici.
    refreshLevelUi();
    refreshZonesOnMap();
    applySunMode();
    // Un profil importé ou réinitialisé change `followBoat` sans passer par le bouton.
    refreshCameraUi();
    app.lakeMap.setBasemap(s.get('basemap'));
    app.lakeMap.setSoundings(null, s.get('showSoundings'));
    setTimeout(refreshSoundingsDiag, 300);
    // Reporter les relevés sur la grille coûte un balayage de 1,2 million de cellules et un
    // renvoi de texture : on ne le refait que si le rayon a bougé — ou si l'on ne sait pas
    // ce qui a bougé (profil importé, réinitialisation), auquel cas il a pu bouger.
    const key = event.detail?.key;
    // Changer de fond recharge une grille : c'est asynchrone, et la réapplication des
    // relevés se fait de l'autre côté de l'attente. `applyBedSource` ne fait rien si le
    // fond demandé est déjà celui qui est affiché, ce qui est le cas ordinaire.
    if (key == null || key === 'bedSource') applyBedSource(key === 'bedSource');
    if (key == null || key === 'quickdrawDatum_m') applyBedDatum(key === 'quickdrawDatum_m');
    if (key == null || key === 'correctionRadius_m') applyModelCorrections();
  });

  wirePaletteEditor();
}

function bind(id, event, handler) {
  const element = $(id);
  element.addEventListener(event, () => handler(element));
}

// ------------------------------------- confirmer sans boîte de dialogue du navigateur

/** Temps pendant lequel un bouton reste armé avant de reprendre son libellé (ms). */
const ARM_MS = 4000;

/** Désarmement de chaque bouton armé, par identifiant. */
const armedButtons = new Map();

/**
 * Fait confirmer une action destructrice par un **second appui sur le bouton lui-même**.
 *
 * `window.confirm` n'est pas fiable ici, et le découvrir a coûté une suppression réputée
 * cassée : Chrome propose « Empêcher cette page de créer des boîtes de dialogue
 * supplémentaires » dès la deuxième, et la case une fois cochée, l'appel renvoie `false`
 * en silence pour toute la vie de la page. Le bouton paraît alors mort. D'autres
 * navigateurs — dont celui qui sert aux vérifications — les suppriment purement et
 * simplement, avec le même effet.
 *
 * Un bouton qui s'arme ne dépend de rien, se lit d'un coup d'œil, se désarme seul si l'on
 * passe son chemin, et reste manœuvrable d'une main sur un bateau qui bouge.
 */
function wireArmed(id, armedLabel, action) {
  const button = $(id);
  const idle = button.textContent;
  let timer = 0;
  const disarm = () => {
    clearTimeout(timer);
    timer = 0;
    button.textContent = idle;
    button.classList.remove('is-arming');
  };
  armedButtons.set(id, disarm);
  button.addEventListener('click', () => {
    if (timer) { disarm(); action(); return; }
    button.textContent = armedLabel;
    button.classList.add('is-arming');
    timer = setTimeout(disarm, ARM_MS);
  });
}

/** Changer d'écran ou de mode ne doit pas laisser un bouton amorcé derrière soi. */
function disarmAll() {
  for (const disarm of armedButtons.values()) disarm();
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
  $('set-sun').checked = s.get('sunMode');
  $('set-draft').value = s.get('draft_m');
  $('set-margin').value = s.get('margin_m');
  $('set-alarm').checked = s.get('alarmEnabled');
  $('set-alarm-depth').value = s.get('alarmDepth_m');
  $('set-speed-unit').value = s.get('speedUnit');
  $('set-offset').value = s.get('calibrationOffset_m');
  $('set-manual-level').value = s.get('manualLevel') ?? '';
  $('set-transducer').value = s.get('transducer_m');
  $('set-probes').checked = s.get('showProbes');
  $('set-radius').value = s.get('correctionRadius_m');
  refreshBedSourceUi();
  refreshProbesUi();
  refreshZonesUi();

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
  wireSignToggle('btn-cal-sign', 'cal-depth');
  // Le même bouton corrige deux choses différentes selon la carte affichée, et c'est
  // voulu : ce qu'on mesure au sondeur, c'est toujours « de combien cette carte-ci est à
  // côté ». Sur le levé, la grandeur fautive est la cote du levé de 2009 ; sur la carte
  // communautaire, c'est le plan d'eau auquel se rapportent les bandes. Les deux se
  // règlent, mais pas au même endroit — les confondre corromprait l'autre carte.
  $('btn-apply-offset').addEventListener('click', () => {
    const stats = app.calibration.stats(true, app.bed.source);
    if (!stats) return;
    const shift = round2(stats.median);
    const sign = shift > 0 ? '+' : '';
    if (app.bed.source === 'quickdraw') {
      const datum = round2(app.bed.datum + shift);
      app.settings.set('quickdrawDatum_m', datum);
      toast(`Recalage porté à ${datum > 0 ? '+' : ''}${datum} m (${sign}${shift})`);
    } else {
      app.settings.set('calibrationOffset_m', shift);
      toast(`Correction de ${sign}${shift} m appliquée`);
    }
  });
  $('btn-cal-csv').addEventListener('click', () => download('etalonnage.csv', app.calibration.toCsv(), 'text/csv'));
  $('btn-cal-json').addEventListener('click', () => download('etalonnage.json', app.calibration.toJson(), 'application/json'));
  wireArmed('btn-cal-clear', 'Confirmer ?', () => app.calibration.clear());
  app.calibration.addEventListener('change', refreshCalibrationUi);
}

function recordCalibration() {
  const position = app.geo.position;
  if (!position) { toast('Position GPS indisponible'); return; }

  const sounderDepth = readDepthInput('cal-depth');
  if (sounderDepth === null) {
    toast('Saisissez la profondeur lue au sondeur (négative si le fond émerge)'); return;
  }

  const state = currentLevel();
  if (state.value == null) { toast('Cote du lac inconnue'); return; }

  // Altitude du levé 2009 SEUL : le décalage cherché est précisément celui qu'on
  // appliquera ensuite. `altitudeAt()` renverrait la grille de travail, déjà tirée vers
  // les relevés manuels — un étalonnage pris dans un disque de correction mesurerait son
  // écart contre une surface qu'on a soi-même déplacée, donc un résidu rabattu vers zéro.
  const modelBedZ = app.bed.baseAltitudeAt(position.lon, position.lat);
  if (!Number.isFinite(modelBedZ)) { toast('Hors emprise du modèle'); return; }

  app.calibration.add(makeRecord({
    position,
    level: state.value,
    levelSource: state.source,
    modelBedZ,
    sounderDepth,
    transducerDepth: Number($('cal-transducer').value) || 0,
    nearestSounding: app.soundings?.distanceToNearest(position.lon, position.lat) ?? Infinity,
    bedSource: app.bed.source,
    bedDatum: app.bed.datum,
  }));

  setDepthInput('cal-depth');
  toast(`Relevé enregistré · ${depthLabel(sounderDepth)}`);
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

/**
 * Second verdict : la forme du résidu. Un décalage de référence est constant ; une erreur
 * d'échelle du sondeur croît avec la profondeur. Les deux se ressemblent tant qu'on n'a
 * sondé qu'une bande étroite — et c'est justement là que la constante devient un piège,
 * puisqu'elle serait appliquée à un lac qui descend à 31 m.
 */
function depthVerdict(stats) {
  if (!Number.isFinite(stats.depthMin)) return null;
  const span = `sondé de ${stats.depthMin.toFixed(1)} à ${stats.depthMax.toFixed(1)} m`;

  if (stats.model === 'proportionnel') {
    return ['verdict--spread', `L'écart suit la profondeur (environ ${stats.slopePercent.toFixed(0)} %`
      + ` de la profondeur, ${span}) : ce n'est pas la référence du levé qui est en cause,`
      + ' mais l\'échelle du sondeur. Une constante corrigerait le petit fond et fausserait'
      + ' le large — vérifiez le réglage de vitesse du son.'];
  }
  if (stats.model === 'constant') {
    return ['verdict--ok', `L'écart ne suit pas la profondeur (${span}) : un décalage constant`
      + ' est bien le bon modèle.'];
  }
  return ['verdict--wait', `Impossible encore de distinguer un décalage constant d'une erreur`
    + ` proportionnelle à la profondeur (${span}) : relevez aussi en eau nettement plus`
    + ' profonde, sans quoi la correction sera fausse au large.'];
}

function refreshCalibrationUi() {
  // Les résidus se comptent par carte : un écart mesuré contre le levé ne corrige pas la
  // carte communautaire, et l'inverse est tout aussi faux.
  const stats = app.calibration.stats(true, app.bed?.source);
  const container = $('cal-stats');
  const apply = $('btn-apply-offset');

  if (!stats) {
    container.innerHTML = '<p class="hint">Aucun relevé.</p>';
    apply.disabled = true;
  } else {
    // Premier verdict : la dispersion seule. Conclure ici « c'est bien un décalage de
    // référence » contredirait le second quand la forme du résidu n'est pas tranchée —
    // sur un outil de navigation, deux verdicts qui se contredisent ne valent rien.
    const verdict = stats.count < 5
      ? ['verdict--wait', `Encore ${5 - stats.count} relevé(s) pour conclure.`]
      : stats.iqr > 1.0
        ? ['verdict--spread', `Écarts dispersés (interquartile ${stats.iqr.toFixed(2)} m) : `
          + (stats.model === 'proportionnel'
            ? 'ils suivent la profondeur — voir ci-dessous.'
            : "le problème est l'interpolation, pas la référence. Aucune constante ne le corrigera.")]
        : ['verdict--ok', `Écarts groupés (interquartile ${stats.iqr.toFixed(2)} m) : les relevés sont cohérents entre eux.`];

    const shape = depthVerdict(stats);
    container.innerHTML = `
      <div class="big-number">${stats.median > 0 ? '+' : ''}${stats.median.toFixed(2)} m</div>
      <p class="hint">Médiane des écarts sur ${stats.count} relevé(s)
        ${stats.trustedCount ? `dont ${stats.trustedCount} sur trace` : ''} ·
        étendue ${stats.min.toFixed(2)} à ${stats.max.toFixed(2)} m</p>
      <p class="verdict ${verdict[0]}">${verdict[1]}</p>
      ${shape ? `<p class="verdict ${shape[0]}">${shape[1]}</p>` : ''}`;
    apply.disabled = !stats.usable;
  }

  // Dire sur quelle carte on mesure, et ce que « Appliquer » corrigera : le même bouton
  // règle la cote du levé de 2009 ou le recalage de la carte communautaire.
  const community = app.bed?.source === 'quickdraw';
  const mine = app.calibration.forBed(app.bed?.source).length;
  const other = app.calibration.records.length - mine;
  $('cal-bed').innerHTML = `Carte mesurée : <strong>${BED_SOURCES[app.bed?.source ?? DEFAULT_BED_SOURCE].label}</strong>`
    + ` — ${mine} relevé(s)${other ? `, ${other} sur l'autre carte, non comptés` : ''}.`
    + (community
      ? ` « Appliquer » reportera la médiane sur le <em>recalage</em> de cette carte`
        + ` (actuellement ${app.bed.datum > 0 ? '+' : ''}${app.bed.datum.toFixed(2)} m).`
      : ' « Appliquer » corrigera la cote du levé de 2009.');
  apply.textContent = community ? 'Appliquer au recalage' : 'Appliquer la correction';

  const list = $('cal-records');
  list.replaceChildren(...app.calibration.records.slice().reverse().map((r) => {
    const item = document.createElement('li');
    const when = new Date(r.at).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
    const bed = r.bedSource ?? DEFAULT_BED_SOURCE;
    item.innerHTML = `<span class="residual">${r.residual > 0 ? '+' : ''}${r.residual.toFixed(2)} m</span>
      <span class="tag ${r.onTrack ? 'tag--on' : 'tag--off'}">${r.onTrack ? 'sur trace' : 'hors trace'}</span>
      ${bed === (app.bed?.source ?? DEFAULT_BED_SOURCE) ? '' : `<span class="tag tag--off">${BED_SOURCES[bed]?.label ?? bed}</span>`}
      <span class="hint">${r.sounderDepth < 0 ? `${depthLabel(r.sounderDepth)} (à pied)` : `${depthLabel(r.sounderDepth)} au sondeur`} · ${when}</span>`;
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
  wireArmed('btn-cap-delete', 'Sûr ?', deleteEditedProbe);
  $('btn-cap-cancel').addEventListener('click', () => { clearPin(); endProbeEdit(); });
  wireSignToggle('btn-cap-sign', 'cap-input');
  app.lakeMap.addEventListener('probeselect', (event) => beginProbeEdit(event.detail));

  // Bouton d'édition (fabs) : déploie ou replie la barre de saisie, encombrante en
  // navigation seule. Fermer annule aussi une correction en cours.
  $('btn-saisie').addEventListener('click', () => {
    app.captureOpen = !app.captureOpen;
    if (!app.captureOpen) { clearPin(); if (app.editingProbeId) endProbeEdit(); }
    refreshCaptureUi();
  });

  bind('set-transducer', 'change', (el) => app.settings.set('transducer_m', clampNumber(el, 0, 2)));
  bind('set-probes', 'change', (el) => app.settings.set('showProbes', el.checked));
  bind('set-radius', 'change', (el) => app.settings.set('correctionRadius_m', Math.round(clampNumber(el, 1, 200))));

  // Le rayon de la sonde en cours de correction s'applique sans attendre « Enregistrer » :
  // c'est un réglage qu'on juge à l'œil, sur la carte, en le faisant varier.
  bind('cap-radius', 'change', (el) => {
    if (!app.editingProbeId) return;
    app.probes.update(app.editingProbeId, { radius_m: Math.round(clampNumber(el, 1, 200)) });
  });

  $('btn-probe-csv').addEventListener('click', () => download('relieflac-sondes.csv', app.probes.toCsv(), 'text/csv'));
  $('btn-probe-geojson').addEventListener('click', () => download('relieflac-sondes.geojson', app.probes.toGeoJson(), 'application/geo+json'));
  wireArmed('btn-probe-clear', 'Confirmer ?', () => {
    if (!app.probes.count) return;
    endProbeEdit();
    app.probes.clear();
  });

  app.probes.addEventListener('change', () => {
    refreshProbesUi();
    refreshProbesOnMap();
    applyModelCorrections(); // une sonde relevée corrige la carte en direct
    if (!app.suppressPush) scheduleSyncPush(); // et se partage
  });
}

/**
 * Barre de saisie : visible seulement si demandée, et jamais pendant la simulation ou le
 * tracé — sauf si un point a été désigné et attend sa profondeur, auquel cas elle s'impose.
 * Sans cette exception, un clic droit posé depuis le mode « Étiage » laisserait sur la carte un
 * point qu'aucune commande visible ne permettrait plus de renseigner.
 */
function refreshCaptureUi() {
  const open = Boolean(app.pin) || (app.captureOpen && !app.simMode && !app.zoneMode);
  $('capture').hidden = !open;
  $('btn-saisie').classList.toggle('is-on', open);
  // Le rayon d'influence ne concerne qu'un point existant : à la création, la sonde prend
  // le réglage par défaut, et on l'ajuste ensuite en la voyant déformer la carte.
  $('cap-radius-box').hidden = !app.editingProbeId;
  // Une correction en cours comme un point désigné s'abandonnent : dans les deux cas la
  // barre attend une décision, et il faut pouvoir en sortir sans rien enregistrer.
  $('btn-cap-cancel').hidden = !app.editingProbeId && !app.pin;
  stackBottomBars();
}

/**
 * Empile les barres flottantes du bas d'écran, chacune au-dessus de la précédente.
 *
 * Elles visent toutes le même ancrage — juste au-dessus de la barre de profondeur — et se
 * recouvraient dès que deux d'entre elles s'ouvraient ensemble, ce qui arrive dans le cas
 * le plus courant : descendre la cote au mode « Étiage » pour voir ce qui découvre, puis en faire
 * le tour. On mesure la hauteur réelle de chacune plutôt que de deviner une marge, que la
 * ligne de sélection du mode « Étiage » démentirait dès qu'elle paraît.
 */
function stackBottomBars() {
  let offset = 0;
  for (const id of ['sim', 'zone', 'capture']) {
    const element = $(id);
    if (element.hidden) continue;
    element.style.bottom = offset
      ? `calc(var(--dock) + .5rem + ${offset}px)`
      : '';
    offset += element.offsetHeight + 8;
  }
  liftRail(offset);
}

/**
 * Remonte le rail de caméra au-dessus des barres ouvertes.
 *
 * Le rail est ancré sur le dock, et les panneaux de correction visent le même ancrage :
 * ouvrir « Relever » posait la barre de saisie par-dessus le bouton Outils, donc par-dessus
 * le seul moyen de ressortir du mode. La hauteur de la pile est déjà mesurée juste au-dessus,
 * il suffit de la publier — le rail la lit dans `--stack`.
 *
 * Quand la place manque en haut, on replie d'abord la capsule de zoom plutôt que de laisser
 * le rail glisser sous le bandeau de cap : c'est le contrôle le plus remplaçable, le
 * pincement fait la même chose, alors que le bouton Outils, lui, n'a pas de substitut.
 */
function liftRail(stack) {
  const rail = document.querySelector('.rail');
  const view = $('vue-carte');
  if (!rail || !view) return;

  const strip = document.querySelector('.navstrip')?.offsetHeight ?? 0;
  const dock = document.querySelector('.dock')?.offsetHeight ?? 0;
  const room = () => view.clientHeight - strip - dock - rail.offsetHeight - 18;

  rail.classList.remove('is-compact');
  if (stack > room()) rail.classList.add('is-compact');
  const lift = Math.max(0, Math.min(stack, room()));
  document.documentElement.style.setProperty('--stack', `${lift}px`);
}

// ------------------------------------------- point désigné à la main (sans GPS)

/**
 * Pose un point à l'endroit montré, en attente de sa profondeur.
 *
 * Sans cela l'application est inutilisable ailleurs que sur l'eau : `recordProbe` exige une
 * position GPS, qu'un ordinateur de bureau n'a pas. On désigne donc l'endroit au lieu d'y
 * aller — et le relevé qui en sort porte la marque de cette provenance jusque dans le
 * fichier partagé (voir `makeProbe`, `CorrectionsSync.toFile`).
 */
function placePin(lngLat) {
  app.pin = { lon: lngLat.lng, lat: lngLat.lat, accuracy: null };
  app.captureOpen = true;
  if (app.editingProbeId) endProbeEdit();
  refreshCaptureUi();
  app.lakeMap.setPin(lngLat);

  const depth = depthAt(app.pin.lon, app.pin.lat);
  $('cap-input').focus();
  toast(Number.isFinite(depth)
    ? `Point posé · la carte y annonce ${depth > 0 ? `${depth.toFixed(1)} m` : 'un fond émergé'} — saisissez la valeur`
    : 'Point posé hors emprise du modèle');
}

function clearPin() {
  if (!app.pin) return;
  app.pin = null;
  app.lakeMap.setPin(null);
  refreshCaptureUi();
}

// -------------------------------------------------------- correction d'une sonde

function beginProbeEdit(id) {
  const record = app.probes.get(id);
  if (!record) return;

  clearPin(); // corriger un point existant abandonne celui qu'on venait de désigner
  app.editingProbeId = id;
  app.captureOpen = true; // corriger un point exige la barre de saisie déployée
  refreshCaptureUi();
  location.hash = '#/'; // ramène sur la carte si l'on éditait depuis la liste des réglages

  const input = $('cap-input');
  setDepthInput('cap-input', record.sounderDepth);
  $('cap-radius').value = Probes.radiusOf(record, app.settings.get('correctionRadius_m'));
  $('btn-capture').textContent = 'Enregistrer';
  $('btn-cap-delete').hidden = false;
  $('capture').classList.add('is-editing');
  refreshCaptureUi();

  refreshProbesOnMap();
  input.focus();
  input.select?.();
  toast('Corrigez la profondeur, ou supprimez le point');
}

function endProbeEdit() {
  app.editingProbeId = null;
  disarmAll();
  const input = $('cap-input');
  setDepthInput('cap-input');
  input.blur();
  $('btn-capture').textContent = 'Relever';
  $('btn-cap-delete').hidden = true;
  $('capture').classList.remove('is-editing');
  refreshCaptureUi();
  refreshProbesOnMap();
}

function saveProbeEdit() {
  const depth = readDepthInput('cap-input');
  if (depth === null) { toast('Saisissez une profondeur valide'); return; }
  app.probes.update(app.editingProbeId, {
    sounderDepth: depth,
    radius_m: Math.round(clampNumber($('cap-radius'), 1, 200)),
  });
  endProbeEdit();
  toast(`Sonde corrigée : ${depthLabel(depth)}`);
}

function deleteEditedProbe() {
  if (!app.editingProbeId) return;
  const id = app.editingProbeId;
  endProbeEdit();
  app.probes.remove(id);
  toast('Sonde supprimée');
}

function recordProbe() {
  // Le point désigné à la main l'emporte sur le GPS : quand il y en a un, c'est qu'on a
  // explicitement montré l'endroit, y compris sur un ordinateur qui n'a aucune position.
  const pinned = Boolean(app.pin);
  const position = app.pin ?? app.geo.position;
  if (!position) {
    toast('Position GPS indisponible — clic droit sur la carte pour désigner un point', 5000);
    return;
  }

  const input = $('cap-input');
  const depth = readDepthInput('cap-input');
  if (depth === null) { toast('Saisissez la profondeur lue au sondeur (négative si le fond émerge)'); return; }

  const state = currentLevel();
  if (state.value == null) { toast('Cote du lac inconnue — impossible de caler la sonde'); return; }

  app.probes.add(makeProbe({
    position,
    level: state.value,
    levelSource: state.source,
    sounderDepth: depth,
    transducerDepth: app.settings.get('transducer_m'),
    radius_m: app.settings.get('correctionRadius_m'),
    fixSource: pinned ? 'map' : 'gps',
    // Comparaison au levé 2009 BRUT (sinon on comparerait la sonde à une carte déjà
    // corrigée par les sondes précédentes — un écart artificiellement nul).
    modelBedZ: app.bed.baseAltitudeAt(position.lon, position.lat),
  }));

  clearPin();
  setDepthInput('cap-input');
  input.blur(); // referme le clavier tactile pour dégager la carte
  toast(`Sonde ${depthLabel(depth)} enregistrée${pinned ? ' au point désigné' : ''} · ${app.probes.count} au total`);
}

/**
 * Lit un champ de profondeur saisi à la main, ou `null` si la saisie n'est pas une mesure.
 *
 * Le négatif est admis : c'est un haut-fond découvert, relevé à pied, dont on saisit la
 * hauteur au-dessus de l'eau. Le zéro, lui, est refusé — non parce qu'un fond affleurant
 * serait absurde, mais parce que `Number('')` vaut zéro : sans ce garde-fou, un champ vide
 * passerait pour une mesure à ras du plan d'eau. Pour un caillou qui affleure vraiment,
 * ±0,05 dit la même chose sans ambiguïté.
 *
 * Les bornes ne servent qu'à intercepter la faute de frappe : le lac plafonne à 31 m, et
 * une rive découverte de plus de 10 m au-dessus de l'étiage n'est plus un haut-fond.
 */
function readDepthInput(id) {
  const raw = $(id).value.trim();
  if (raw === '') return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value === 0 || value < -10 || value > 60) return null;
  return value;
}

/**
 * Écrit dans un champ de profondeur en gardant sa bascule « ± » en phase : une écriture
 * par script n'émet pas d'événement `input`, et le bouton resterait allumé après une
 * capture — le relevé suivant partirait avec un signe fantôme.
 */
function setDepthInput(id, value = '') {
  const input = $(id);
  input.value = value === '' ? '' : String(value);
  input.dispatchEvent(new Event('input'));
}

/** « 3,2 m » sous l'eau, « +0,4 m émergé » au-dessus : le signe seul serait illisible. */
function depthLabel(depth) {
  return depth < 0 ? `+${(-depth).toFixed(1)} m émergé` : `${depth.toFixed(1)} m`;
}

/**
 * Bouton « ± » d'un champ de profondeur.
 *
 * Le pavé numérique d'iOS n'a pas de touche « moins ». Sans ce bouton, la saisie d'un
 * haut-fond émergé serait impossible précisément là où elle sert : les pieds dans l'eau,
 * hors de portée d'un clavier complet.
 *
 * On inverse la valeur déjà saisie plutôt que d'armer un mode : ce qui est affiché reste
 * ce qui sera enregistré. Un champ `type="number"` refuse un « − » seul (l'algorithme de
 * normalisation le vide), donc sur champ vide on ne peut que le dire.
 */
function wireSignToggle(buttonId, inputId) {
  const button = $(buttonId);
  const input = $(inputId);
  const sync = () => button.classList.toggle('is-negative', Number(input.value) < 0);
  button.addEventListener('click', () => {
    const raw = input.value.trim();
    if (raw === '') { input.focus(); toast('Saisissez la hauteur, puis ± pour un fond émergé'); return; }
    const value = Number(raw);
    if (Number.isFinite(value)) input.value = String(-value);
    sync();
    input.focus();
  });
  input.addEventListener('input', sync);
}

/** Recalcule la profondeur affichée depuis la cote courante, comme le reste de la carte. */
function refreshProbesOnMap() {
  if (!app.probes || !app.lakeMap) return;
  if (!app.settings.get('showProbes')) { app.lakeMap.setProbes([]); return; }

  const level = currentLevel().value;
  const points = app.probes.records.map((r) => {
    const depth = Number.isFinite(level) && Number.isFinite(r.bedZ) ? level - r.bedZ : r.sounderDepth;
    // Un haut-fond découvert affiché « 0 » se lirait « affleurant » : c'est justement
    // l'obstacle qu'on vient de relever à pied, et sa hauteur mérite son signe.
    const emerged = Number.isFinite(depth) && depth <= 0;
    return {
      id: r.id,
      lon: r.lon,
      lat: r.lat,
      emerged,
      label: !Number.isFinite(depth) ? '?' : emerged ? `+${(-depth).toFixed(1)}` : depth.toFixed(1),
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
    item.innerHTML = `<span class="residual">${depthLabel(r.sounderDepth)}</span>
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
  // Sur le ruban lui-même, et non sur tout le bandeau : celui-ci porte désormais la cote,
  // dont le toucher mène aux réglages et n'a rien à voir avec la boussole.
  $('compass-tap').addEventListener('click', ask);

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
  // Le cap ne s'écrit plus qu'à un seul endroit : le ruban et sa pastille de degrés. La
  // tuile qui le répétait dans le dock ne faisait que rétrécir les deux valeurs voisines.
  scheduleMapHeading();
}

// La boussole émet à haute fréquence ; on ne fait tourner la carte qu'une fois par image
// pour rester fluide sans saturer le rendu.
let headingRaf = 0;
function scheduleMapHeading() {
  if (headingRaf) return;
  headingRaf = requestAnimationFrame(() => {
    headingRaf = 0;
    if (app.lakeMap && Number.isFinite(app.heading)) app.lakeMap.setHeading(app.heading);
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
  wireArmed('btn-sim-clear', 'Confirmer ?', () => {
    if (!app.sim.count) return;
    endSimEdit();
    app.sim.clear();
  });
  $('sim-slider').addEventListener('input', (e) => setSimLevel(Number(e.target.value)));

  // « + » = plus profond : la profondeur mesurée augmente, donc le fond (bedZ) descend.
  $('btn-sim-up').addEventListener('click', () => nudgeSimPoint(-0.25));
  $('btn-sim-down').addEventListener('click', () => nudgeSimPoint(0.25));
  $('btn-sim-del').addEventListener('click', deleteSimPoint);
  bind('sim-radius', 'change', (el) => {
    if (!app.editingSimId) return;
    app.sim.update(app.editingSimId, { radius_m: Math.round(clampNumber(el, 1, 200)) });
  });
  app.lakeMap.addEventListener('simselect', (event) => selectSimPoint(event.detail));

  app.sim.addEventListener('change', () => {
    applyModelCorrections(); // les points de simulation corrigent la carte localement
    refreshSimOnMap();
    refreshSimReadout();
    // Volontairement pas de synchro : le mode « Étiage » est un bac à sable local ; seules
    // les sondes « Relever » sont partagées.
  });
}

/**
 * Reporte les relevés sur la grille et renvoie la texture corrigée au GPU. La correction
 * s'applique en permanence — pas seulement en mode simulation — pour que la carte affichée
 * en navigation soit bien la « 2009 corrigée ».
 *
 * Trois sources se cumulent, toutes porteuses d'une altitude de fond invariante `bedZ` :
 * les sondes « Relever » (mesures réelles, partagées), les points d'étiage simulé
 * (locaux) et les zones émergées (contours tracés à la main).
 * Chacune porte son propre rayon d'influence — largeur du fondu au-delà du bord pour une
 * zone — ou hérite du réglage général quand elle n'en a pas.
 */
function correctionRecords() {
  const fromProbes = (app.probes?.records ?? [])
    .filter((p) => Number.isFinite(p.bedZ))
    .map((p) => ({ lon: p.lon, lat: p.lat, bedZ: p.bedZ, radius_m: p.radius_m ?? null }));
  const fromSim = app.sim?.records ?? [];
  const fromZones = (app.zones?.records ?? [])
    .filter((z) => Number.isFinite(z.bedZ))
    .map((z) => ({ ring: z.ring, bedZ: z.bedZ, radius_m: z.feather_m ?? DEFAULT_FEATHER_M }));
  return [...fromProbes, ...fromSim, ...fromZones];
}

function applyModelCorrections() {
  if (!app.bed || !app.depthLayer) return;
  app.bed.applyCorrections(correctionRecords(), app.settings.get('correctionRadius_m'));
  app.depthLayer.updateBed();
}

/**
 * Change de fond bathymétrique si le réglage ne correspond plus à ce qui est chargé.
 *
 * Les deux grilles partagent la maille : l'échange se fait tableau contre tableau, sans
 * reconstruire la couche WebGL ni bouger la carte. Restent à refaire les relevés manuels,
 * qui portent une altitude absolue et valent donc pour l'un comme pour l'autre.
 *
 * Un fond absent du déploiement ne doit pas laisser l'application dans un état ambigu :
 * on remet alors le réglage sur le fond réellement affiché, plutôt que d'afficher une
 * carte qui n'est pas celle annoncée.
 */
async function applyBedSource(announce = false) {
  const wanted = app.settings.get('bedSource');
  if (!app.bed || app.bed.source === wanted) return;
  try {
    if (await app.bed.useSource(wanted)) {
      app.bed.setDatumOffset(app.settings.get('quickdrawDatum_m'));
      applyModelCorrections();
      refreshBedSourceUi();
      refreshCalibrationUi();
      refreshDepthStyle();
      if (announce) toast(`Fond : ${BED_SOURCES[app.bed.source].label}`);
    }
  } catch (err) {
    toast(`Fond indisponible : ${err.message}`, 6000);
    app.settings.set('bedSource', app.bed.source);
  }
}

/** Rappelle partout quelle carte est sous les pieds : réglages et page « À propos ». */
function refreshBedSourceUi() {
  if (!app.bed) return;
  const source = BED_SOURCES[app.bed.source];
  const meta = app.bed.meta;
  $('set-bed-source').value = app.bed.source;
  const community = app.bed.source === 'quickdraw';
  $('hint-bed-source').textContent = community
    ? `Affiché : ${meta.quickdraw_only?.framed_ha ?? '—'} ha encadrés par la communauté `
      + `(${Math.round((meta.coverage_ratio ?? 0) * 100)} % du lac), largeur d'encadrement `
      + `médiane ${meta.quickdraw_only?.envelope_median_m ?? '—'} m. Aucune sonde de 2009.`
    : `Affiché : levé OFB 2009 relevé par le MNT et encadré par la communauté, `
      + `sonde à ${meta.coverage?.median_m ?? '—'} m en médiane.`;

  // Le recalage ne concerne que la carte communautaire : sur le levé, le bloc disparaît
  // plutôt que de rester là, grisé, à laisser croire qu'il pourrait s'appliquer.
  $('bloc-recalage').hidden = !community || !meta.quickdraw_only;
  if (community && meta.quickdraw_only) {
    const applied = app.bed.datum;
    const built = app.bed.builtInDatum;
    const zAc = meta.quickdraw_only.z_ac_m_ngf;
    const field = $('set-qd-datum');
    // On n'écrase pas la saisie en cours : réécrire la valeur pendant que l'utilisateur
    // tape lui déplacerait le curseur à chaque frappe.
    if (document.activeElement !== field) field.value = applied.toFixed(2);
    $('hint-qd-datum').textContent =
      `Plan d'eau de référence : ${(zAc + applied).toFixed(2)} m NGF `
      + `(mesuré ${zAc.toFixed(2)}, recalé de ${applied > 0 ? '+' : ''}${applied.toFixed(2)} m). `
      + (Math.abs(applied - built) < 0.005
        ? "C'est la valeur d'origine du fichier."
        : `Réglage local — le fichier dit ${built > 0 ? '+' : ''}${built.toFixed(2)} m.`);
  }

  $('apropos-version').textContent = `${VERSION} · fond ${source.label} `
    + `· grille ${app.bed.width}×${app.bed.height}`;
}

/**
 * Reporte le recalage réglé à la main sur la grille en mémoire.
 *
 * Rien n'est retéléchargé : la grille du fichier reste intacte et l'on ne déplace que les
 * cellules issues d'une bande, puis on réapplique les relevés manuels par-dessus. C'est ce
 * qui permet de chercher la bonne valeur sur l'eau, en regardant le trait de côte bouger.
 */
function applyBedDatum(announce = false) {
  if (!app.bed || !app.depthLayer) return;
  if (!app.bed.setDatumOffset(app.settings.get('quickdrawDatum_m'))) return;
  applyModelCorrections();
  refreshBedSourceUi();
  if (announce) {
    const applied = app.bed.datum;
    toast(`Recalage ${applied > 0 ? '+' : ''}${applied.toFixed(2)} m — plan d'eau `
      + `${(app.bed.meta.quickdraw_only.z_ac_m_ngf + applied).toFixed(2)} m NGF`);
  }
}

function enterSim() {
  app.simMode = true;
  // Cote réelle du moment, référence des écarts ; et réglage manuel d'avant la simulation,
  // à restaurer en sortie pour ne pas détourner durablement l'affichage.
  app.simEnteredWithManual = app.settings.get('manualLevel');
  app.simBaseLevel = round2(currentLevel().value ?? app.model.lake.normal_level_m_ngf);
  // Déposé AVANT le premier mouvement du curseur : si l'application est fermée en cours de
  // simulation, c'est ce marqueur qui permettra au démarrage suivant de ne pas prendre une
  // cote de simulation pour la cote du lac.
  app.settings.update({
    manualFromSim: true,
    manualBeforeSim: app.simEnteredWithManual ?? null,
  });
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
  disarmAll();
  $('btn-sim').classList.remove('is-on');
  $('sim').hidden = true;
  refreshCaptureUi();
  $('sim-sel').hidden = true;
  app.settings.update({
    manualLevel: app.simEnteredWithManual ?? null,
    manualFromSim: false,
    manualBeforeSim: null,
  });
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
  const entry = app.sim.add({
    lon, lat, bedZ, depth_m: depth,
    cote_m: Number.isFinite(cote) ? round2(cote) : null,
    radius_m: app.settings.get('correctionRadius_m'),
  });
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
  stackBottomBars(); // la ligne de sélection change la hauteur du panneau
  if (!record) return;
  const level = currentLevel().value;
  const depth = Number.isFinite(level) ? level - record.bedZ : NaN;
  const head = !Number.isFinite(depth)
    ? `Fond ${record.bedZ.toFixed(2)} m NGF`
    : depth <= 0
      ? `Émergé de ${(-depth).toFixed(1)} m`
      : `${depth.toFixed(1)} m d'eau`;
  $('sim-sel-label').textContent = `${head} · fond ${record.bedZ.toFixed(2)} m NGF`;
  $('sim-radius').value = Number.isFinite(record.radius_m) && record.radius_m > 0
    ? record.radius_m
    : app.settings.get('correctionRadius_m');
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

// ------------------------------------------------------------ zones émergées

/** En dessous, un contour n'a plus de surface : c'est un point, et il y a l'outil pour. */
const MIN_ZONE_VERTICES = 3;

function wireZones() {
  $('btn-zone').addEventListener('click', () => (app.zoneMode ? exitZoneMode() : enterZoneMode()));
  $('btn-zone-exit').addEventListener('click', exitZoneMode);
  $('btn-zone-new').addEventListener('click', startZoneDraft);
  $('btn-zone-undo').addEventListener('click', undoZoneVertex);
  $('btn-zone-cancel').addEventListener('click', cancelZoneDraft);
  $('btn-zone-close').addEventListener('click', () => {
    if (app.editingZoneId) endZoneEdit(); else closeZoneDraft();
  });
  wireArmed('btn-zone-del', 'Confirmer ?', deleteSelectedZone);

  // Hauteur et fondu : mémorisés d'une zone à l'autre (on trace rarement un seul îlot), et
  // appliqués sans attendre quand une zone est sélectionnée — on juge le résultat sur la carte.
  bind('zone-height', 'change', (el) => {
    const height = clampNumber(el, -5, 15);
    app.settings.set('zoneHeight_m', round2(height));
    if (app.editingZoneId) app.zones.update(app.editingZoneId, { height_m: round2(height) });
  });
  bind('zone-feather', 'change', (el) => {
    const feather = Math.round(clampNumber(el, 0, 60));
    app.settings.set('zoneFeather_m', feather);
    if (app.editingZoneId) app.zones.update(app.editingZoneId, { feather_m: feather });
  });

  bind('set-zones', 'change', (el) => app.settings.set('showZones', el.checked));
  $('btn-zone-geojson').addEventListener('click', () => download('relieflac-zones.geojson', app.zones.toGeoJson(), 'application/geo+json'));
  wireArmed('btn-zone-clear', 'Confirmer ?', () => {
    if (!app.zones.count) return;
    endZoneEdit();
    app.zones.clear();
  });

  app.zones.addEventListener('change', () => {
    applyModelCorrections(); // une zone corrige la carte comme un relevé
    refreshZonesOnMap();
    refreshZonesUi();
    refreshZonePanel();
    // Volontairement pas de synchronisation : une zone est une interprétation, et le
    // fichier partagé ne transporte que des points mesurés.
  });
}

/**
 * Ouvre le panneau des zones — **sans** commencer à tracer.
 *
 * C'est la correction du défaut signalé : le mode démarrait en tracé, si bien que le
 * premier toucher sur la carte posait un sommet. Passé ce sommet, chaque clic suivant en
 * posait un autre, y compris sur un contour existant : la zone ne pouvait plus être
 * reprise, donc plus être supprimée, et rien à l'écran n'expliquait pourquoi. Reprendre et
 * tracer sont deux intentions ; elles ont maintenant deux états et deux boutons.
 */
function enterZoneMode() {
  app.zoneMode = true;
  app.zoneTracing = false;
  app.zoneDraft = [];
  app.editingZoneId = null;
  if (app.editingProbeId) endProbeEdit();
  clearPin();
  refreshCaptureUi(); // en mode zone, la barre de saisie encombre pour rien
  $('zone-height').value = app.settings.get('zoneHeight_m');
  $('zone-feather').value = app.settings.get('zoneFeather_m');
  refreshZonePanel();
  toast(app.zones.count
    ? 'Touchez un contour pour le reprendre, ou tracez-en un nouveau'
    : 'Aucune zone : « ✚ Nouvelle zone » pour en tracer une', 4000);
}

function exitZoneMode() {
  app.zoneMode = false;
  app.zoneTracing = false;
  app.zoneDraft = [];
  app.editingZoneId = null;
  disarmAll();
  refreshZonePanel();
  refreshZonesOnMap();
  refreshCaptureUi();
}

function startZoneDraft() {
  app.zoneTracing = true;
  app.zoneDraft = [];
  app.editingZoneId = null;
  app.lakeMap.setZoneDraft([]);
  refreshZonePanel();
  toast('Posez les sommets ; clic droit, double-clic ou ✓ pour fermer', 4000);
}

function cancelZoneDraft() {
  app.zoneTracing = false;
  app.zoneDraft = [];
  app.lakeMap.setZoneDraft([]);
  refreshZonePanel();
}

function addZoneVertex(lngLat) {
  app.zoneDraft.push([lngLat.lng, lngLat.lat]);
  app.lakeMap.setZoneDraft(app.zoneDraft);
  refreshZonePanel();
}

function undoZoneVertex() {
  app.zoneDraft.pop();
  app.lakeMap.setZoneDraft(app.zoneDraft);
  refreshZonePanel();
}

/** Referme le contour et enregistre la zone. */
function closeZoneDraft() {
  const ring = dedupeRing(app.zoneDraft);
  if (ring.length < MIN_ZONE_VERTICES) {
    toast(`Il faut au moins ${MIN_ZONE_VERTICES} sommets pour délimiter une zone`);
    return;
  }
  const state = currentLevel();
  if (state.value == null) { toast('Cote du lac inconnue — impossible de caler la zone'); return; }

  const height = round2(clampNumber($('zone-height'), -5, 15));
  const entry = app.zones.add({
    ring,
    // L'altitude du sol, invariante : c'est elle qu'on garde, jamais la hauteur d'eau.
    bedZ: round2(groundAltitude(state.value, height)),
    height_m: height,
    cote_m: round2(state.value),
    feather_m: Math.round(clampNumber($('zone-feather'), 0, 60)),
  });

  app.zoneTracing = false;
  app.zoneDraft = [];
  app.lakeMap.setZoneDraft([]);
  selectZone(entry.id);
  toast(`Zone de ${formatArea(ringArea(ring))} · sol à ${entry.bedZ.toFixed(2)} m NGF`, 4000);
}

function selectZone(id) {
  if (!app.zones.get(id)) return;
  app.zoneMode = true;
  app.zoneTracing = false;
  app.zoneDraft = [];
  app.editingZoneId = app.editingZoneId === id ? null : id;
  const zone = app.editingZoneId ? app.zones.get(id) : null;
  if (zone) {
    $('zone-height').value = zone.height_m ?? app.settings.get('zoneHeight_m');
    $('zone-feather').value = zone.feather_m ?? app.settings.get('zoneFeather_m');
  }
  refreshCaptureUi();
  refreshZonePanel();
  refreshZonesOnMap();
}

function endZoneEdit() {
  app.editingZoneId = null;
  disarmAll();
  refreshZonePanel();
  refreshZonesOnMap();
}

function deleteSelectedZone() {
  if (!app.editingZoneId) return;
  const id = app.editingZoneId;
  endZoneEdit();
  app.zones.remove(id);
  toast('Zone supprimée');
}

/**
 * Unique endroit où l'état du panneau de zone est rendu. Trois états s'y succèdent :
 * la **liste** des zones posées, le **tracé** d'un nouveau contour, et le **réglage** de la
 * zone reprise. Un seul est visible à la fois, et chacun ne montre que ses propres commandes.
 */
function refreshZonePanel() {
  const zone = app.editingZoneId ? app.zones.get(app.editingZoneId) : null;
  const tracing = app.zoneMode && app.zoneTracing && !zone;
  const listing = app.zoneMode && !tracing && !zone;

  $('zone').hidden = !app.zoneMode;
  $('btn-zone').classList.toggle('is-on', app.zoneMode);
  $('btn-zone').setAttribute('aria-pressed', String(app.zoneMode));
  app.lakeMap.setZoneMode(app.zoneMode, tracing);
  if (!app.zoneMode) return;

  $('zone-title').textContent = zone ? 'Zone sélectionnée' : listing ? 'Zones émergées' : 'Nouvelle zone';
  $('zone-list').hidden = !listing;
  $('zone-fields').hidden = listing;
  $('btn-zone-new').hidden = !listing;
  $('btn-zone-undo').hidden = !tracing;
  $('btn-zone-cancel').hidden = !tracing;
  $('btn-zone-close').hidden = listing;
  $('btn-zone-del').hidden = !zone;
  $('btn-zone-close').textContent = zone ? '✓ Terminer' : '✓ Fermer la zone';
  $('btn-zone-close').disabled = !zone && dedupeRing(app.zoneDraft).length < MIN_ZONE_VERTICES;
  $('btn-zone-undo').disabled = app.zoneDraft.length === 0;

  if (zone) {
    const level = currentLevel().value;
    const depth = Number.isFinite(level) ? level - zone.bedZ : NaN;
    const state = !Number.isFinite(depth)
      ? 'cote inconnue'
      : depth <= 0
        ? `émergée de ${(-depth).toFixed(1)} m à la cote du jour`
        : `sous ${depth.toFixed(1)} m d'eau à la cote du jour`;
    $('zone-hint').textContent = 'Réglez la hauteur du sol, ou supprimez la zone.';
    $('zone-meta').textContent = `${formatArea(ringArea(zone.ring))} · sol à `
      + `${zone.bedZ.toFixed(2)} m NGF · ${state} · tracée à la cote `
      + `${Number.isFinite(zone.cote_m) ? zone.cote_m.toFixed(2) : '—'}`;
  } else if (tracing) {
    const count = app.zoneDraft.length;
    $('zone-hint').textContent = count === 0
      ? 'Touchez la carte pour poser les sommets du contour.'
      : 'Clic droit, double-clic ou ✓ pour refermer le contour.';
    $('zone-meta').textContent = count < MIN_ZONE_VERTICES
      ? `${count} sommet${count > 1 ? 's' : ''} — il en faut ${MIN_ZONE_VERTICES}`
      : `${count} sommets · ${formatArea(ringArea(app.zoneDraft))}`;
  } else {
    $('zone-hint').textContent = app.zones.count
      ? 'Touchez un contour sur la carte, ou reprenez-le dans la liste.'
      : 'Aucune zone tracée pour l\'instant.';
    $('zone-meta').textContent = '';
    fillZoneList($('zone-list'));
  }
  stackBottomBars();
}

/**
 * Liste des zones posées, dans le panneau de la carte.
 *
 * Elle existe pour qu'une zone ne dépende jamais d'un toucher réussi sur son contour : sur
 * un téléphone qui bouge, viser l'intérieur d'un polygone de quelques pixels est illusoire,
 * et c'est précisément ce qui a rendu la suppression impossible.
 */
function fillZoneList(list) {
  const level = currentLevel().value;
  list.replaceChildren(...app.zones.records.slice().reverse().map((z) => {
    const item = document.createElement('li');
    const depth = Number.isFinite(level) ? level - z.bedZ : NaN;
    const label = document.createElement('span');
    label.textContent = `${formatArea(ringArea(z.ring))} · `
      + (!Number.isFinite(depth) ? '—' : depth <= 0 ? `émergée de ${(-depth).toFixed(1)} m` : `sous ${depth.toFixed(1)} m d'eau`);
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.textContent = '✎';
    edit.title = 'Régler cette zone';
    edit.addEventListener('click', () => selectZone(z.id));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'zone__del';
    remove.textContent = '✕';
    remove.title = 'Supprimer cette zone';
    remove.addEventListener('click', () => {
      app.zones.remove(z.id);
      toast('Zone supprimée');
    });
    item.append(label, edit, remove);
    return item;
  }));
}

/** Contours enregistrés, dans la couleur de terre du préréglage actif. */
function refreshZonesOnMap() {
  if (!app.zones || !app.lakeMap) return;
  if (!app.settings.get('showZones')) { app.lakeMap.setZones([]); return; }
  const color = app.palette.presets[app.settings.get('preset')].emerged_color;
  app.lakeMap.setZones(app.zones.records.map((z) => ({
    id: z.id,
    ring: closeRing(z.ring),
    selected: z.id === app.editingZoneId,
  })), color);
}

function refreshZonesUi() {
  const count = app.zones?.count ?? 0;
  $('zone-count').textContent = count
    ? `${count} zone${count > 1 ? 's' : ''} tracée${count > 1 ? 's' : ''}.`
    : 'Aucune zone tracée.';
  $('btn-zone-geojson').disabled = !count;
  $('btn-zone-clear').disabled = !count;
  $('set-zones').checked = app.settings.get('showZones');

  const level = currentLevel().value;
  const list = $('zone-records');
  list.replaceChildren(...(app.zones?.records ?? []).slice().reverse().map((z) => {
    const item = document.createElement('li');
    const when = new Date(z.at).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
    const depth = Number.isFinite(level) ? level - z.bedZ : NaN;
    const state = !Number.isFinite(depth) ? '—' : depth <= 0 ? `émergée +${(-depth).toFixed(1)} m` : `sous ${depth.toFixed(1)} m d'eau`;
    item.innerHTML = `<span class="residual">${formatArea(ringArea(z.ring))}</span>
      <span class="hint">${state} · sol ${z.bedZ.toFixed(2)} m NGF · ${when}</span>`;

    const edit = document.createElement('button');
    edit.type = 'button';
    edit.textContent = '✎';
    edit.title = 'Régler cette zone sur la carte';
    edit.addEventListener('click', () => { location.hash = '#/'; selectZone(z.id); });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.title = 'Supprimer cette zone';
    remove.addEventListener('click', () => {
      if (app.editingZoneId === z.id) endZoneEdit();
      app.zones.remove(z.id);
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
    refreshBasemapUi();
    toast(next === 'plan' ? 'Plan IGN' : 'Photo aérienne');
  });

  $('btn-soleil').addEventListener('click', () => {
    const on = !app.settings.get('sunMode');
    app.settings.set('sunMode', on);
    toast(on ? 'Plein soleil : contraste maximal' : 'Affichage normal');
  });

  $('btn-zoom-plus').addEventListener('click', () => app.lakeMap.zoomBy(ZOOM_STEP));
  $('btn-zoom-moins').addEventListener('click', () => app.lakeMap.zoomBy(-ZOOM_STEP));
  // Le cadrage est retrouvé à la réouverture : sur l'eau, on ne veut pas refaire ses
  // réglages à chaque démarrage.
  app.lakeMap.addEventListener('zoomchange', (event) => {
    app.settings.set('zoom', round2(event.detail));
  });

  $('btn-suivi').addEventListener('click', () => {
    app.settings.set('followBoat', !app.settings.get('followBoat'));
    refreshCameraUi();
  });

  $('btn-cap').addEventListener('click', () => {
    app.settings.set('trackUp', !app.settings.get('trackUp'));
    refreshCameraUi();
    // « Cap en haut » sans boussole accordée ne sert à rien : on la demande au passage.
    if (app.settings.get('trackUp')) ensureCompass();
  });

  // Faire glisser la carte coupe le suivi : sinon l'écran ramène le bateau au centre
  // à chaque relevé GPS et il devient impossible de regarder devant soi.
  app.lakeMap.addEventListener('userpan', () => {
    if (!app.settings.get('followBoat')) return;
    app.settings.set('followBoat', false);
    refreshCameraUi();
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

  // Clic droit : désigne une position, faute de GPS. En simulation, où le clic simple pose
  // déjà un témoin, il pose une vraie sonde — c'est le seul geste qui les distingue.
  app.lakeMap.addEventListener('pinpoint', (event) => placePin(event.detail));

  // Clic en mode zone, sans ambiguïté possible : pendant un tracé, tout clic pose un
  // sommet ; hors tracé, il reprend le contour touché, ou lâche celui qui l'était.
  app.lakeMap.addEventListener('zonevertex', (event) => {
    const { lngLat, zoneId } = event.detail;
    if (app.zoneTracing) { addZoneVertex(lngLat); return; }
    if (zoneId) { selectZone(zoneId); return; }
    if (app.editingZoneId) endZoneEdit();
  });
  app.lakeMap.addEventListener('zoneclose', closeZoneDraft);

  $('btn-cote').addEventListener('click', () => { location.hash = '#/parametres'; });

  // Rotation de l'écran : la hauteur disponible change, donc la remontée du rail et son
  // repli. Sans cela, un panneau ouvert avant la bascule laisse le rail au mauvais endroit.
  window.addEventListener('resize', stackBottomBars);

  refreshCameraUi();
  refreshBasemapUi();
}

/** La tuile de fond de carte annonce lequel est actif : elle bascule entre deux états. */
function refreshBasemapUi() {
  const plan = app.settings.get('basemap') === 'plan';
  $('fond-label').textContent = plan ? 'Plan IGN' : 'Photo aérienne';
}

// ------------------------------------------------------------- feuille d'outils

/**
 * Feuille « Outils » : tout ce qui ne se touche pas en barrant.
 *
 * Les cinq icônes de l'ancienne barre du haut et les deux FAB d'édition partageaient
 * l'écran avec la carte en permanence pour des gestes qui ne servent pas une fois par
 * heure. Ils sont ici, derrière un bouton, avec un libellé — ce qui règle du même coup la
 * lisibilité des glyphes ▲ et ◎, que personne ne savait interpréter.
 *
 * La feuille se referme sur tout ce qui agit : ouvrir un mode de correction, c'est vouloir
 * la carte, pas rester devant un menu.
 */
function wireTools() {
  const sheet = $('sheet');
  const open = (on) => {
    sheet.hidden = !on;
    $('btn-menu').setAttribute('aria-expanded', String(on));
  };

  $('btn-menu').addEventListener('click', () => open(sheet.hidden));
  $('sheet-scrim').addEventListener('click', () => open(false));
  // Écoute posée sur le conteneur : elle se déclenche après les gestionnaires propres à
  // chaque tuile, quel que soit l'ordre dans lequel les modules ont été câblés.
  sheet.querySelector('.sheet__panel').addEventListener('click', (event) => {
    if (event.target.closest('.tile, .sheet__link')) open(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !sheet.hidden) open(false);
  });
}

/**
 * Navigation rapide des Paramètres : neuf sections, dont trois seulement servent sur l'eau.
 *
 * Des boutons et non des ancres — une ancre écrirait dans `location.hash`, que le routeur
 * lit comme un changement d'écran et qui renverrait à la carte.
 */
function wireQuickNav() {
  const nav = document.querySelector('.quicknav');
  if (!nav) return;
  const buttons = [...nav.querySelectorAll('[data-goto]')];

  nav.addEventListener('click', (event) => {
    const button = event.target.closest('[data-goto]');
    if (!button) return;
    $(button.dataset.goto)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  // La puce de la section visible s'allume : sans cela, la barre indiquerait où aller mais
  // jamais où l'on est, ce qui est précisément ce qu'on cherche dans une page si longue.
  // La marge basse ne retient que le haut de la fenêtre, sinon quatre sections seraient
  // « visibles » à la fois sur un grand écran.
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      buttons.forEach((b) => b.classList.toggle('is-on', b.dataset.goto === entry.target.id));
    });
  }, { rootMargin: '-45% 0px -50% 0px' });
  buttons.forEach((b) => { const section = $(b.dataset.goto); if (section) observer.observe(section); });
}

/**
 * Unique endroit où l'état des deux boutons de caméra est rendu, puis poussé à la carte.
 *
 * Ils se lisaient et s'écrivaient jusqu'ici depuis quatre endroits (le clic de chacun, le
 * glissement de carte, l'initialisation), chacun ne remettant à jour qu'une partie :
 * pastille allumée sans suivi actif, cap en haut oublié après un import de profil… Passer
 * par ici garantit que bouton, réglage et caméra disent toujours la même chose.
 */
function refreshCameraUi() {
  const follow = app.settings.get('followBoat');
  const trackUp = app.settings.get('trackUp');
  $('btn-suivi').classList.toggle('is-on', follow);
  $('btn-suivi').setAttribute('aria-pressed', String(follow));
  $('btn-cap').classList.toggle('is-on', trackUp);
  $('btn-cap').setAttribute('aria-pressed', String(trackUp));
  $('ico-cap').setAttribute('href', trackUp ? '#i-heading' : '#i-north');
  $('btn-cap').title = trackUp ? 'Cap en haut' : 'Nord en haut';
  app.lakeMap.setFollow(follow);
  app.lakeMap.setTrackUp(trackUp);
}

// ------------------------------------------------------------------ routeur

function route() {
  disarmAll(); // un bouton amorcé ne doit pas attendre au retour sur l'écran
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

// L'écran ne dépend pas du chargement des données : on le verrouille avant tout le reste,
// pour qu'il tienne même si la carte, elle, n'arrive pas à s'ouvrir.
keepScreenAwake();
boot();
