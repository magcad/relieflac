// Ski nautique : activités tractées, enveloppe de vitesse, chrono et chutes.
//
// Tout est calcul pur — aucune dépendance à MapLibre ni au DOM — comme nav.js et camera.js.
// C'est d'autant plus nécessaire ici que rien de ce qui suit n'est vérifiable sur l'eau :
// un déclenchement automatique qui part une seconde trop tôt, une chute comptée deux fois,
// une enveloppe lue à l'envers, cela se constate à la seconde près, en tirant quelqu'un
// derrière le bateau — donc au pire moment pour ouvrir un débogueur.
//
// Une différence de fond avec la navigation : le barreur de ski ne suit pas une route, il
// tient une VITESSE. Le trajet n'est plus qu'un couloir dans lequel zigzaguer, et la donnée
// que l'on regarde dix fois par minute est l'écart à la plage demandée. D'où l'enveloppe,
// et d'où le fait que tout le reste (chrono, chutes) s'en déduise.

/**
 * Plages de vitesse par activité et par personne, en km/h, telles que fournies — le tableau
 * **d'usine**, celui du livre. Ce que l'application applique, c'est `skiActivities()`, qui
 * peut en différer : voir `setSkiSpeeds`.
 *
 * `enfant` et `adulte` sont les plages de travail : c'est l'une des deux qui devient
 * l'enveloppe à tenir. `typicalKn` est la colonne « vitesse typique » du tableau d'origine,
 * gardée telle quelle et **non recalculée** : ce n'est pas exactement l'union des deux
 * plages (le foil, le wakeskate et le slalom s'en écartent), c'est un usage constaté. La recalculer
 * l'aurait faussée au nom de la cohérence.
 *
 * Le slalom adulte est ouvert vers le haut (« 55+ ») : `openEnded` dit qu'au-delà du
 * maximum on n'est pas hors plage, on est simplement dans le haut du sport.
 */
export const SKI_ACTIVITIES = [
  // Le foil tracté ouvre la liste parce qu'il est le plus lent de tous — la liste est
  // ordonnée par vitesse croissante, et c'est ce qui la rend parcourable d'un coup d'œil.
  { id: 'foil', icon: '🪽', name: 'Foil tracté', enfant: [8, 12], adulte: [12, 18], typicalKn: [6.5, 10] },
  { id: 'bouee', icon: '🛟', name: 'Bouée / Donut', enfant: [15, 25], adulte: [20, 30], typicalKn: [8, 16] },
  { id: 'wakeskate', icon: '🏄', name: 'Wakeskate', enfant: [25, 30], adulte: [28, 32], typicalKn: [15, 17] },
  { id: 'wakeboard', icon: '🏄', name: 'Wakeboard', enfant: [20, 25], adulte: [28, 32], typicalKn: [11, 17] },
  { id: 'ski2', icon: '🎿', name: 'Ski nautique 2 skis', enfant: [20, 28], adulte: [28, 34], typicalKn: [11, 18] },
  { id: 'monoski', icon: '🎿', name: 'Monoski', enfant: [25, 30], adulte: [32, 38], typicalKn: [14, 21] },
  { id: 'slalom', icon: '🎿', name: 'Ski slalom', enfant: [30, 40], adulte: [35, 55], typicalKn: [19, 30], openEnded: true },
];

/** Les deux gabarits de personne tractée. L'ordre est celui du tableau. */
export const SKI_WHO = [
  { id: 'enfant', label: 'Enfant' },
  { id: 'adulte', label: 'Adulte' },
];

/** Durées de chrono proposées d'un appui, en secondes. Au-delà, la saisie manuelle. */
export const CHRONO_PRESETS_S = [600, 900, 1800];

/** Un nœud vaut 1,852 km/h — le facteur de conversion, dans le sens km/h → nœuds. */
export const KN_PER_KMH = 1 / 1.852;

/**
 * Tenue exigée avant le départ automatique du chrono (ms).
 *
 * Dix secondes : assez pour que la traction soit établie et le skieur debout, trop peu pour
 * qu'une pointe de vitesse en manœuvre y ressemble.
 */
export const AUTO_START_HOLD_MS = 10_000;

