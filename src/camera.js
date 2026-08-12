// Suivi de caméra : où est le bateau à l'écran, et ce que la carte doit montrer.
//
// Deux principes, tirés de deux pannes successives.
//
// 1. Un seul endroit commande la vue. Le recentrage (`easeTo`) et le « cap en haut »
//    (`setBearing`) la pilotaient chacun de leur côté ; or `setBearing` passe par `jumpTo`,
//    qui commence par `stop()`. Chaque mesure de boussole — une par image — annulait
//    l'animation de recentrage avant qu'elle n'ait parcouru 1 % de sa course. Cap en haut
//    activé, le suivi ne rattrapait plus rien.
//
// 2. On n'affiche pas le dernier point GPS, on affiche une position **continue**. Le GPS
//    ne parle qu'une fois par seconde : y accrocher directement le bateau le fait sauter
//    de trois mètres à chaque point, et y accrocher la caméra la fait avancer par à-coups
//    — elle rejoint le point en sept dixièmes de seconde puis attend le suivant, immobile.
//    D'où une carte qui sursaute une fois par seconde. On tient donc à la place une
//    estime : entre deux points, le bateau avance à son cap et à sa vitesse, mis à jour à
//    chaque image ; quand un point arrive, l'écart n'est pas rattrapé d'un bond mais
//    absorbé en une demi-seconde. Le bateau reste alors immobile au centre de l'écran et
//    c'est le monde qui défile, ce qu'on attend d'un traceur de navigation.
//
// L'estime ne sert qu'à l'affichage. La profondeur lue, les sondes enregistrées et
// l'étalonnage restent adossés au point GPS vrai : on ne mesure pas sur une position
// interpolée.

import { distanceMeters } from './geo.js';

const M_PER_DEG_LAT = 111320;
const DEG = Math.PI / 180;

/** Absorption de l'écart entre l'estime et l'affichage (s). Lisse aussi le bruit GPS. */
export const POSITION_TAU_S = 0.5;
/** Cap affiché : filtre le tremblement de la boussole, qui ferait vibrer toute la carte. */
export const HEADING_TAU_S = 0.35;
/** Retour au nord, quand « cap en haut » est relâché. */
export const NORTH_TAU_S = 0.25;
/** Pas de zoom des boutons, et douceur de son application. */
export const ZOOM_TAU_S = 0.2;
export const ZOOM_SETTLED = 0.002;
/** En deçà, c'est arrivé : on se pose exactement sur la cible et la boucle s'arrête. */
export const POSITION_SETTLED_M = 0.05;
export const BEARING_SETTLED_DEG = 0.05;
/**
 * Écart à partir duquel on redonne un centre à la carte. Bien plus fin que le seuil
 * d'arrêt : à 10 km/h le bateau n'avance que de 4,6 cm par image, et un seuil de 5 cm
 * faisait sauter une image sur deux — la caméra avançait par crans au lieu de glisser.
 */
const CENTER_EPSILON_M = 0.01;
/**
 * Plafond de vitesse de correction : multiple de la vitesse du bateau, plus un plancher
 * (m/s) pour qu'à l'arrêt l'écart se résorbe quand même. Sans lui, un point GPS bruité de
 * deux mètres était absorbé proportionnellement, soit une pointe à trois fois la vitesse
 * du bateau à chaque seconde — le bateau donnait un coup de reins à chaque point. Avec
 * lui, la correction est linéaire tant qu'elle est vive, donc sans à-coup, et redevient
 * exponentielle près du but.
 */
const CORRECTION_FACTOR = 1.6;
const CORRECTION_FLOOR_MS = 0.5;
/** Écart si grand qu'il ne peut pas être une dérive : reprise du GPS, on s'y pose net. */
const TELEPORT_M = 50;
/** Vitesse au-delà de laquelle le GPS raconte n'importe quoi (m/s ≈ 108 km/h). */
const MAX_TRUSTED_SPEED_MS = 30;
/** Durée maximale d'extrapolation : GPS perdu, le bateau ne doit pas s'envoler. */
const MAX_DEAD_RECKONING_S = 4;
/** Image anormalement longue (onglet masqué, pic de charge) : on plafonne le pas. */
const MAX_STEP_S = 0.25;

