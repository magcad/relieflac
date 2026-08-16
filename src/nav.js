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
 * Solution de navigation le long d'un trajet, à partir du dernier point de passage atteint.
 *
 * Le ciblage est séquentiel : on vise le point qui suit le dernier franchi (`fromIndex`),
 * et l'on avance dès qu'on entre dans son rayon d'arrivée. Séquentiel plutôt que « point le
 * plus proche » : un trajet peut se recouper ou repasser près d'un point déjà franchi, et
 * viser alors le plus proche ferait sauter la cible en arrière.
 *
 * @param {number[][]} points  trajet, suite de [lon, lat]
 * @param {number[]} boat  position du bateau [lon, lat]
 * @param {{fromIndex?:number, arriveRadiusM?:number}} [state]
 * @returns {?object}  null si le trajet est vide, sinon cap, distances, écart, arrivée.
 */
export function navSolution(points, boat, { fromIndex = 0, arriveRadiusM = 20 } = {}) {
  const last = points.length - 1;
  if (last < 0) return null;

  // Trajet réduit à un seul point : « aller là », sans segment ni écart de route.
  if (last === 0) {
    const distToTarget = distanceMeters(boat[0], boat[1], points[0][0], points[0][1]);
    return {
      fromIndex: 0, targetIndex: 0, target: points[0], legFrom: boat, legTo: points[0],
      bearing: bearing(boat[0], boat[1], points[0][0], points[0][1]),
      distToTarget, distRemaining: distToTarget, crossM: 0,
      arrived: distToTarget <= arriveRadiusM, waypointCount: 1,
    };
  }

  let from = Math.min(Math.max(fromIndex, 0), last - 1);
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
  const { crossM } = projectOnSegment(legFrom, legTo, boat);

  // Distance restante : jusqu'à la cible, puis le long des segments qui suivent.
  let remaining = distToTarget;
  for (let i = target; i < last; i += 1) {
    remaining += distanceMeters(points[i][0], points[i][1], points[i + 1][0], points[i + 1][1]);
  }

  return {
    fromIndex: from, targetIndex: target, target: legTo, legFrom, legTo,
    bearing: course, distToTarget, distRemaining: remaining, crossM,
    arrived: target === last && distToTarget <= arriveRadiusM,
    waypointCount: points.length,
  };
}
