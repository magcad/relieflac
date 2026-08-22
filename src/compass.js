// Cap magnétique de l'appareil, pour la boussole de navigation.
//
// Le cap du GPS (geo.js) n'existe qu'en mouvement : à l'arrêt ou en dérive lente, il est
// nul ou faux. La boussole du téléphone, elle, donne une orientation même immobile — c'est
// ce qu'attend un barreur qui vise un amer. Deux voies selon la plateforme :
//
//   • iOS : `event.webkitCompassHeading`, déjà un cap vrai 0–360 (0 = nord), mais l'accès
//     aux capteurs de mouvement exige une autorisation explicite, déclenchée depuis un
//     geste de l'utilisateur (DeviceOrientationEvent.requestPermission).
//   • Android / autres : `event.alpha` d'un événement *absolu*, converti en cap.
//
// On lisse en circulaire (plus court chemin angulaire) pour que l'aiguille ne tremble pas.

const SMOOTHING = 0.25;

export class Compass extends EventTarget {
  constructor() {
    super();
    this.heading = null;      // cap lissé, 0–360, ou null
    this.source = null;       // 'ios' | 'absolute' | 'relative'
    this.active = false;
    this.granted = false;
    this.hasAbsolute = false; // une source référencée au nord a-t-elle déjà parlé ?
    this.pruned = false;      // l'écouteur relatif redondant a-t-il été retiré ? (Android)
  }

  get available() {
    return typeof window !== 'undefined' && 'DeviceOrientationEvent' in window;
  }

  /** iOS ≥ 13 : l'accès aux capteurs doit être demandé depuis un geste. */
  get needsPermission() {
    return this.available && typeof DeviceOrientationEvent.requestPermission === 'function';
  }

  /**
   * Démarre l'écoute. Sur iOS, doit être appelé depuis un gestionnaire d'événement
   * utilisateur (clic), sinon la demande d'autorisation est refusée silencieusement.
   * @returns {Promise<boolean>} vrai si l'écoute est active.
   */
  async start() {
    if (!this.available) return false;
    if (this.active) return true;

    // Une fois l'autorisation accordée (iOS), elle vaut pour toute la session : inutile de la
    // redemander à chaque reprise après veille — et hors d'un geste, la redemande échouerait.
    if (this.needsPermission && !this.granted) {
      try {
        const state = await DeviceOrientationEvent.requestPermission();
        if (state !== 'granted') return false;
      } catch {
        return false; // pas déclenché par un geste, ou refusé
      }
    }
    this.granted = true;

    // `deviceorientationabsolute` fournit un cap référencé au nord ; à défaut on retombe
    // sur `deviceorientation`, absolu sur iOS via webkitCompassHeading.
    this.pruned = false; // les deux écouteurs sont ré-armés ; le tri se refera à la volée
    if ('ondeviceorientationabsolute' in window) {
      window.addEventListener('deviceorientationabsolute', this.#onEvent);
    }
    window.addEventListener('deviceorientation', this.#onEvent);
    this.active = true;
    return true;
  }

  stop() {
    window.removeEventListener('deviceorientationabsolute', this.#onEvent);
    window.removeEventListener('deviceorientation', this.#onEvent);
    this.active = false;
  }

  // Champ fléché plutôt que méthode privée : `this` reste lié quand on l'ajoute/retire
  // comme écouteur, et une méthode privée n'est de toute façon pas réassignable.
  #onEvent = (event) => {
    // Instantané brut du dernier événement, pour le diagnostic (mail de retour). Capturé
    // avant tout tri, y compris pour les événements relatifs qu'on ignorera ensuite.
    this.lastEvent = {
      type: event.type,
      absolute: event.absolute,
      alpha: Number.isFinite(event.alpha) ? Math.round(event.alpha) : null,
      webkit: Number.isFinite(event.webkitCompassHeading)
        ? Math.round(event.webkitCompassHeading) : null,
      screen: screenAngle(),
    };

    let heading = null;
    let source = null;

    if (Number.isFinite(event.webkitCompassHeading)) {
      heading = event.webkitCompassHeading; // iOS : cap vrai, sens horaire
      source = 'ios';
    } else if (Number.isFinite(event.alpha)) {
      // alpha : rotation autour de l'axe vertical, sens antihoraire depuis l'est. Le cap
      // de l'appareil (nez du téléphone) est 360 − alpha, ajusté de l'orientation écran.
      const screen = (screenAngle() || 0);
      heading = (360 - event.alpha + screen) % 360;
      // L'événement `deviceorientationabsolute` est référencé au nord PAR DÉFINITION. On se
      // fie donc à son TYPE, et pas seulement au drapeau `event.absolute` : plusieurs moteurs
      // récents (Chromium sous One UI / Android récent) émettent bien l'événement absolu mais
      // laissent son drapeau à false. Avec l'ancien test, cette unique source vraie-nord était
      // reclassée « relative » puis ignorée, et l'aiguille retombait sur l'alpha à origine
      // arbitraire de `deviceorientation` — un cap qui suit l'orientation posée du téléphone.
      source = (event.type === 'deviceorientationabsolute' || event.absolute)
        ? 'absolute'
        : 'relative';
    }
    if (heading == null) return;

    // Un cap n'a de sens que référencé au nord. `deviceorientationabsolute` (Android) et
    // webkitCompassHeading (iOS) le sont ; le `deviceorientation` simple de Chrome Android
    // NE l'est PAS — son alpha part d'une origine arbitraire fixée au chargement. Or les deux
    // événements se déclenchent sur Android et arrivent tous deux ici : les mélanger dans le
    // même cap lissé tirait l'aiguille entre deux repères décalés, d'où des sauts erratiques.
    // Dès qu'une source absolue a parlé, on ignore les lectures relatives ; elles ne servent
    // que de dernier recours sur un appareil qui n'offre rien de mieux.
    if (source === 'relative') {
      if (this.hasAbsolute) return;
    } else {
      this.hasAbsolute = true;
      // Sur Android, `deviceorientation` ET `deviceorientationabsolute` se déclenchent tous
      // deux : une fois l'absolu confirmé, l'écouteur relatif ne fait plus que doubler les
      // appels pour un cap qu'on ignore de toute façon. On le retire. (iOS n'émet jamais
      // l'événement absolu ; son écouteur relatif, seul porteur de webkitCompassHeading,
      // n'est donc jamais retiré.)
      if (event.type === 'deviceorientationabsolute' && !this.pruned) {
        this.pruned = true;
        window.removeEventListener('deviceorientation', this.#onEvent);
      }
    }

    this.heading = smoothAngle(this.heading, (heading + 360) % 360, SMOOTHING);
    this.source = source;
    this.dispatchEvent(new CustomEvent('heading', {
      detail: { heading: this.heading, source },
    }));
  };
}

function screenAngle() {
  const a = screen.orientation?.angle;
  return Number.isFinite(a) ? a : (Number.isFinite(window.orientation) ? window.orientation : 0);
}

/** Lissage exponentiel sur le cercle : on interpole le long du plus court arc. */
function smoothAngle(previous, next, factor) {
  if (previous == null) return next;
  let delta = ((next - previous + 540) % 360) - 180;
  return (previous + factor * delta + 360) % 360;
}
