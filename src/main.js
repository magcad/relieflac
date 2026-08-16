// Assemblage de l'application : chargement des données, carte, réglages, relevés.

import {
  BedGrid, BED_SOURCES, correctedAltitude, rawAltitudeFor, DEFAULT_BED_SOURCE,
} from './bed.js';
import { DepthLayer } from './depth-layer.js';
import { formatSpeed, Geolocator } from './geo.js';
import { formatAge, Level, LevelSource } from './level.js';
import { LevelHistory } from './level-history.js';
import {
  chartGeometry, DEFAULT_RANGE, formatCote, formatMoment, LEVEL_RANGES,
  nearestPoint, rangeOf, renderChart, windowOf,
} from './level-chart.js';
import { Compass } from './compass.js';
import { LakeMap } from './map.js';
import { applyPaletteOverride, bandColors, bandLimits, buildLut, depthColor, hexToVec4, legendEntries } from './palette.js';
import { Probes, makeProbe } from './probes.js';
import {
  CRUISE_KMH, estimatedDuration, formatDistance, formatDuration, Routes, routeLength,
} from './routes.js';
import { angleDelta, navSolution } from './nav.js';
import { SimPoints } from './sim.js';
import { CorrectionsSync, getToken, setToken } from './sync.js';
import { Soundings } from './soundings.js';
import { defaultsFrom, Settings } from './settings.js';
import { VERSION } from './version.js';
import { closeRing, dedupeRing, DEFAULT_FEATHER_M, formatArea, groundAltitude, ringArea, Zones } from './zones.js';

const $ = (id) => document.getElementById(id);
/** Pas des boutons de zoom : un niveau, donc un facteur deux — franc et prévisible. */
const ZOOM_STEP = 1;
const ROUTES = { '#/': 'vue-carte', '#/parametres': 'vue-parametres', '#/a-propos': 'vue-apropos' };

const app = {
  palette: null, model: null, bed: null, soundings: null,
  settings: null, level: null, geo: null, probes: null,
  sim: null, compass: null, zones: null,
  // Historique de la cote, et durée affichée par la courbe du panneau d'étiage.
  levelHistory: null, chartRange: DEFAULT_RANGE, chartWindow: [],
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
  // Trajets de navigation. Le constructeur a trois états, comme les zones : panneau ouvert
  // (`routeMode`), tracé en cours (`routeTracing`), trajet repris pour réglage (`editingRouteId`).
  routes: null,
  routeMode: false, routeTracing: false, routeDraft: [], editingRouteId: null,
  // Menu à modes : quel métier de l'application est affiché dans la feuille.
  menuMode: 'carte',
  // Mode Go : navigation le long d'un trajet. `fromIndex` = dernier point de passage franchi.
  go: { active: false, routeId: null, points: null, fromIndex: 0, arrived: false },
};

// ---------------------------------------------------------------- démarrage