/**
 * Fraction de la vitesse minimale à partir de laquelle on considère qu'on « s'approche de
 * la vitesse cible ». Le chrono ne doit pas attendre l'entrée franche dans la plage : à
 * 26 km/h pour une plage 28–34, le skieur est déjà sorti de l'eau et tire.
 */
export const AUTO_START_RATIO = 0.85;

/** En deçà, le bateau est à l'arrêt : c'est la récupération d'une personne à l'eau. */
export const STOP_KMH = 4;

/** Tenue à l'arrêt avant de compter une chute (ms) : sous cela, c'est une manœuvre. */
export const FALL_HOLD_MS = 5000;

/**
 * Fraction de la vitesse minimale au-dessus de laquelle on considère qu'on TIRE. Une chute
 * ne se compte qu'après une traction établie, sans quoi le premier arrêt venu — celui du
 * départ, moteur au ralenti — en vaudrait une.
 */
export const TOW_RATIO = 0.7;

/**
 * Activité retenue par défaut, faute de choix mémorisé.
 *
 * Nommée, et non « la première de la liste » : l'ordre du tableau est un ordre de vitesse,
 * et depuis que le foil tracté l'ouvre, prendre le premier élément ferait démarrer une
 * session à 12–18 km/h — plage dans laquelle un bateau qui manœuvre entre déjà, donc chrono
 * parti tout seul et chutes comptées à tort.
 */
export const DEFAULT_ACTIVITY_ID = 'bouee';

/**
 * Plages retouchées par l'utilisateur, par activité : `{ monoski: { adulte: [30, 36] } }`.
 *
 * Pourquoi une table « en vigueur » distincte du tableau d'usine, et non un tableau qu'on
 * modifierait sur place : le tableau du livre reste la référence affichée en face de chaque
 * champ des Réglages, et il faut pouvoir y revenir d'un bouton. On ne mémorise donc que les
 * ÉCARTS — une plage retouchée aujourd'hui n'empêchera pas une correction d'usine, demain,
 * de rattraper toutes celles qu'on n'a pas touchées.
 *
 * L'état est ici, et non dans les réglages, parce que tout le reste du module en dépend :
 * l'enveloppe, la jauge, le départ automatique, le seuil de traction, la grille de
 * préparation. Les faire tous passer un paramètre de plus, c'était la certitude qu'un
 * endroit l'oublie et affiche encore la plage d'usine pendant que le bateau tient l'autre.
 */
let inForce = SKI_ACTIVITIES;

/**
 * Installe les plages retouchées. Rend la table en vigueur.
 *
 * Appelée au démarrage avec ce que portent les réglages, et à chaque changement. Une valeur
 * vide, illisible ou hors du plausible rend simplement le tableau d'usine : sur l'eau, une
 * plage absurde vaudrait chrono qui ne part jamais et chutes comptées sans arrêt.
 */
export function setSkiSpeeds(overrides) {
  inForce = mergeSkiSpeeds(SKI_ACTIVITIES, overrides);
  return inForce;
}

/** Le tableau réellement appliqué : usine, retouches comprises. */
export function skiActivities() {
  return inForce;
}

/**
 * Applique des retouches sur un tableau d'activités. Pur : rend un nouveau tableau.
 *
 * Une retouche n'est retenue que si elle décrit une plage lisible (deux nombres, dans les
 * bornes du plausible) ; sinon la ligne d'usine est gardée. `openEnded` et `typicalKn` ne
 * se retouchent pas : le premier dit qu'un sport n'a pas de plafond, la seconde est une
 * colonne d'origine qu'on ne recalcule jamais (voir en tête de module).
 */
export function mergeSkiSpeeds(base, overrides) {
  const map = overrides && typeof overrides === 'object' ? overrides : {};
  return base.map((activity) => {
    const patch = map[activity.id];
    if (!patch || typeof patch !== 'object') return activity;
    const enfant = readRange(patch.enfant) ?? activity.enfant;
    const adulte = readRange(patch.adulte) ?? activity.adulte;
    if (enfant === activity.enfant && adulte === activity.adulte) return activity;
    return { ...activity, enfant, adulte };
  });
}

/**
 * Retouches nettoyées, telles qu'on les mémorise : bornées, remises dans l'ordre, et
 * **débarrassées de ce qui égale l'usine**. Sans ce dernier tri, saisir 28–34 au monoski
 * adulte — la valeur du livre — figerait cette ligne pour toujours.
 */