/**
 * Fraction du chemin restant parcourue pendant `dt` secondes, pour une constante de temps
 * `tau`. Indépendant de la cadence : deux images de 8 ms avancent autant qu'une de 16 ms,
 * donc le mouvement est le même à 60 et à 120 Hz.
 */
export function catchUp(dt, tau) {
  if (!(dt > 0) || !(tau > 0)) return 0;
  return 1 - Math.exp(-Math.min(dt, MAX_STEP_S) / tau);
}

/** Écart angulaire signé le plus court, de `from` vers `to`, dans ]−180, 180]. */
export function angleDelta(from, to) {
  return ((to - from + 540) % 360) - 180;
}

/**
 * Position du bateau à l'instant `now`, extrapolée depuis le dernier point GPS.
 * Rend le point brut si la vitesse ou le cap manquent — à l'arrêt, le GPS ne donne pas de
 * cap fiable et extrapoler ferait dériver le bateau tout seul.
 */
export function deadReckon(fix, now) {
  if (!fix) return null;
  const { lon, lat, speed, heading, at } = fix;
  if (!(speed > 0) || speed > MAX_TRUSTED_SPEED_MS || !Number.isFinite(heading)) return [lon, lat];
  const elapsed = Math.min(Math.max((now - at) / 1000, 0), MAX_DEAD_RECKONING_S);
  const north = speed * Math.cos(heading * DEG) * elapsed;
  const east = speed * Math.sin(heading * DEG) * elapsed;
  return [
    lon + east / (M_PER_DEG_LAT * Math.cos(lat * DEG)),
    lat + north / M_PER_DEG_LAT,
  ];
}

/**
 * État d'affichage du bateau et ordre de caméra qui en découle.
 *
 * Volontairement sans dépendance à MapLibre : c'est du calcul pur, donc vérifiable hors
 * navigateur — et c'est exactement là que se logeaient les deux bugs de suivi.
 */
export class CameraFollow {
  constructor() {
    this.follow = false;
    this.trackUp = false;
    this.toNorth = false;
    this.fix = null;          // dernier point GPS vrai { lon, lat, speed, heading, at }
    this.heading = null;      // cap mesuré (boussole ou GPS)
    this.shown = null;        // position affichée, continue
    this.shownHeading = null; // cap affiché, amorti
    this.zoomTarget = null;   // zoom visé par les boutons, null quand il n'y en a pas
    this.last = 0;            // horodatage de l'image précédente
  }

  /**
   * Zoom visé par les boutons. Il passe par la boucle plutôt que par un `easeTo`, qui
   * serait annulé dès l'image suivante par le `jumpTo` du suivi — le piège d'origine.
   * `null` rend le zoom à l'utilisateur : le pincement n'a plus rien à combattre.
   */
  setZoom(target) {
    this.zoomTarget = Number.isFinite(target) ? target : null;
  }

  /** Nouveau point GPS. L'affichage n'y saute pas : il l'absorbe (voir en-tête). */
  setFix(fix) {
    this.fix = fix;
  }

  setHeading(heading) {
    if (Number.isFinite(heading)) this.heading = heading;
  }

  setFollow(on) {
    this.follow = Boolean(on);
  }

  /**
   * Relâcher le cap en haut arme le retour au nord ; le réactiver l'annule, plutôt que de
   * laisser traîner une intention morte que le premier passage près du nord viendrait
   * solder.
   */
  setTrackUp(on) {
    const next = Boolean(on);
    if (this.trackUp === next) return; // sans quoi un simple rafraîchissement d'écran
    this.trackUp = next;               // armerait un retour au nord parasite
    this.toNorth = !next;
  }

  /** À appeler quand la boucle a été interrompue : le prochain pas repart d'un dt sain. */
  resetClock() {
    this.last = 0;
  }

