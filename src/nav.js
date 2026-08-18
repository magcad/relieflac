// Navigation le long d'un trajet : cap à tenir, écart de route, distance restante.
//
// Tout est calcul pur — aucune dépendance à MapLibre ni au DOM — pour rester vérifiable
// hors navigateur, exactement comme camera.js. C'est là que se logent les erreurs de
// projection et de signe, et un banc de test les attrape sans lancer la carte.
//
// Convention de signe de l'écart de route (`crossM`) : POSITIF quand le bateau est à
// DROITE de la route dans le sens du segment. C'est ce qu'attend un barreur — « tu es à
// droite, viens à gauche » — et c'est aussi le sens de rotation horaire de l'aiguille de
// gouverne dans le HUD.

import { bearing, distanceMeters } from './geo.js';

const M_PER_DEG_LAT = 111320;

/**
 * Distance à laquelle on considère le parcours « ré-accroché » après un raccourci.
 *
 * Un trajet n'est pas un rail : on coupe un cap, on contourne un pêcheur, on rejoint la
 * route trois points de passage plus loin. Le ciblage purement séquentiel visait alors
 * toujours le point de passage abandonné, donc en arrière — un cap à 180° de la marche.
 * Revenir à moins de 50 m d'un segment plus avancé vaut donc franchissement de tout ce
 * qui le précède.
 */
export const REJOIN_RADIUS_M = 50;

/**
 * Marge exigée avant de sauter en avant : le segment retrouvé doit être franchement plus
 * près que celui qu'on suit. Sans elle, deux jambes voisines — le retour d'un aller-retour
 * passe souvent à quelques dizaines de mètres de l'aller — se voleraient la cible au gré
 * du bruit GPS, et le trajet se terminerait avant d'avoir commencé.
 */
const REJOIN_MARGIN_M = 8;

/** Écart de cap au-delà duquel un segment ne peut pas être celui qu'on vient de rejoindre. */
const REJOIN_HEADING_TOLERANCE_DEG = 90;

/** Écart angulaire signé le plus court, de `from` vers `to`, dans ]−180, 180]. */
export function angleDelta(from, to) {
  return ((to - from + 540) % 360) - 180;
}

/** Repère métrique local (est, nord en mètres) autour d'un point d'origine. */
function toLocal([lon, lat], [lon0, lat0]) {
  const mPerDegLon = M_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180);
  return [(lon - lon0) * mPerDegLon, (lat - lat0) * M_PER_DEG_LAT];
}

/**
 * Projette le bateau sur le segment [from → to], en repère métrique local.
 *
 * @returns {{t:number, alongM:number, crossM:number, segLenM:number}}
 *   `t` : fraction parcourue le long du segment, bornée à [0, 1] ;
 *   `alongM` : distance parcourue le long du segment (m) ;
 *   `crossM` : écart latéral signé (m), positif à droite de la route ;
 *   `segLenM` : longueur du segment (m).
 */
export function projectOnSegment(from, to, boat) {
  const [ex, ey] = toLocal(to, from);
  const [bx, by] = toLocal(boat, from);
  const segLenM = Math.hypot(ex, ey);
  if (segLenM < 1e-6) {
    return { t: 0, alongM: 0, crossM: Math.hypot(bx, by), segLenM: 0 };
  }
  const ux = ex / segLenM;
  const uy = ey / segLenM;
  const alongRaw = bx * ux + by * uy;
  const t = Math.min(Math.max(alongRaw / segLenM, 0), 1);
  // Normale « à droite » du cap (est, nord) : rotation horaire de (ux, uy) donne (uy, −ux).
  const crossM = bx * uy - by * ux;
  return { t, alongM: t * segLenM, crossM, segLenM };
}

/**
 * Distance du bateau au segment [a → b], bornes comprises (m).
 *
 * Distinct de `crossM`, qui mesure l'écart à la droite **infinie** portant le segment : à
 * l'aplomb d'un point de passage, cette droite passe encore sous le bateau alors que le
 * segment, lui, s'est arrêté. Pour décider d'un ré-accrochage, c'est bien le segment fini
 * qu'il faut mesurer.
 */