export function normalizeSkiSpeeds(overrides) {
  const map = overrides && typeof overrides === 'object' ? overrides : {};
  const out = {};
  for (const activity of SKI_ACTIVITIES) {
    const patch = map[activity.id];
    if (!patch || typeof patch !== 'object') continue;
    const kept = {};
    for (const who of ['enfant', 'adulte']) {
      const range = readRange(patch[who]);
      if (!range) continue;
      if (range[0] === activity[who][0] && range[1] === activity[who][1]) continue;
      kept[who] = range;
    }
    if (Object.keys(kept).length) out[activity.id] = kept;
  }
  return out;
}

/** Une plage lisible, remise dans l'ordre et bornée — ou `null` si ce n'en est pas une. */
function readRange(value) {
  if (!Array.isArray(value) || value.length < 2) return null;
  const lo = Number(value[0]);
  const hi = Number(value[1]);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  const a = clampKmh(lo);
  const b = clampKmh(hi);
  return [Math.min(a, b), Math.max(a, b)];
}

export function skiActivity(id) {
  const table = skiActivities();
  return table.find((a) => a.id === id)
    ?? table.find((a) => a.id === DEFAULT_ACTIVITY_ID)
    ?? table[0];
}

export function whoLabel(who) {
  return SKI_WHO.find((w) => w.id === who)?.label ?? 'Adulte';
}

/**
 * Enveloppe de vitesse à tenir, en km/h, pour une activité et une personne.
 *
 * @param {string} activityId
 * @param {'enfant'|'adulte'} who
 * @returns {{minKmh:number, maxKmh:number, openEnded:boolean}}
 */
export function speedEnvelope(activityId, who) {
  const activity = skiActivity(activityId);
  const [minKmh, maxKmh] = activity[who === 'enfant' ? 'enfant' : 'adulte'];
  // Le « 55+ » du slalom ne vaut que pour l'adulte : la plage enfant, elle, est fermée.
  return { minKmh, maxKmh, openEnded: Boolean(activity.openEnded) && who !== 'enfant' };
}

/** Enveloppe saisie à la main, remise dans l'ordre et bornée au plausible. */
export function manualEnvelope(minKmh, maxKmh) {
  const lo = clampKmh(minKmh);
  const hi = clampKmh(maxKmh);
  return { minKmh: Math.min(lo, hi), maxKmh: Math.max(lo, hi), openEnded: false };
}

function clampKmh(value) {
  const v = Number(value);
  return Number.isFinite(v) ? Math.min(Math.max(v, 1), 90) : 25;
}

/**
 * Où se situe la vitesse par rapport à l'enveloppe.
 *
 * `'slow'` / `'in'` / `'fast'`, et `'unknown'` quand le GPS ne donne pas de vitesse — cas
 * fréquent au ralenti, et qu'il ne faut surtout pas confondre avec « trop lent » : le HUD
 * afficherait « accélère » à l'arrêt, et le chrono ne partirait jamais.
 */
export function envelopeState(speedKmh, env) {
  if (!Number.isFinite(speedKmh) || !env) return 'unknown';
  if (speedKmh < env.minKmh) return 'slow';
  if (!env.openEnded && speedKmh > env.maxKmh) return 'fast';
  return 'in';
}

/**
 * Position de la vitesse sur la jauge du HUD, dans [0, 1].
 *
 * L'enveloppe occupe le TIERS CENTRAL, quelle que soit sa largeur : c'est ce qui donne une
 * jauge lisible aussi bien pour la bouée (15–30, large) que pour le wakeskate (28–32,
 * étroite). Une jauge à échelle absolue aurait réduit cette dernière à un trait.
 */
export function gaugePosition(speedKmh, env) {
  if (!Number.isFinite(speedKmh) || !env) return 0;
  const span = Math.max(env.maxKmh - env.minKmh, 1);
  const ratio = (speedKmh - env.minKmh) / span; // 0 au minimum, 1 au maximum
  return Math.min(Math.max((ratio + 1) / 3, 0), 1);
}

/** Bornes de l'enveloppe sur la jauge : le tiers central, par construction. */
export const GAUGE_BAND = { start: 1 / 3, end: 2 / 3 };