  /**
   * Avance l'état d'affichage jusqu'à `now`, et rend ce qu'il faut appliquer.
   *
   * @param {number} now  horodatage de l'image (ms).
   * @param {{center: ?number[], bearing: number}} view  état actuel de la carte.
   * @returns {{position: ?number[], heading: ?number, center: ?number[], bearing: ?number,
   *            done: boolean}}
   *   `position`/`heading` : où dessiner le bateau. `center`/`bearing` : ce qu'il faut
   *   commander à la carte, `null` s'il n'y a rien à changer. `done` : plus rien ne bouge,
   *   la boucle peut s'arrêter jusqu'à la prochaine mesure — au mouillage, aucune image
   *   n'est calculée, donc pas de GPU qui tourne et pas de téléphone qui chauffe.
   */
  step(now, view) {
    const dt = this.last ? (now - this.last) / 1000 : 1 / 60;
    this.last = now;

    let done = true;

    // --- position affichée : estime, puis absorption de l'écart -------------------
    const predicted = deadReckon(this.fix, now);
    if (predicted) {
      if (!this.shown) {
        this.shown = predicted; // premier point : on se pose dessus
      } else {
        const gap = distanceMeters(this.shown[0], this.shown[1], predicted[0], predicted[1]);
        if (gap > TELEPORT_M) {
          this.shown = predicted;
        } else if (gap > POSITION_SETTLED_M) {
          const k = catchUp(dt, POSITION_TAU_S);
          const ceiling = (Math.max(this.fix.speed ?? 0, 0) * CORRECTION_FACTOR
            + CORRECTION_FLOOR_MS) * Math.min(dt, MAX_STEP_S);
          const ratio = gap * k > ceiling ? ceiling / gap : k;
          this.shown = [
            this.shown[0] + (predicted[0] - this.shown[0]) * ratio,
            this.shown[1] + (predicted[1] - this.shown[1]) * ratio,
          ];
          done = false; // en route : l'estime avance encore, il faudra une autre image
        } else if (gap > 0) {
          this.shown = predicted;
        }
      }
    }

    // --- cap affiché : amorti, sinon la carte entière vibre -----------------------
    if (Number.isFinite(this.heading)) {
      if (this.shownHeading == null) {
        this.shownHeading = this.heading;
      } else {
        const delta = angleDelta(this.shownHeading, this.heading);
        if (Math.abs(delta) > BEARING_SETTLED_DEG) {
          this.shownHeading = (this.shownHeading + delta * catchUp(dt, HEADING_TAU_S) + 360) % 360;
          done = false; // l'aiguille tourne encore — et la carte avec, en cap en haut
        } else {
          this.shownHeading = this.heading;
        }
      }
    }

    // --- ordre de caméra ----------------------------------------------------------
    const out = {
      position: this.shown,
      heading: this.shownHeading,
      center: null,
      bearing: null,
      zoom: null,
      done,
    };

    if (this.zoomTarget !== null && Number.isFinite(view.zoom)) {
      const delta = this.zoomTarget - view.zoom;
      if (Math.abs(delta) > ZOOM_SETTLED) {
        out.zoom = view.zoom + delta * catchUp(dt, ZOOM_TAU_S);
        out.done = false;
      } else {
        out.zoom = this.zoomTarget;
        this.zoomTarget = null; // arrivé : le zoom redevient celui de l'utilisateur
      }
    }

    // Le centre est collé à la position affichée, sans amortissement supplémentaire :
    // celui-ci est déjà dans l'estime. Amortir une seconde fois ne ferait que décoller le
    // bateau du centre à chaque accélération — l'inverse d'un verrouillage.
    if (this.follow && this.shown) {
      const moved = !view.center
        || distanceMeters(view.center[0], view.center[1], this.shown[0], this.shown[1])
          > CENTER_EPSILON_M;
      if (moved) out.center = this.shown;
    }

    const wanted = this.trackUp && Number.isFinite(this.shownHeading) ? this.shownHeading
      : this.toNorth ? 0 : null;
    if (wanted !== null) {
      const delta = angleDelta(view.bearing, wanted);
      if (this.trackUp) {
        // Le cap est déjà amorti plus haut : l'appliquer tel quel ne transmet plus de
        // tremblement, et n'ajoute pas le retard d'un second filtre.
        if (Math.abs(delta) > BEARING_SETTLED_DEG) out.bearing = wanted;
      } else if (Math.abs(delta) > BEARING_SETTLED_DEG) {
        out.bearing = view.bearing + delta * catchUp(dt, NORTH_TAU_S);
        out.done = false;
      } else if (delta !== 0) {
        out.bearing = 0;
      }
    }

    return out;
  }
}