export function distanceToSegment(a, b, boat) {
  const [ex, ey] = toLocal(b, a);
  const [bx, by] = toLocal(boat, a);
  const lenSq = ex * ex + ey * ey;
  if (lenSq < 1e-12) return Math.hypot(bx, by);
  const t = Math.min(Math.max((bx * ex + by * ey) / lenSq, 0), 1);
  return Math.hypot(bx - t * ex, by - t * ey);
}

/**
 * Segment plus avancé sur lequel le bateau vient de se ré-accrocher, ou −1.
 *
 * On retient le segment le plus proche parmi ceux qui restent à parcourir, à condition
 * qu'il soit dans le rayon, franchement plus près que celui qu'on suivait, et — si le cap
 * est connu — orienté dans le sens de la marche. Ce dernier garde-fou est celui qui sauve
 * les allers-retours : le brin du retour longe celui de l'aller, mais à contre-sens.
 *
 * @param {number[][]} points  trajet, suite de [lon, lat]
 * @param {number[]} boat  position du bateau [lon, lat]
 * @param {number} fromIndex  segment actuellement suivi
 * @param {{radiusM?:number, heading?:?number}} [options]
 */
export function rejoinIndex(points, boat, fromIndex, { radiusM = REJOIN_RADIUS_M, heading = null } = {}) {
  const last = points.length - 1;
  if (last < 2 || fromIndex >= last - 1) return -1;

  const currentD = distanceToSegment(points[fromIndex], points[fromIndex + 1], boat);
  let best = -1;
  let bestD = radiusM;
  for (let i = fromIndex + 1; i < last; i += 1) {
    const d = distanceToSegment(points[i], points[i + 1], boat);
    if (d >= bestD) continue;
    if (Number.isFinite(heading)) {
      const course = bearing(points[i][0], points[i][1], points[i + 1][0], points[i + 1][1]);
      if (Math.abs(angleDelta(heading, course)) > REJOIN_HEADING_TOLERANCE_DEG) continue;
    }
    bestD = d;
    best = i;
  }
  return best >= 0 && bestD + REJOIN_MARGIN_M < currentD ? best : -1;
}

/**
 * Solution de navigation le long d'un trajet, à partir du dernier point de passage atteint.
 *
 * Le ciblage est séquentiel : on vise le point qui suit le dernier franchi (`fromIndex`),
 * et l'on avance dès qu'on entre dans son rayon d'arrivée. Séquentiel plutôt que « point le
 * plus proche » : un trajet peut se recouper ou repasser près d'un point déjà franchi, et
 * viser alors le plus proche ferait sauter la cible en arrière. Le seul saut consenti est
 * le saut en AVANT du ré-accrochage (voir `rejoinIndex`), qui solde les points de passage
 * qu'un raccourci a laissés de côté.
 *
 * @param {number[][]} points  trajet, suite de [lon, lat]
 * @param {number[]} boat  position du bateau [lon, lat]
 * @param {{fromIndex?:number, arriveRadiusM?:number, rejoinRadiusM?:number, heading?:?number}} [state]
 * @returns {?object}  null si le trajet est vide, sinon cap, distances, écart, arrivée.
 */