/** « 28 – 34 km/h », « 35 – 55+ km/h » : l'enveloppe telle qu'on l'annonce. */
export function envelopeLabel(env, unit = 'kmh') {
  if (!env) return '—';
  if (unit === 'kn') {
    return `${toKnots(env.minKmh)} – ${toKnots(env.maxKmh)}${env.openEnded ? '+' : ''} nds`;
  }
  return `${round1(env.minKmh)} – ${round1(env.maxKmh)}${env.openEnded ? '+' : ''} km/h`;
}

const round1 = (v) => Number(v.toFixed(1)).toLocaleString('fr-FR');
const toKnots = (kmh) => round1(kmh * KN_PER_KMH);

/** « 25 – 30 km/h » : une plage du tableau, telle quelle. */
export function rangeLabel([min, max], openEnded = false) {
  return `${min}–${max}${openEnded ? '+' : ''} km/h`;
}

/** « 12:30 », « 1:05:00 » : un chrono se lit en minutes et secondes. */
export function formatChrono(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return h > 0 ? `${h}:${mm}:${String(s).padStart(2, '0')}` : `${mm}:${String(s).padStart(2, '0')}`;
}

/** « 15 min », « 1 h 30 » : une durée de chrono proposée au choix. */
export function chronoLabel(seconds) {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${h} h ${String(rest).padStart(2, '0')}` : `${h} h`;
}

/**
 * Déclencheur automatique du chrono : « près de la cible depuis plus de dix secondes ».
 *
 * Réducteur pur, appelé à chaque point GPS. `prev` est l'état rendu au coup précédent
 * (`null` au départ) ; sortir de la zone remet le compte à zéro, y rentrer le relance. Le
 * drapeau `fire` n'est vrai qu'à l'instant du franchissement, pas tant qu'on reste au-delà :
 * c'est un front, et l'appelant n'a rien à retenir pour éviter un second départ.
 *
 * @param {?{since:?number, fired:boolean}} prev
 * @param {{speedKmh:number, env:object, atMs:number, holdMs?:number, ratio?:number}} sample
 * @returns {{since:?number, heldMs:number, fired:boolean, fire:boolean}}
 */
export function autoStartTracker(prev, {
  speedKmh, env, atMs, holdMs = AUTO_START_HOLD_MS, ratio = AUTO_START_RATIO,
}) {
  const near = Number.isFinite(speedKmh) && env
    && speedKmh >= env.minKmh * ratio
    && (env.openEnded || speedKmh <= env.maxKmh * 1.15);
  if (!near) return { since: null, heldMs: 0, fired: false, fire: false };
  const since = prev?.since ?? atMs;
  const heldMs = Math.max(0, atMs - since);
  const fire = heldMs >= holdMs && !prev?.fired;
  return { since, heldMs, fired: Boolean(prev?.fired) || fire, fire };
}

/**
 * Compteur de chutes : un arrêt franc après une traction établie.
 *
 * Trois états, et il en faut trois. `'idle'` : rien à récupérer, un arrêt ne dit rien.
 * `'tow'` : on tire, donc quelqu'un est derrière. `'stop'` : le bateau s'est arrêté alors
 * qu'il tirait — on attend `holdMs` avant de conclure, parce qu'un ralentissement de
 * virage, un creux de vague ou une perte momentanée de signal GPS descendent la vitesse à
 * zéro sans que personne ne soit tombé.
 *
 * @param {?{phase:string, since:?number}} prev
 * @param {{speedKmh:number, env:object, atMs:number, stopKmh?:number, holdMs?:number, towRatio?:number}} sample
 * @returns {{phase:'idle'|'tow'|'stop', since:?number, fell:boolean}}
 */
export function fallTracker(prev, {
  speedKmh, env, atMs, stopKmh = STOP_KMH, holdMs = FALL_HOLD_MS, towRatio = TOW_RATIO,
}) {
  const phase = prev?.phase ?? 'idle';
  const towKmh = (env?.minKmh ?? 20) * towRatio;
  const v = Number.isFinite(speedKmh) ? speedKmh : null;

  if (v == null) return { phase, since: prev?.since ?? null, fell: false };

  if (phase === 'idle') {
    return { phase: v >= towKmh ? 'tow' : 'idle', since: null, fell: false };
  }
  if (phase === 'tow') {
    return v <= stopKmh
      ? { phase: 'stop', since: atMs, fell: false }
      : { phase: 'tow', since: null, fell: false };
  }
  // phase 'stop' : l'arrêt se confirme, ou il n'en était pas un.
  if (v > stopKmh) {
    // Reparti : si l'on a retrouvé la vitesse de traction, c'est qu'on n'a jamais lâché.
    return { phase: v >= towKmh ? 'tow' : 'idle', since: null, fell: false };
  }
  const held = atMs - (prev?.since ?? atMs);
  if (held >= holdMs) return { phase: 'idle', since: null, fell: true };
  return { phase: 'stop', since: prev?.since ?? atMs, fell: false };
}

/** Vitesse moyenne, en km/h, d'une distance parcourue en un temps donné. */
export function averageKmh(metres, seconds) {
  if (!(seconds > 0) || !Number.isFinite(metres)) return 0;
  return (metres / 1000) / (seconds / 3600);
}

/**
 * Totaux de toutes les sessions de ski : c'est la ligne « depuis le début » de l'Historique.
 *
 * La moyenne générale est celle des DISTANCES sur les DURÉES cumulées, et non la moyenne
 * des moyennes : deux sessions de dix minutes et de deux heures ne pèsent pas pareil, et la
 * moyenne des moyennes le lui aurait fait croire.
 *
 * @param {{distanceM:number, durationS:number, falls?:number, chronoS?:number}[]} sessions
 */
export function skiTotals(sessions) {
  const list = Array.isArray(sessions) ? sessions : [];
  const distanceM = list.reduce((sum, s) => sum + (Number(s.distanceM) || 0), 0);
  const durationS = list.reduce((sum, s) => sum + (Number(s.durationS) || 0), 0);
  // Le meilleur tour est le PLUS COURT, et il ne s'additionne pas : c'est un record, pas un
  // cumul. Les sorties sans tour ne pèsent pas dessus — `null` n'est pas un tour de zéro.
  const bests = list.map((s) => Number(s.bestLapS)).filter((v) => v > 0);
  return {
    count: list.length,
    distanceM,
    durationS,
    avgKmh: averageKmh(distanceM, durationS),
    falls: list.reduce((sum, s) => sum + (Number(s.falls) || 0), 0),
    chronoS: list.reduce((sum, s) => sum + (Number(s.chronoS) || 0), 0),
    laps: list.reduce((sum, s) => sum + (Number(s.laps) || 0), 0),
    bestLapS: bests.length ? Math.min(...bests) : null,
  };
}

/** Résumé d'une session, tel qu'il part à l'Historique puis au partage. */
export function skiSummary({
  activity, who, env, targetS, chronoS, chronoRuns, falls, avgKmh, topKmh, inZonePct,
  laps, bestLapS, lapTimesS,
}) {
  return {
    activity,
    activityName: skiActivity(activity).name,
    who,
    min_kmh: round2(env?.minKmh),
    max_kmh: round2(env?.maxKmh),
    open_ended: Boolean(env?.openEnded),
    target_s: Math.round(targetS || 0),
    chrono_s: Math.round(chronoS || 0),
    chrono_runs: Math.round(chronoRuns || 0),
    falls: Math.round(falls || 0),
    avg_kmh: round2(avgKmh),
    top_kmh: round2(topKmh),
    in_zone_pct: Math.round(inZonePct || 0),
    laps: Math.round(laps || 0),
    // Meilleur tour : absent tant qu'aucun tour n'a été bouclé. Zéro dirait « en un
    // instant », ce qui se lirait comme un record imbattable.
    best_lap_s: bestLapS > 0 ? Math.round(bestLapS) : null,
    // La série des tours, dans l'ordre où ils ont été bouclés : c'est elle qu'on relit
    // le soir, le record ne disant pas si l'allure a tenu. Liste vide plutôt qu'absente
    // — elle se parcourt sans avoir à se demander si elle existe.
    lap_times_s: Array.isArray(lapTimesS)
      ? lapTimesS.map((v) => Math.round(v)).filter((v) => v > 0) : [],
  };
}

const round2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