async function boot() {
  // Avant tout le reste, et sans attendre les données : l'avertissement doit être lu
  // pendant que la carte se construit, pas une fois qu'elle s'affiche.
  showGate();
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
    app.probes = new Probes();
    app.sim = new SimPoints();
    app.zones = new Zones();
    app.routes = new Routes();
    app.compass = new Compass();
    app.level = new Level('.');
    app.levelHistory = new LevelHistory('.');
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
    noteLevelInHistory();
    // L'historique du dépôt n'est pas sur le chemin critique : la carte s'ouvre sans lui, et
    // la courbe se remplit quand il arrive. Hors ligne, la réserve locale la trace seule.
    app.levelHistory.load().then(refreshLevelChart, () => {});

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
    wireInfoNotes();
    wireProbes();
    wireSim();
    wireZones();
    wireCompass();
    wireMap();
    wireBigDepth();
    wireSync();
    wireMenu();
    wireRoutes();
    wireGo();
    wireQuickNav();
    route();

    refreshLevelUi();
    refreshDepthStyle();
    refreshSettingsUi();
    refreshProbesUi();
    refreshProbesOnMap();
    refreshSimOnMap();
    refreshZonesUi();
    refreshZonesOnMap();
    refreshRoutePicker();
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
    setInterval(refreshLevelFromEdf, 10 * 60e3);

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

// Les 8 118 sondes ne servent qu'à l'affichage optionnel des traces du levé : on ne bloque
// pas l'ouverture de la carte pour elles.
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
 * Recalage à appliquer à la lecture de la grille, en mètres — et **un seul à la fois**.
 *
 * Chaque carte a le sien, et ils ne s'additionnent pas :
 *
 *   • le levé de 2009 se recale par `calibrationOffset_m`, appliqué ici, à la lecture,
 *     parce qu'il corrige une cote de référence inconnue commune à tout le levé ;
 *   • la carte communautaire se recale par `quickdrawDatum_m`, appliqué à la grille
 *     elle-même (BedGrid.setDatumOffset), parce qu'il ne déplace que les cellules encadrées
 *     par une bande et laisse le terrain LiDAR où il est.
 *
 * Les cumuler était le défaut : le recalage du levé continuait d'agir sur la carte
 * communautaire, qui n'en montre pourtant pas la valeur. Le champ des réglages disait
 * « +1,72 », la carte se déplaçait de 1,72 + le reste, et rien à l'écran ne le disait. Ce
 * n'est pas seulement un problème d'affichage : le recalage de la communautaire a été
 * mesuré sur l'eau, contre le trait de côte réel, il absorbe donc **déjà** tout ce que
 * l'autre corrigerait.
 */
function bedOffset() {
  return communityBed() ? 0 : app.settings.get('calibrationOffset_m');
}

/**
 * Altitude du fond corrigée du recalage, en m NGF.
 *
 * Interpolation bilinéaire, comme le shader : la profondeur annoncée sous le bateau
 * doit être exactement celle que montre la couleur au même endroit.
 */
function bedAltitude(lon, lat) {
  return correctedAltitude(
    app.bed.altitudeAt(lon, lat),
    bedOffset(),
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
    offset: bedOffset(),
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

  // En navigation, la position nourrit aussi le HUD : cap à tenir, distances, avancement.
  if (app.go.active) updateGoHud(position);
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
  refused: "Écran maintenu allumé : refusé — c'est le mode économie d'énergie de l'iPhone.",
  lost: 'Écran maintenu allumé : pas pour le moment, reprise automatique au retour.',
  unsupported: "Écran maintenu allumé : impossible sur ce navigateur — régler la mise en "
    + 'veille sur « Jamais ».',
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

// Les relevés partagés sont les sondes « Relever » ET les zones émergées. Conversion vers
// le format de fichier (générique, réutilisable) et retour.
function probesToRecords() {
  const fallback = app.settings.get('correctionRadius_m');
  return (app.probes?.records ?? []).map((p) => ({
    id: p.id, at: p.at, lon: p.lon, lat: p.lat, bedZ: p.bedZ,
    depth_m: p.sounderDepth ?? null, cote_m: p.level ?? null,
    transducer_m: p.transducerDepth ?? null,
    // Rayon TOUJOURS explicite, jamais `null` : c'est la surface que ce relevé corrige, et
    // le lecteur d'en face n'a pas le même réglage par défaut que nous. Sans lui, la même
    // sonde creusait 20 m ici et 60 m là-bas — donc deux cartes différentes pour une seule
    // mesure. Les relevés antérieurs à cette règle prennent le réglage courant, qui est
    // celui sous lequel ils ont été posés.
    radius_m: Probes.radiusOf(p, fallback),
    position_source: p.fixSource ?? 'gps',
  }));
}

/** Les zones voyagent avec leur altitude de sol et leur fondu — tout ce qui les redessine. */
function zonesToRecords() {
  return (app.zones?.records ?? [])
    .filter((z) => Number.isFinite(z.bedZ) && Array.isArray(z.ring) && z.ring.length >= 3)
    .map((z) => ({
      id: z.id, at: z.at, ring: z.ring, bedZ: z.bedZ,
      height_m: z.height_m ?? null, cote_m: z.cote_m ?? null,
      feather_m: Number.isFinite(z.feather_m) ? z.feather_m : DEFAULT_FEATHER_M,
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

function recordsToZones(records) {
  return records.map((r) => ({
    id: r.id, at: r.at, ring: r.ring, bedZ: r.bedZ,
    height_m: r.height_m ?? null, cote_m: r.cote_m ?? null,
    feather_m: Number.isFinite(r.feather_m) ? r.feather_m : DEFAULT_FEATHER_M,
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
 * D'où les pierres tombales (`Probes.deletedIds`, `Zones.deletedIds`) : un relevé distant
 * plus ancien que sa propre suppression est écarté. Plus récent, il repasse — c'est alors
 * qu'il a été mesuré à nouveau depuis, et la même règle d'horodatage doit valoir.
 */
function mergeById(remote, local, graves = Probes.deletedIds()) {
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
 * relevés), on adopte la fusion, puis on publie si le local apportait quelque chose d'absent
 * du distant. C'est ce qui fait remonter des sondes saisies avant l'installation du jeton.
 */
async function initSync() {
  if (!app.sync) return;
  try {
    const { records: remote, zones: remoteZones } = await app.sync.pull();
    const local = probesToRecords();
    const localZones = zonesToRecords();
    adoptRemote(mergeById(remote, local), mergeById(remoteZones, localZones, Zones.deletedIds()));
    const known = new Set([...remote, ...remoteZones].map((r) => r.id));
    const hasLocalExtra = [...local, ...localZones].some((r) => !known.has(r.id));
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
      const { records, zones } = await app.sync.pull();
      adoptRemote(
        mergeById(records, probesToRecords()),
        mergeById(zones, zonesToRecords(), Zones.deletedIds()),
      );
      toast('Relevés partagés récupérés');
    }
  } catch (err) {
    setSyncStatus(`échec : ${err.message}`);
    toast('Synchronisation impossible', 6000);
  }
  refreshSyncUi();
}

/** Adopte un jeu de relevés et de zones (fusionné) sans déclencher de renvoi. */
function adoptRemote(records, zones) {
  app.suppressPush = true;
  if (Array.isArray(records)) app.probes.replaceAll(recordsToProbes(records));
  if (Array.isArray(zones)) app.zones.replaceAll(recordsToZones(zones));
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
    await app.sync.push(probesToRecords(), syncMeta(), zonesToRecords());
    setSyncStatus(syncSummary());
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

const syncSummary = () => `à jour · ${app.probes.count} relevé(s)`
  + (app.zones?.count ? `, ${app.zones.count} zone(s)` : '');

function refreshSyncUi() {
  if (!app.sync) return;
  $('btn-sync-now').textContent = app.sync.hasToken() ? 'Synchroniser maintenant' : 'Récupérer les relevés';
  const cur = $('sync-status').textContent || '';
  const transient = /^(envoi|synchronisation|non synchronisé|échec|hors ligne)/.test(cur);
  if (!transient) {
    setSyncStatus(app.sync.hasToken()
      ? (app.sync.dirty ? 'écritures en attente' : syncSummary())
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
    chip.title = `Cote du lac : ${detail} — toucher pour l'étiage`;
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

// ------------------------------------------------- historique de la cote

/** Relève la cote auprès du relais, l'inscrit dans l'historique, et met l'écran à jour. */
async function refreshLevelFromEdf() {
  await app.level.refresh();
  noteLevelInHistory();
  refreshLevelUi();
}

/**
 * Inscrit dans l'historique local la cote que cet appareil vient de lire.
 *
 * C'est ce qui permet à la courbe de continuer d'avancer quand le workflow horaire ne
 * tourne pas — GitHub suspend les tâches planifiées d'un dépôt resté inactif — et de garder
 * la trace d'une sortie faite hors ligne. Une cote périmée n'apprend rien de neuf ; une cote
 * saisie à la main n'est pas une mesure du barrage : ni l'une ni l'autre n'entre ici.
 */
function noteLevelInHistory() {
  const data = app.level?.data;
  if (!data || data.stale || !app.levelHistory) return;
  if (app.levelHistory.record(data.measured_at, data.level_m_ngf)) refreshLevelChart();
}

function wireLevelChart() {
  const ranges = $('chart-ranges');
  for (const range of LEVEL_RANGES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.range = range.key;
    button.textContent = range.label;
    button.title = `Afficher ${range.title}`;
    button.addEventListener('click', () => setChartRange(range.key));
    ranges.append(button);
  }
  setChartRange(app.chartRange);

  // Lecture au doigt : la courbe seule donne la forme, pas les valeurs. `pan-y` en CSS
  // laisse le panneau défiler verticalement pendant qu'on suit la courbe du doigt.
  const plot = $('chart-plot');
  plot.addEventListener('pointerdown', scrubChart);
  plot.addEventListener('pointermove', (event) => { if (event.buttons) scrubChart(event); });
  plot.addEventListener('pointerup', endScrub);
  plot.addEventListener('pointercancel', endScrub);
  plot.addEventListener('pointerleave', endScrub);

  // Le tracé est en pixels réels, pas en unités élastiques : une rotation d'écran le
  // laisserait étiré tant qu'on ne le redessine pas.
  window.addEventListener('resize', () => refreshLevelChart());
}

function setChartRange(key) {
  app.chartRange = key;
  for (const button of $('chart-ranges').children) {
    const on = button.dataset.range === key;
    button.classList.toggle('is-on', on);
    button.setAttribute('aria-pressed', String(on));
  }
  refreshLevelChart();
}

/** Redessine la courbe. Sans objet tant que le panneau d'étiage est fermé : il n'a pas de taille. */
function refreshLevelChart() {
  const plot = $('chart-plot');
  if (!plot || !app.levelHistory || $('sim').hidden) return;

  const box = plot.getBoundingClientRect();
  const width = Math.round(box.width);
  const height = Math.round(box.height);
  app.chartWindow = windowOf(app.levelHistory.entries(), app.chartRange);

  const svg = $('chart-svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.innerHTML = width > 1 && height > 1
    ? renderChart(app.chartWindow, app.chartRange, { width, height })
    : '';

  const empty = $('chart-empty');
  empty.hidden = app.chartWindow.length > 0;
  empty.textContent = app.levelHistory.loaded
    ? 'Pas encore de relevé sur cette durée.'
    : 'Historique en cours de chargement…';
  describeChart();
}

/** Légende par défaut de la courbe : ce que le lac a fait sur la période affichée. */
function describeChart() {
  const read = $('chart-read');
  const points = app.chartWindow;
  const range = rangeOf(app.chartRange);
  if (!points.length) {
    read.textContent = `Cote du lac sur ${range.title}`;
    return;
  }
  const cm = Math.round((points[points.length - 1].v - points[0].v) * 100);
  const sign = cm > 0 ? '+' : cm < 0 ? '−' : '';
  read.innerHTML = `Sur ${range.title} : <strong>${sign}${Math.abs(cm)} cm</strong>`;
}

function scrubChart(event) {
  const points = app.chartWindow;
  if (!points.length) return;
  const box = $('chart-plot').getBoundingClientRect();
  const g = chartGeometry(points, { width: box.width, height: box.height });
  const cursor = $('chart-cursor');
  if (!g.ok || !cursor) return;

  const x = Math.min(Math.max(event.clientX - box.left, g.x0), g.x1);
  const ratio = g.x1 > g.x0 ? (x - g.x0) / (g.x1 - g.x0) : 0;
  const point = nearestPoint(points, g.t0 + ratio * (g.t1 - g.t0));

  cursor.removeAttribute('hidden');
  const cx = g.xOf(point.t).toFixed(1);
  const line = cursor.querySelector('line');
  line.setAttribute('x1', cx);
  line.setAttribute('x2', cx);
  const dot = cursor.querySelector('circle');
  dot.setAttribute('cx', cx);
  dot.setAttribute('cy', g.yOf(point.v).toFixed(1));

  $('chart-read').innerHTML =
    `<strong>${formatCote(point.v)} m</strong> · ${formatMoment(point.t, app.chartRange)}`;
}

function endScrub() {
  $('chart-cursor')?.setAttribute('hidden', '');
  describeChart();
}

// --------------------------------------------------------------- réglages

function wireSettings() {
  const s = app.settings;

  const select = $('set-preset');
  Object.entries(app.palette.presets).forEach(([key, preset]) => {
    select.append(new Option(preset.label, key));
  });

  bind('set-bed-source', 'change', (el) => s.set('bedSource', el.value));
  // Un seul champ, deux grandeurs : le geste est le même — « de combien cette carte-ci est
  // à côté » — mais ce qu'il corrige suit la carte affichée. Sur la communautaire, c'est le
  // plan d'eau auquel se rapportent les bandes ; sur le levé, la cote du 22 avril 2009. Les
  // confondre corromprait l'autre carte, d'où l'aiguillage ici et non dans le réglage.
  bind('set-datum', 'change', (el) => {
    const value = Number(el.value);
    const empty = el.value === '' || !Number.isFinite(value);
    if (communityBed()) {
      s.set('quickdrawDatum_m', empty ? null : clamp(round2(value), -10, 10));
    } else {
      s.set('calibrationOffset_m', empty ? 0 : clamp(round2(value), -5, 5));
    }
  });
  $('btn-datum-reset').addEventListener('click', () => {
    if (communityBed()) s.set('quickdrawDatum_m', s.defaults.quickdrawDatum_m);
    else s.set('calibrationOffset_m', s.defaults.calibrationOffset_m);
    refreshBedSourceUi();
  });
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
    await refreshLevelFromEdf();
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
    // Le recalage du levé se retranche des relevés avant qu'ils ne soient déposés dans la
    // grille (voir `gridValue`) : le changer oblige à les redéposer, sans quoi ils
    // dériveraient de la valeur du recalage au lieu de rester où ils ont été mesurés.
    if (key == null || key === 'correctionRadius_m' || key === 'calibrationOffset_m') {
      applyModelCorrections();
    }
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
  return clamp(value, min, max);
}

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

/** La carte communautaire est-elle celle qui est affichée ? */
const communityBed = () => (app.bed?.source ?? app.settings.get('bedSource')) === 'quickdraw';

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
  $('set-manual-level').value = s.get('manualLevel') ?? '';
  $('set-transducer').value = s.get('transducer_m');
  $('set-probes').checked = s.get('showProbes');
  $('set-radius').value = s.get('correctionRadius_m');
  refreshBedSourceUi();
  refreshProbesUi();
  refreshZonesUi();

  $('hint-safety').textContent = `Contour de sécurité tracé à ${s.safetyDepth.toFixed(2)} m `
    + `(tirant d'eau ${s.get('draft_m')} + marge ${s.get('margin_m')}).`;

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

// --------------------------------------- notes détaillées des réglages (le petit « i »)

/**
 * Chaque réglage porte une ligne de commentaire, et un « i » qui ouvre le détail.
 *
 * Les explications tenaient jusqu'ici en toutes lettres sous chaque réglage : six à dix
 * lignes chacune, et la page des Paramètres était devenue un texte suivi dans lequel les
 * réglages se perdaient. Ce qui est nécessaire pour agir reste visible ; le pourquoi — qui
 * ne se lit qu'une fois, et jamais sur l'eau — s'ouvre à la demande.
 */
function wireInfoNotes() {
  for (const button of document.querySelectorAll('.infobtn[data-info]')) {
    const note = $(button.dataset.info);
    if (!note) continue;
    button.addEventListener('click', () => {
      const open = note.hidden;
      note.hidden = !open;
      button.setAttribute('aria-expanded', String(open));
    });
  }
}

// ------------------------------------------ avertissement d'ouverture (FR / EN)

/**
 * Mise en garde affichée à chaque lancement.
 *
 * Non mémorisée volontairement : ce n'est pas une case à cocher une fois pour toutes mais
 * un rappel de ce qu'on a sous les yeux, et le lac reçoit surtout des visiteurs qui
 * ouvrent l'application une seule fois. Elle ne bloque pas le chargement — la carte se
 * construit derrière — mais elle passe au-dessus de l'écran d'attente.
 */
function showGate() {
  const gate = $('gate');
  if (!gate) return;
  gate.hidden = false;
  $('btn-gate-ok').addEventListener('click', () => { gate.hidden = true; }, { once: true });
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
    if (app.captureOpen) { if (app.go.active) exitGo(); if (app.routeMode) exitRouteMode(); }
    else { clearPin(); if (app.editingProbeId) endProbeEdit(); }
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
  const resized = fitChartToRoom();
  let offset = 0;
  for (const id of ['sim', 'zone', 'route', 'capture']) {
    const element = $(id);
    if (element.hidden) continue;
    element.style.bottom = offset
      ? `calc(var(--dock) + .5rem + ${offset}px)`
      : '';
    offset += element.offsetHeight + 8;
  }
  liftRail(offset);
  if (resized) refreshLevelChart(); // le tracé est en pixels : il se refait à la nouvelle taille
}

/**
 * Rend à la courbe la hauteur que la place libre autorise, et pas un pixel de plus.
 *
 * La courbe demande jusqu'à 40 % de l'écran ; le rail de caméra en occupe déjà 250 px.
 * Laissée à sa hauteur souhaitée, elle poussait le panneau par-dessus le bas du rail, donc
 * par-dessus le bouton « Outils » — le seul moyen de ressortir. On mesure ce qui reste et
 * l'on rabote la courbe d'autant : c'est elle qui cède, jamais la sortie.
 */
function fitChartToRoom() {
  const sim = $('sim');
  const plot = $('chart-plot');
  const rail = document.querySelector('.rail');
  const view = $('vue-carte');
  const root = document.documentElement;
  const before = root.style.getPropertyValue('--chart-h');

  root.style.removeProperty('--chart-h'); // repartir de la hauteur souhaitée
  if (sim?.hidden !== false || !plot || !rail || !view) return before !== '';

  const strip = document.querySelector('.navstrip')?.offsetHeight ?? 0;
  const dock = document.querySelector('.dock')?.offsetHeight ?? 0;
  const room = view.clientHeight - strip - dock - rail.offsetHeight - 26;
  const excess = sim.offsetHeight - room;
  const after = excess > 0 ? `${Math.max(150, Math.round(plot.offsetHeight - excess))}px` : '';
  if (after) root.style.setProperty('--chart-h', after);
  return after !== before;
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
  // La hauteur du rail dépend de sa compacité : on tranche d'abord, on mesure ensuite.
  // Le panneau d'étiage porte une courbe haute et replie la capsule sans discuter — le
  // pincement zoome aussi bien, et c'est la place qu'il faut à la courbe.
  rail.classList.toggle('is-compact', $('sim')?.hidden === false);
  const room = () => view.clientHeight - strip - dock - rail.offsetHeight - 18;
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
    // Comparaison au fond SANS LES RELEVÉS (sinon on comparerait la sonde à une carte déjà
    // corrigée par les sondes précédentes — un écart artificiellement nul), mais **avec le
    // recalage** de la carte affichée : c'est ce que l'écran annonçait à cet endroit, et
    // c'est le seul écart qui veuille dire quelque chose. Le mesurer contre une carte non
    // recalée rendrait le recalage invisible là où il sert précisément à se juger.
    modelBedZ: correctedAltitude(
      app.bed.baseAltitudeAt(position.lon, position.lat),
      bedOffset(),
      app.settings.get('waterPlane_m_ngf'),
    ),
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
/**
 * Profondeur saisie à la main, ou `null` si le champ ne porte rien d'exploitable.
 *
 * Le zéro est ACCEPTÉ, contrairement aux logs de sondeur où il signe un décrochage de
 * l'instrument (`tools/import_soundings.py` l'écarte, et doit continuer). Ici la valeur est
 * tapée par quelqu'un qui regarde le fond : zéro veut dire trait de côte — le fond affleure
 * la surface — et c'est la mesure la plus directe qui soit, puisqu'elle donne l'altitude du
 * fond sans instrument, à la cote du lac près. La refuser rendait impossible le relevé de la
 * ligne d'eau à pied, c'est-à-dire la seule campagne capable d'établir un recalage de datum.
 */
function readDepthInput(id) {
  const raw = $(id).value.trim();
  if (raw === '') return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < -10 || value > 60) return null;
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
    // Le rayon fait partie de ce qu'on relit : c'est lui qui dit quelle surface le point
    // corrige, donc ce que verra celui d'en face. Une liste qui le taisait laissait croire
    // qu'il n'appartenait pas au relevé.
    const radius = Probes.radiusOf(r, app.settings.get('correctionRadius_m'));
    item.innerHTML = `<span class="residual">${depthLabel(r.sounderDepth)}</span>
      <span class="hint">rayon ${Math.round(radius)} m · ${when}${modelText}</span>`;

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
  // En navigation, le cap pilote l'aiguille de gouverne et le repère de cap cible.
  if (app.go.active) updateGoSteer();
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

  // Le curseur de cote n'est plus la première chose qu'on voit : il se déplie au crayon.
  // Ce qu'on vient chercher ici neuf fois sur dix, c'est la courbe.
  $('btn-sim-manual').addEventListener('click', () => showManualLevel($('sim-manual').hidden));
  wireLevelChart();

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
    .map((p) => ({ lon: p.lon, lat: p.lat, bedZ: gridValue(p.bedZ), radius_m: p.radius_m ?? null }));
  const fromSim = (app.sim?.records ?? [])
    .filter((p) => Number.isFinite(p.bedZ))
    .map((p) => ({ lon: p.lon, lat: p.lat, bedZ: gridValue(p.bedZ), radius_m: p.radius_m ?? null }));
  const fromZones = (app.zones?.records ?? [])
    .filter((z) => Number.isFinite(z.bedZ))
    .map((z) => ({ ring: z.ring, bedZ: gridValue(z.bedZ), radius_m: z.feather_m ?? DEFAULT_FEATHER_M }));
  return [...fromProbes, ...fromSim, ...fromZones];
}

/**
 * Valeur à inscrire dans la grille pour qu'un relevé se **relise à son altitude**, quel que
 * soit le recalage en vigueur. Voir `rawAltitudeFor` : le relevé est le point fixe, c'est la
 * carte qui bouge autour de lui.
 */
function gridValue(bedZ) {
  return rawAltitudeFor(bedZ, bedOffset(), app.settings.get('waterPlane_m_ngf'));
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
  if (!app.bed || app.bedSwapping) return;
  app.bedSwapping = true;
  try {
    // Le raccourci du rail permet d'enchaîner les allers-retours plus vite que ne se
    // télécharge l'autre grille. On relit donc le réglage après chaque échange, plutôt que
    // de lancer deux chargements concurrents — ou de laisser affichée une carte qui n'est
    // plus celle demandée, ce qui est le pire des deux.
    while (app.settings.get('bedSource') !== app.bed.source) {
      if (!(await app.bed.useSource(app.settings.get('bedSource')))) break;
      // Chacun des deux recalages retrouve la carte à laquelle il appartient : celui de la
      // communautaire déplace la grille, celui du levé s'applique à la lecture, et les
      // relevés se redéposent en tenant compte de celui qui vaut désormais.
      app.bed.setDatumOffset(app.settings.get('quickdrawDatum_m'));
      applyModelCorrections();
      refreshBedSourceUi();
      refreshDepthStyle();
      if (announce) toast(`Fond : ${BED_SOURCES[app.bed.source].label}`);
    }
  } catch (err) {
    toast(`Fond indisponible : ${err.message}`, 6000);
    app.settings.set('bedSource', app.bed.source);
    refreshBedSourceUi();
  } finally {
    app.bedSwapping = false;
  }
}

/**
 * Rappelle partout quelle carte est sous les pieds : réglages et page « À propos ».
 *
 * C'est aussi ici que le champ « Recalage de la carte » change de grandeur. Le levé de 2009
 * n'a pas de recalage de plan d'eau mais a le même problème sous un autre nom — la cote du
 * jour du levé, inconnue, qui décale toutes ses profondeurs d'une constante : c'est donc
 * bien le même champ, et non deux réglages voisins entre lesquels il faudrait choisir.
 */
function refreshBedSourceUi() {
  if (!app.bed) return;
  const source = BED_SOURCES[app.bed.source];
  const meta = app.bed.meta;
  $('set-bed-source').value = app.bed.source;
  const community = app.bed.source === 'quickdraw';
  $('sec-fond').classList.toggle('is-community', community);
  $('hint-bed-source').textContent = community
    ? `${meta.quickdraw_only?.framed_ha ?? '—'} ha encadrés par la communauté `
      + `(${Math.round((meta.coverage_ratio ?? 0) * 100)} % du lac), aucune sonde de 2009.`
    : `Levé mesuré au décimètre, sonde à ${meta.coverage?.median_m ?? '—'} m en médiane, `
      + 'interpolé entre les traces.';

  // Le rail dit en permanence quelle carte est réellement affichée — pas celle qui est
  // demandée : `app.bed.source` est le fond effectivement chargé, et c'est lui qui commande
  // partout ici, jusqu'au sélecteur des réglages.
  $('tag-bed-source').textContent = community ? 'COM' : '2009';
  $('btn-bed-source').title = `Fond : ${source.label} — toucher pour l'autre carte`;
  $('btn-bed-source').setAttribute('aria-label', `Fond affiché : ${source.label}. Changer de carte.`);

  const field = $('set-datum');
  const applied = community ? app.bed.datum : app.settings.get('calibrationOffset_m');
  // On n'écrase pas la saisie en cours : réécrire la valeur pendant que l'utilisateur tape
  // lui déplacerait le curseur à chaque frappe.
  if (document.activeElement !== field) field.value = applied.toFixed(2);
  field.min = community ? -10 : -5;
  field.max = community ? 10 : 5;

  // Le recalage de l'autre carte, s'il n'est pas nul. Les deux ne se cumulent jamais — un
  // seul agit, celui de la carte affichée — mais tant que rien ne le disait, un réglage
  // laissé sur une carte qu'on n'affiche plus passait pour actif.
  const dormant = community
    ? app.settings.get('calibrationOffset_m')
    : (app.settings.get('quickdrawDatum_m') ?? app.bed.builtInDatum);
  const other = community ? BED_SOURCES.ofb2009.label : BED_SOURCES.quickdraw.label;
  const dormantLine = $('hint-dormant');
  dormantLine.hidden = !dormant;
  if (dormant) {
    dormantLine.textContent = `« ${other} » garde son propre recalage de ${signed(dormant)} m. `
      + 'Il ne s\'ajoute pas à celui-ci : seul le recalage de la carte affichée agit.';
  }

  if (community && meta.quickdraw_only) {
    const built = app.bed.builtInDatum;
    const zAc = meta.quickdraw_only.z_ac_m_ngf;
    $('hint-datum').textContent =
      `Plan d'eau de référence : ${(zAc + applied).toFixed(2)} m NGF `
      + `(mesuré ${zAc.toFixed(2)}, recalé de ${signed(applied)} m).`
      + (Math.abs(applied - built) < 0.005 ? ' Valeur du fichier.' : ` Le fichier dit ${signed(built)}.`);
  } else if (community) {
    $('hint-datum').textContent = `Recalage appliqué : ${signed(applied)} m.`;
  } else {
    const z = app.settings.get('z2009_m_ngf') + applied;
    $('hint-datum').textContent = `Cote du levé retenue : ${z.toFixed(2)} m NGF `
      + `(départ ${app.settings.get('z2009_m_ngf')}, non confirmée).`;
    $('hint-z2009').textContent = 'Une fois la valeur stabilisée, la reporter dans '
      + 'config/model.json et reconstruire la grille : le recalage ne serait alors plus '
      + 'qu\'un correctif de dernière minute, à remettre à zéro.';
  }

  $('apropos-version').textContent = `${VERSION} · fond ${source.label} `
    + `· grille ${app.bed.width}×${app.bed.height}`;
}

/** « +1,72 » / « −0,30 » : sur un décalage, le signe porte tout le sens. */
const signed = (value) => `${value > 0 ? '+' : ''}${value.toFixed(2)}`;

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
    const zAc = app.bed.meta.quickdraw_only?.z_ac_m_ngf;
    toast(`Recalage ${signed(applied)} m`
      + (Number.isFinite(zAc) ? ` — plan d'eau ${(zAc + applied).toFixed(2)} m NGF` : ''));
  }
}

function enterSim() {
  if (app.go.active) exitGo();
  if (app.routeMode) exitRouteMode();
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
  showManualLevel(false); // le curseur repart replié à chaque ouverture
  setSimLevel(app.simBaseLevel);
  refreshSimOnMap();
  // Le panneau vient d'être démasqué : il a enfin une taille, la courbe peut se dessiner.
  refreshLevelChart();
  toast('Étiage : la courbe donne l’évolution, le crayon règle la cote');
}

/** Déplie ou replie la saisie manuelle de la cote, derrière le crayon. */
function showManualLevel(open) {
  $('sim-manual').hidden = !open;
  $('btn-sim-reset').hidden = !open;
  $('btn-sim-manual').setAttribute('aria-pressed', String(open));
  stackBottomBars(); // le curseur déplié change la hauteur du panneau
}

function exitSim() {
  app.simMode = false;
  app.editingSimId = null;
  disarmAll();
  $('btn-sim').classList.remove('is-on');
  $('sim').hidden = true;
  refreshCaptureUi();
  $('sim-sel').hidden = true;
  showManualLevel(false);
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
    bedOffset(),
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
    // Et se partage, comme une sonde : un îlot que le levé a comblé est exactement ce que
    // le voisin doit voir avant de passer dessus. Le fichier le range à part des points —
    // une zone reste une interprétation, pas une mesure.
    if (!app.suppressPush) scheduleSyncPush();
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
  if (app.go.active) exitGo();
  if (app.routeMode) exitRouteMode();
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

  // Bascule d'un fond bathymétrique à l'autre. C'est le geste qui manquait : les deux
  // cartes ne se contredisent nulle part autant qu'au-dessus d'un haut-fond, et jusqu'ici
  // les comparer demandait d'ouvrir les réglages, de descendre jusqu'à « Fond », puis de
  // revenir — trois écrans pendant lesquels le bateau avance.
  $('btn-bed-source').addEventListener('click', () => {
    app.settings.set('bedSource', communityBed() ? 'ofb2009' : 'quickdraw');
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
    if (app.go.active) return; // en navigation, le suivi est verrouillé
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

  // La cote du bandeau ouvre l'étiage, et non les réglages : ce qu'on veut en la touchant,
  // c'est faire varier le niveau pour voir ce qui découvre — la saisie manuelle, elle, se
  // fait une fois par an. Le panneau d'étiage porte d'ailleurs la cote en grand.
  $('btn-cote').addEventListener('click', () => {
    location.hash = '#/';
    if (!app.simMode) enterSim();
  });

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

// ---------------------------------------------------------------- menu à modes

/**
 * Menu principal, organisé en modes. La feuille porte en haut une barre de cinq segments —
 * un par métier de l'application, chacun sa couleur — et son corps ne montre que les actions
 * du mode choisi. C'est ce qui empêche de confondre les modes sur un écran qu'on regarde une
 * seconde entre deux vagues : la couleur dit le métier avant même qu'on lise une tuile.
 *
 * La feuille se referme sur tout ce qui agit : ouvrir un outil, c'est vouloir la carte, pas
 * rester devant un menu.
 */
function wireMenu() {
  const sheet = $('sheet');
  const open = (on) => {
    sheet.hidden = !on;
    $('btn-menu').setAttribute('aria-expanded', String(on));
  };

  $('modes').addEventListener('click', (event) => {
    const button = event.target.closest('[data-mode]');
    if (button) setMenuMode(button.dataset.mode);
  });

  $('btn-menu').addEventListener('click', () => {
    open(sheet.hidden);
    if (!sheet.hidden) setMenuMode(app.menuMode); // rouvre sur le dernier mode consulté
  });
  $('sheet-scrim').addEventListener('click', () => open(false));
  // Écoute posée sur le conteneur : elle se déclenche après les gestionnaires propres à
  // chaque tuile, quel que soit l'ordre dans lequel les modules ont été câblés. Les segments
  // de mode, eux, ne referment pas la feuille — ils font naviguer à l'intérieur.
  sheet.querySelector('.sheet__panel').addEventListener('click', (event) => {
    if (event.target.closest('.tile, .sheet__link, .route__go')) open(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !sheet.hidden) open(false);
  });

  setMenuMode('carte');
}

/** Bascule la barre de modes et n'affiche que le corps du mode choisi. */
function setMenuMode(mode) {
  app.menuMode = mode;
  for (const button of document.querySelectorAll('#modes .mode')) {
    const on = button.dataset.mode === mode;
    button.classList.toggle('is-on', on);
    button.setAttribute('aria-selected', String(on));
  }
  for (const pane of document.querySelectorAll('.modepane')) {
    pane.hidden = pane.dataset.pane !== mode;
  }
  if (mode === 'nav') refreshRoutePicker();
}

/** Referme la feuille du menu sans la rouvrir : appelé depuis les listes qu'elle porte. */
function closeSheet() {
  $('sheet').hidden = true;
  $('btn-menu')?.setAttribute('aria-expanded', 'false');
}

// ------------------------------------------------------ constructeur de trajet

/**
 * Trajet : mêmes trois états que les zones — panneau ouvert, tracé en cours, trajet repris
 * pour édition — parce que c'est le même geste, poser une suite de points sur la carte. Le
 * bleu de navigation le distingue du beige des zones et de l'ambre de l'étiage, pour qu'on
 * ne croie jamais tracer une route quand on relève un fond.
 */
function wireRoutes() {
  $('btn-trajet').addEventListener('click', () => (app.routeMode ? exitRouteMode() : enterRouteMode()));
  $('btn-route-exit').addEventListener('click', exitRouteMode);
  $('btn-route-new').addEventListener('click', startRouteDraft);
  $('btn-route-undo').addEventListener('click', undoRouteVertex);
  $('btn-route-cancel').addEventListener('click', cancelRouteDraft);
  $('btn-route-save').addEventListener('click', () => { saveRoute(); });
  $('btn-route-go').addEventListener('click', goFromDraft);
  wireArmed('btn-route-del', 'Confirmer ?', deleteSelectedRoute);

  app.lakeMap.addEventListener('routevertex', (event) => addRouteVertex(event.detail));
  // Toucher un sommet du brouillon le retire — l'édition la plus directe qui soit.
  app.lakeMap.addEventListener('wptselect', (event) => {
    const { index, active } = event.detail;
    if (!active && app.routeMode && app.routeTracing) removeRouteVertex(index);
  });

  app.routes.addEventListener('change', () => {
    refreshRoutePicker();
    if (app.routeMode) refreshRoutePanel();
  });
}

function enterRouteMode() {
  if (app.go.active) exitGo();
  if (app.simMode) exitSim();
  if (app.zoneMode) exitZoneMode();
  app.captureOpen = false;
  clearPin();
  if (app.editingProbeId) endProbeEdit();
  refreshCaptureUi();

  app.routeMode = true;
  app.routeTracing = false;
  app.routeDraft = [];
  app.editingRouteId = null;
  refreshRoutePanel();
  refreshRoutePicker();
  toast(app.routes.count
    ? 'Reprenez un trajet, ou « ✚ Nouveau trajet »'
    : 'Aucun trajet : « ✚ Nouveau trajet » pour en construire un', 4000);
}

function exitRouteMode() {
  app.routeMode = false;
  app.routeTracing = false;
  app.routeDraft = [];
  app.editingRouteId = null;
  disarmAll();
  refreshRoutePanel();
  refreshCaptureUi();
}

function startRouteDraft() {
  app.routeTracing = true;
  app.routeDraft = [];
  app.editingRouteId = null;
  $('route-name').value = '';
  refreshRoutePanel();
  toast('Touchez la carte pour poser les points de passage', 4000);
}

function editRoute(id) {
  const route = app.routes.get(id);
  if (!route) return;
  if (app.go.active) exitGo();
  app.routeMode = true;
  app.routeTracing = true;
  app.editingRouteId = id;
  app.routeDraft = route.points.map((p) => [p[0], p[1]]);
  $('route-name').value = route.name;
  refreshRoutePanel();
  toast('Édition : ajoutez des points, ou enregistrez', 4000);
}

function addRouteVertex(lngLat) {
  if (!app.routeTracing) return; // hors tracé, un toucher ne pose rien
  app.routeDraft.push([lngLat.lng, lngLat.lat]);
  refreshRoutePanel();
}

function undoRouteVertex() {
  app.routeDraft.pop();
  refreshRoutePanel();
}

function removeRouteVertex(index) {
  app.routeDraft.splice(index, 1);
  refreshRoutePanel();
}

function cancelRouteDraft() {
  app.routeTracing = false;
  app.editingRouteId = null;
  app.routeDraft = [];
  refreshRoutePanel();
}

/** Enregistre le brouillon (nouveau trajet, ou mise à jour d'un existant). Rend l'id. */
function saveRoute() {
  const points = app.routeDraft;
  if (points.length < 2) { toast('Il faut au moins 2 points de passage'); return null; }
  const name = $('route-name').value.trim();
  let id;
  if (app.editingRouteId) {
    app.routes.update(app.editingRouteId, { name: name || app.routes.get(app.editingRouteId)?.name, points });
    id = app.editingRouteId;
    toast('Trajet mis à jour');
  } else {
    const entry = app.routes.add({ name, points });
    id = entry.id;
    toast(`Trajet enregistré · ${formatDistance(routeLength(points))}`, 3500);
  }
  app.routeTracing = false;
  app.editingRouteId = null;
  app.routeDraft = [];
  refreshRoutePanel();
  refreshRoutePicker();
  return id;
}

/** Enregistre le brouillon puis lance la navigation dessus. */
function goFromDraft() {
  const id = saveRoute();
  if (id) startGo(id);
}

function deleteSelectedRoute() {
  if (!app.editingRouteId) return;
  const id = app.editingRouteId;
  app.editingRouteId = null;
  app.routeTracing = false;
  app.routeDraft = [];
  app.routes.remove(id);
  refreshRoutePanel();
  toast('Trajet supprimé');
}

/**
 * Unique endroit où l'état du panneau de trajet est rendu. Trois états, comme les zones :
 * la liste des trajets, le tracé en cours, et l'édition d'un trajet repris.
 */
function refreshRoutePanel() {
  const editing = Boolean(app.editingRouteId);
  const tracing = app.routeMode && app.routeTracing;
  const listing = app.routeMode && !tracing;

  $('route').hidden = !app.routeMode;
  $('btn-trajet').classList.toggle('is-on', app.routeMode);
  app.lakeMap.setRouteMode(app.routeMode);
  if (!app.routeMode) { app.lakeMap.clearRouteDraft(); stackBottomBars(); return; }

  $('route-title').textContent = editing ? 'Trajet — édition' : tracing ? 'Nouveau trajet' : 'Trajets enregistrés';
  $('route-list').hidden = !listing;
  $('route-name-box').hidden = !tracing;
  $('btn-route-new').hidden = !listing;
  $('btn-route-undo').hidden = !tracing;
  $('btn-route-save').hidden = !tracing;
  $('btn-route-cancel').hidden = !tracing;
  $('btn-route-go').hidden = !tracing;
  $('btn-route-del').hidden = !editing;
  $('btn-route-undo').disabled = app.routeDraft.length === 0;
  $('btn-route-save').disabled = app.routeDraft.length < 2;
  $('btn-route-go').disabled = app.routeDraft.length < 2;

  if (tracing) {
    const n = app.routeDraft.length;
    const len = routeLength(app.routeDraft);
    $('route-hint').textContent = n === 0
      ? 'Touchez la carte pour poser les points de passage.'
      : 'Ajoutez des points (ou touchez-en un pour le retirer), puis ✓ Enregistrer.';
    $('route-meta').textContent = n < 2
      ? `${n} point${n > 1 ? 's' : ''} — il en faut au moins 2`
      : `${n} points · ${formatDistance(len)} · ~${formatDuration(estimatedDuration(len))} à ${CRUISE_KMH} km/h`;
    app.lakeMap.setRouteDraft(app.routeDraft);
  } else {
    $('route-hint').textContent = app.routes.count
      ? 'Reprenez un trajet, ou créez-en un nouveau.'
      : 'Aucun trajet. « ✚ Nouveau trajet » pour commencer.';
    $('route-meta').textContent = '';
    app.lakeMap.clearRouteDraft();
    fillRouteList($('route-list'), false);
  }
  stackBottomBars();
}

/** Liste des trajets enregistrés, dans le menu Navigation. */
function refreshRoutePicker() {
  const list = $('route-picker');
  if (!list) return;
  $('nav-hint').textContent = app.routes.count
    ? 'Vos trajets enregistrés :'
    : 'Aucun trajet. Construisez-en un avec « Trajet ».';
  fillRouteList(list, true);
}

/**
 * Peuple une liste de trajets. `primaryGo` ajoute le bouton ▶ de lancement direct — c'est le
 * cas du menu Navigation ; le constructeur, lui, propose édition et suppression.
 */
function fillRouteList(el, primaryGo) {
  el.replaceChildren(...app.routes.records.slice().reverse().map((r) => {
    const len = routeLength(r.points);
    const li = document.createElement('li');

    const name = document.createElement('span');
    name.className = 'route__name';
    name.textContent = r.name;
    const stat = document.createElement('span');
    stat.className = 'route__stat';
    stat.textContent = `${r.points.length} pts · ${formatDistance(len)} · ~${formatDuration(estimatedDuration(len))}`;
    name.append(stat);
    li.append(name);

    if (primaryGo) {
      const go = document.createElement('button');
      go.type = 'button';
      go.className = 'route__go';
      go.textContent = '▶';
      go.title = `Naviguer « ${r.name} »`;
      go.addEventListener('click', () => startGo(r.id));
      li.append(go);
    }

    const edit = document.createElement('button');
    edit.type = 'button';
    edit.textContent = '✎';
    edit.title = 'Modifier ce trajet';
    edit.addEventListener('click', () => { if (primaryGo) closeSheet(); editRoute(r.id); });

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'route__del';
    del.textContent = '✕';
    del.title = 'Supprimer ce trajet';
    del.addEventListener('click', () => {
      if (app.go.active && app.go.routeId === r.id) exitGo();
      if (app.editingRouteId === r.id) { app.editingRouteId = null; app.routeTracing = false; app.routeDraft = []; }
      app.routes.remove(r.id);
      toast('Trajet supprimé');
    });

    li.append(edit, del);
    return li;
  }));
}

// -------------------------------------------------------------- navigation (Go)

/** Dans le rayon d'arrivée d'un point de passage, on vise le suivant. */
const ARRIVE_RADIUS_M = 20;
/** Écart de route à partir duquel on l'affiche explicitement. */
const XTE_SHOW_M = 8;

function wireGo() {
  $('btn-go').addEventListener('click', startGoFromMenu);
  $('btn-go-exit').addEventListener('click', exitGo);
  $('btn-hist').addEventListener('click', () => {
    toast('Historique des trajets parcourus — bientôt disponible', 3500);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && app.go.active) exitGo();
  });
}

/** « Go » depuis la tuile : reprend le dernier trajet suivi, ou laisse choisir dans la liste. */
function startGoFromMenu() {
  if (!app.routes.count) {
    toast('Créez d’abord un trajet dans « Trajet »');
    enterRouteMode();
    return;
  }
  const last = loadLastRoute();
  if (last && app.routes.get(last)) { startGo(last); return; }
  if (app.routes.count === 1) { startGo(app.routes.records[0].id); return; }
  toast('Choisissez un trajet dans la liste ci-dessous');
  setMenuMode('nav');
}

function startGo(routeId) {
  const route = app.routes.get(routeId);
  if (!route || route.points.length < 1) { toast('Trajet introuvable'); return; }

  // Go prend l'écran : on quitte tout le reste.
  if (app.simMode) exitSim();
  if (app.zoneMode) exitZoneMode();
  if (app.routeMode) exitRouteMode();
  app.captureOpen = false;
  clearPin();
  if (app.editingProbeId) endProbeEdit();
  refreshCaptureUi();
  closeSheet();
  location.hash = '#/';

  app.go = { active: true, routeId, points: route.points.map((p) => [p[0], p[1]]), fromIndex: 0, arrived: false, lastSol: null };
  saveLastRoute(routeId);

  document.body.classList.add('mode-go');
  $('go').hidden = false;
  $('go-arrived').hidden = true;
  $('go-speed-unit').textContent = app.settings.get('speedUnit') === 'kn' ? 'nds' : 'km/h';
  buildGoTicks();

  // Caméra de chasse : suivi et cap en haut forcés (sans toucher aux réglages), fond atténué.
  app.lakeMap.setGoMode(true);
  app.lakeMap.setFollow(true);
  app.lakeMap.setTrackUp(true);
  ensureCompass();
  // À défaut de position GPS (essai sur ordinateur), on cadre au moins sur le trajet.
  if (!app.geo?.position) app.lakeMap.map.jumpTo({ center: route.points[0] });
  app.lakeMap.setVisibleWidth(170); // avant l'inclinaison : la mesure de largeur y est juste
  app.lakeMap.enterNavCam(55);
  app.lakeMap.setBasemapDim(true);
  app.goDepthOpacity = app.settings.get('opacity');
  app.depthLayer.setStyle({ opacity: Math.min(app.goDepthOpacity, 0.32) });
  app.lakeMap.setRoute(route.points);

  toast(`Navigation : ${route.name}`, 3000);
  if (app.geo?.position) updateGoHud(app.geo.position);
  else updateGoSteer();
}

function exitGo() {
  if (!app.go.active) return;
  app.go.active = false;
  app.go.lastSol = null;
  document.body.classList.remove('mode-go');
  $('go').hidden = true;
  app.lakeMap.setGoMode(false);
  app.lakeMap.clearRoute();
  app.lakeMap.setGate(null);
  app.lakeMap.exitNavCam();
  app.lakeMap.setBasemapDim(false);
  refreshDepthStyle();  // restaure l'opacité du fond
  refreshCameraUi();    // restaure suivi / cap en haut selon les réglages de l'utilisateur
}

function updateGoHud(position) {
  if (!app.go.active) return;
  const boat = [position.lon, position.lat];
  const sol = navSolution(app.go.points, boat, { fromIndex: app.go.fromIndex, arriveRadiusM: ARRIVE_RADIUS_M });
  if (!sol) return;
  app.go.fromIndex = sol.fromIndex;
  app.go.lastSol = sol;

  // Vitesse : le gros compteur, à l'unité choisie.
  const unit = app.settings.get('speedUnit');
  const v = Number.isFinite(position.speed)
    ? (unit === 'kn' ? position.speed * 1.943844 : position.speed * 3.6)
    : NaN;
  $('go-speed').textContent = Number.isFinite(v) ? v.toFixed(1) : '—';

  // Objectif : prochain point, sa distance, et ce qu'il reste du trajet.
  $('go-wp').textContent = sol.arrived ? 'ARRIVÉE' : `WP ${sol.targetIndex + 1}/${sol.waypointCount}`;
  $('go-dist').textContent = formatDistance(sol.distToTarget);
  $('go-remain').textContent = `reste ${formatDistance(sol.distRemaining)} · ~${formatDuration(estimatedDuration(sol.distRemaining))}`;

  const total = routeLength(app.go.points) || 1;
  const pct = Math.max(0, Math.min(100, (1 - sol.distRemaining / total) * 100));
  $('go-progress').style.width = `${pct}%`;

  // Écart de route : le sens dit où revenir.
  const xte = $('go-xte');
  if (!sol.arrived && Math.abs(sol.crossM) > XTE_SHOW_M) {
    const drift = Math.round(Math.abs(sol.crossM));
    xte.hidden = false;
    xte.textContent = sol.crossM > 0 ? `◀ hors route ${drift} m` : `hors route ${drift} m ▶`;
    xte.className = sol.crossM > 0 ? 'go__xte is-left' : 'go__xte is-right';
  } else {
    xte.hidden = true;
  }

  app.lakeMap.setGate(sol.arrived ? null : sol.target);

  if (sol.arrived && !app.go.arrived) {
    app.go.arrived = true;
    $('go-arrived-detail').textContent = `${app.routes.get(app.go.routeId)?.name ?? ''} · ${formatDistance(total)}`;
    $('go-arrived').hidden = false;
  } else if (!sol.arrived && app.go.arrived) {
    app.go.arrived = false;
    $('go-arrived').hidden = true;
  }

  updateGoSteer();
}

/** Aiguille de gouverne : la flèche penche du côté où venir, verte quand on est dans l'axe. */
function updateGoSteer() {
  if (!app.go.active) return;
  const sol = app.go.lastSol;
  const dial = document.querySelector('.go__dial');
  const arrow = $('go-arrow');
  const cap = $('go-cap');
  const turn = $('go-turn');
  const target = $('compass-target');

  if (!sol) {
    dial.classList.add('is-idle');
    cap.textContent = '—°';
    turn.textContent = 'trajet en attente';
    turn.className = 'go__turn';
    return;
  }

  cap.textContent = `${String(Math.round(sol.bearing) % 360).padStart(3, '0')}°`;

  const heading = Number.isFinite(app.heading) ? app.heading
    : Number.isFinite(app.geo?.position?.heading) ? app.geo.position.heading : null;

  if (heading == null) {
    dial.classList.add('is-idle');
    dial.classList.remove('is-oncourse');
    arrow.style.transform = 'rotate(0deg)';
    turn.textContent = 'cap en attente';
    turn.className = 'go__turn';
    if (target) target.style.transform = 'translateX(-9999px)';
    return;
  }

  const delta = angleDelta(heading, sol.bearing);
  dial.classList.remove('is-idle');
  arrow.style.transform = `rotate(${delta}deg)`;
  const onCourse = Math.abs(delta) < 5;
  dial.classList.toggle('is-oncourse', onCourse);
  if (onCourse) {
    turn.textContent = 'tout droit';
    turn.className = 'go__turn is-oncourse';
  } else if (delta > 0) {
    turn.textContent = `${Math.round(delta)}° à droite`;
    turn.className = 'go__turn is-turn';
  } else {
    turn.textContent = `${Math.round(-delta)}° à gauche`;
    turn.className = 'go__turn is-turn';
  }

  // Repère de cap cible sur le ruban de la boussole, borné à la largeur visible.
  if (target) {
    const half = $('compass').clientWidth / 2;
    const px = Math.max(-half + 8, Math.min(half - 8, delta * RIBBON_PX_PER_DEG));
    target.style.transform = `translateX(${px}px)`;
  }
}

/** Graduations fixes du cadran de gouverne (une seule fois). */
function buildGoTicks() {
  const group = $('go-ticks');
  if (!group || group.childElementCount) return;
  const NS = 'http://www.w3.org/2000/svg';
  for (let a = 0; a < 360; a += 30) {
    const major = a % 90 === 0;
    const rad = (a * Math.PI) / 180;
    const dx = Math.sin(rad);
    const dy = -Math.cos(rad);
    const ri = major ? 33 : 37;
    const ro = 42;
    const line = document.createElementNS(NS, 'line');
    line.setAttribute('x1', (ri * dx).toFixed(1));
    line.setAttribute('y1', (ri * dy).toFixed(1));
    line.setAttribute('x2', (ro * dx).toFixed(1));
    line.setAttribute('y2', (ro * dy).toFixed(1));
    if (major) line.setAttribute('stroke-width', '2.2');
    group.append(line);
  }
}

function saveLastRoute(id) {
  try { localStorage.setItem('relieflac.lastRoute.v1', id); } catch { /* stockage indisponible */ }
}

function loadLastRoute() {
  try { return localStorage.getItem('relieflac.lastRoute.v1'); } catch { return null; }
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