export function navSolution(points, boat, {
  fromIndex = 0, arriveRadiusM = 20, rejoinRadiusM = REJOIN_RADIUS_M, heading = null,
} = {}) {
  const last = points.length - 1;
  if (last < 0) return null;

  // Trajet réduit à un seul point : « aller là », sans segment ni écart de route.
  if (last === 0) {
    const distToTarget = distanceMeters(boat[0], boat[1], points[0][0], points[0][1]);
    return {
      fromIndex: 0, targetIndex: 0, target: points[0], legFrom: boat, legTo: points[0],
      bearing: bearing(boat[0], boat[1], points[0][0], points[0][1]),
      distToTarget, distRemaining: distToTarget, crossM: 0, alongM: 0,
      snapped: [boat[0], boat[1]], rejoined: false,
      arrived: distToTarget <= arriveRadiusM, waypointCount: 1,
    };
  }

  let from = Math.min(Math.max(fromIndex, 0), last - 1);

  // Ré-accrochage d'abord : un raccourci a pu rendre caduque toute une portion du trajet,
  // et l'avancement séquentiel qui suit doit repartir du segment réellement suivi.
  const rejoin = rejoinIndex(points, boat, from, { radiusM: rejoinRadiusM, heading });
  const rejoined = rejoin > from;
  if (rejoined) from = rejoin;

  let target = from + 1;
  // Avancement : dans le rayon d'arrivée d'un point de passage intermédiaire, on vise le suivant.
  while (target < last
    && distanceMeters(boat[0], boat[1], points[target][0], points[target][1]) <= arriveRadiusM) {
    from = target;
    target = from + 1;
  }

  const legFrom = points[from];
  const legTo = points[target];
  const distToTarget = distanceMeters(boat[0], boat[1], legTo[0], legTo[1]);
  const course = bearing(boat[0], boat[1], legTo[0], legTo[1]);
  const { crossM, t, alongM } = projectOnSegment(legFrom, legTo, boat);

  // Distance restante : jusqu'à la cible, puis le long des segments qui suivent.
  let remaining = distToTarget;
  for (let i = target; i < last; i += 1) {
    remaining += distanceMeters(points[i][0], points[i][1], points[i + 1][0], points[i + 1][1]);
  }

  return {
    fromIndex: from, targetIndex: target, target: legTo, legFrom, legTo,
    bearing: course, distToTarget, distRemaining: remaining, crossM, alongM, rejoined,
    // Point du trajet à l'aplomb du bateau : c'est là que s'arrête la portion parcourue.
    snapped: [
      legFrom[0] + (legTo[0] - legFrom[0]) * t,
      legFrom[1] + (legTo[1] - legFrom[1]) * t,
    ],
    arrived: target === last && distToTarget <= arriveRadiusM,
    waypointCount: points.length,
  };
}

/**
 * Découpe le trajet en deux au point atteint : ce qui est fait, ce qui reste.
 *
 * Les deux tronçons partagent le point de coupure, sans quoi la route montrerait un trou
 * d'un pixel à l'endroit précis que l'œil surveille — sous le bateau.
 *
 * @param {number[][]} points  trajet complet
 * @param {number} fromIndex  segment en cours
 * @param {?number[]} snapped  projection du bateau sur ce segment
 * @returns {{done:number[][], todo:number[][]}}
 */
export function splitRoute(points, fromIndex, snapped) {
  if (!Array.isArray(points) || points.length < 2) return { done: [], todo: [] };
  if (!Array.isArray(snapped)) return { done: [], todo: points.map((p) => [p[0], p[1]]) };
  const cut = Math.min(Math.max(fromIndex, 0), points.length - 2);
  const head = points.slice(0, cut + 1).map((p) => [p[0], p[1]]);
  const tail = points.slice(cut + 1).map((p) => [p[0], p[1]]);
  const at = [snapped[0], snapped[1]];
  return { done: [...head, at], todo: [at, ...tail] };
}

/**
 * Chevrons jalonnant le trajet, chacun avec le relèvement du segment qui le porte.
 *
 * L'orientation est calculée ici, et non laissée à la pose sur ligne de MapLibre : celle-ci
 * couche le dessin le long de la ligne comme une ligne de texte — l'axe HORIZONTAL de
 * l'image suit la route — si bien qu'un chevron dessiné pointe en haut sortait à 90° de la
 * marche. Un relèvement explicite ne dépend plus d'aucune convention de rendu.
 *
 * `alongM` (distance depuis le départ) accompagne chaque chevron : c'est ce qui permet de
 * teindre en vert ceux qui sont derrière le bateau.
 *
 * @param {number[][]} points  trajet, suite de [lon, lat]
 * @param {number} spacingM  pas entre deux chevrons (m)
 * @returns {{lon:number, lat:number, bearing:number, alongM:number}[]}
 */
export function routeChevrons(points, spacingM = 40) {
  const marks = [];
  if (!Array.isArray(points) || points.length < 2 || !(spacingM > 0)) return marks;
  let next = spacingM / 2; // le premier chevron ne se pose pas sur le départ
  let travelled = 0;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    const segLenM = distanceMeters(a[0], a[1], b[0], b[1]);
    if (!(segLenM > 0)) continue;
    const course = bearing(a[0], a[1], b[0], b[1]);
    for (let d = next; d <= segLenM; d += spacingM) {
      const t = d / segLenM;
      marks.push({
        lon: a[0] + (b[0] - a[0]) * t,
        lat: a[1] + (b[1] - a[1]) * t,
        bearing: course,
        alongM: travelled + d,
      });
      next = d + spacingM;
    }
    next -= segLenM;
    if (next < 0) next = 0;
    travelled += segLenM;
  }
  return marks;
}

/**
 * Part du parcours à avoir couverte avant qu'un retour au départ vaille un tour.
 *
 * Sans ce verrou, tourner en rond au ponton compterait un tour toutes les vingt secondes.
 * Sept dixièmes plutôt que la totalité : sur un circuit, le bateau coupe le dernier virage
 * plus souvent qu'à son tour, et exiger le parcours entier ne compterait jamais rien.
 */
export const LAP_ARM_RATIO = 0.7;

/** Rayon autour du point de départ qui vaut « revenu » (m). */
export const LAP_RADIUS_M = 40;

/** Durée en deçà de laquelle un tour n'en est pas un (ms) — garde-fou contre le bruit GPS. */
export const LAP_MIN_MS = 20_000;

/**
 * Compteur de tours : combien de fois le bateau a bouclé son parcours.
 *
 * Un tour, c'est REVENIR À SON POINT DE DÉPART après avoir fait le parcours. Cette seule
 * définition couvre les deux formes de trajet sans les distinguer :
 *
 * - un CIRCUIT fermé se boucle en le tournant — on s'arme au fil de l'avancement, et le
 *   retour au départ solde le tour ;
 * - un COULOIR ouvert, celui du ski, se boucle en ALLER-RETOUR — l'avancement atteint le
 *   bout (donc la totalité du parcours, donc l'armement), et le retour au départ solde de
 *   même. Un tour de couloir est un aller-retour, ce qui est bien ce que compte un skieur.
 *
 * L'armement est ce qui empêche de compter deux fois : une fois le tour soldé, il faut
 * refaire le parcours pour en compter un autre. Réducteur pur, sans horloge à lui : c'est
 * l'appelant qui fournit l'instant, et le banc peut donc faire tourner un bateau en une
 * poignée d'appels.
 *
 * @param {?object} prev  état précédent, ou `null` au départ de la sortie
 * @param {{progressRatio:number, distToStartM:number, atMs:number}} sample
 * @returns {{laps:number, armed:boolean, since:number, times:number[], lastLapMs:?number,
 *            bestLapMs:?number, lapped:boolean}}
 */
export function lapTracker(prev, {
  progressRatio, distToStartM, atMs,
  armRatio = LAP_ARM_RATIO, radiusM = LAP_RADIUS_M, minLapMs = LAP_MIN_MS,
} = {}) {
  const state = prev ?? {
    laps: 0, armed: false, since: atMs, times: [], lastLapMs: null, bestLapMs: null,
    lapped: false,
  };
  const armed = state.armed || progressRatio >= armRatio;
  const back = distToStartM <= radiusM;
  if (armed && back && atMs - state.since >= minLapMs) {
    const lapMs = atMs - state.since;
    return {
      laps: state.laps + 1,
      armed: false,
      since: atMs,
      // Chaque tour garde SA durée. Le meilleur seul ne dit pas grand-chose : ce qu'on
      // relit après coup, c'est la série — l'allure tenue, ou le troisième tour où l'on
      // s'écroule. Recopiée plutôt que poussée : le réducteur reste pur, et l'état rendu
      // au tour précédent ne change pas sous les pieds de qui l'aurait gardé.
      times: [...(state.times ?? []), lapMs],
      lastLapMs: lapMs,
      bestLapMs: state.bestLapMs == null ? lapMs : Math.min(state.bestLapMs, lapMs),
      lapped: true,
    };
  }
  return { ...state, armed, lapped: false };
}
