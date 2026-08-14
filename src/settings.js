// Réglages persistants, avec notification des modules qui en dépendent.
//
// Les valeurs par défaut viennent de config/palette.json et config/model.json, pour que
// « réinitialiser » ramène exactement à ce que produit la chaîne de préparation des
// données, sans duplication de constantes entre le Python et le JavaScript.

const STORAGE_KEY = 'relieflac.settings.v1';

export class Settings extends EventTarget {
  constructor(defaults) {
    super();
    this.defaults = defaults;
    this.values = { ...defaults, ...load() };
  }

  get(key) {
    return this.values[key];
  }

  set(key, value) {
    if (Object.is(this.values[key], value)) return;
    this.values[key] = value;
    save(this.values);
    this.dispatchEvent(new CustomEvent('change', { detail: { key, value } }));
  }

  update(partial) {
    let changed = false;
    Object.entries(partial).forEach(([key, value]) => {
      if (!Object.is(this.values[key], value)) {
        this.values[key] = value;
        changed = true;
      }
    });
    if (!changed) return;
    save(this.values);
    this.dispatchEvent(new CustomEvent('change', { detail: { key: null, value: null } }));
  }

  reset() {
    this.values = { ...this.defaults };
    save(this.values);
    this.dispatchEvent(new CustomEvent('change', { detail: { key: null, value: null } }));
  }

  /** Profondeur de sécurité : c'est elle qui pilote le contour et l'alarme. */
  get safetyDepth() {
    return this.values.draft_m + this.values.margin_m;
  }

  export() {
    return JSON.stringify({ version: 1, settings: this.values }, null, 2);
  }

  import(text) {
    const payload = JSON.parse(text);
    const incoming = payload.settings ?? payload;
    // On ne reprend que les clés connues : un profil d'une version ultérieure ne doit
    // pas injecter de réglages que ce code ne sait pas interpréter.
    const filtered = Object.fromEntries(
      Object.entries(incoming).filter(([key]) => key in this.defaults),
    );
    this.update({ ...this.defaults, ...filtered });
  }
}

export function defaultsFrom(palette, model) {
  return {
    preset: palette.active_preset,
    draft_m: palette.safety_contour.draft_m,
    margin_m: palette.safety_contour.margin_m,
    opacity: 0.8,
    showOutlines: true,
    showSafety: true,
    showSoundings: false,
    // Signalement des zones où le modèle n'est plus adossé à une mesure. Actif par
    // défaut : 38 % du lac est à plus de 60 m de toute sonde de 2009.
    showVoids: true,
    voidRadius_m: 60,
    alarmEnabled: true,
    alarmDepth_m: 1.5,
    speedUnit: 'kmh',
    basemap: 'plan',
    // Fond bathymétrique : 'ofb2009' (levé + apports) ou 'quickdraw' (carte communautaire
    // seule). Les deux grilles partagent la maille, les relevés manuels s'appliquent sur
    // celle qui est active. Voir BED_SOURCES dans src/bed.js.
    bedSource: 'ofb2009',
    // Recalage vertical de la carte communautaire, en mètres. `null` = celui inscrit dans
    // data/bed_quickdraw.json par la chaîne Python ; toute autre valeur le remplace, ce qui
    // permet de le mesurer sur l'eau en plusieurs points sans reconstruire la grille.
    quickdrawDatum_m: null,
    // Les deux verrous de caméra sont actifs à l'ouverture : sur l'eau, on veut le bateau
    // au centre et l'étrave vers le haut sans avoir à y penser.
    followBoat: true,
    trackUp: true,
    // Largeur de terrain visée à l'écran (m) au tout premier lancement : de quoi voir la
    // profondeur devant l'étrave sans perdre le contexte des rives. Ensuite c'est `zoom`,
    // mémorisé d'une sortie à l'autre, qui commande — on retrouve son cadrage habituel.
    initialWidth_m: 165,
    zoom: null,
    calibrationOffset_m: 0,
    manualLevel: null,
    // La simulation d'étiage pilote la cote par `manualLevel`, qui est persistant. Fermer
    // l'application en cours de simulation laissait donc une cote inventée en place, prise
    // pour la vraie à la réouverture — sur un outil de navigation, une cote fausse fausse
    // TOUTES les profondeurs. Ces deux clés permettent de le détecter au démarrage et de
    // rendre la cote qui était en vigueur avant la simulation.
    manualFromSim: false,
    manualBeforeSim: null,
    // Sondes saisies à la main : immersion du transducteur sous la flottaison, et
    // affichage des points mesurés en surcouche.
    transducer_m: 0.3,
    showProbes: true,
    // Grand affichage de la profondeur sous le bateau (bascule au toucher de l'indicateur).
    bigDepth: false,
    // Contraste maximal de l'habillage, pour lire l'écran en plein soleil.
    sunMode: false,
    // Rayon (m) sur lequel un relevé manuel corrige la grille du fond autour du point : sa
    // moitié centrale est un plateau à la valeur relevée, sa moitié extérieure se fond vers
    // le levé de 2009 (voir BedGrid.applyCorrections). Valeur des nouveaux relevés ; chacun
    // garde ensuite la sienne.
    correctionRadius_m: 20,
    // Zones émergées tracées à la main : affichage des contours, et valeurs reprises d'une
    // zone à l'autre — hauteur du sol au-dessus de l'eau, largeur du fondu au-delà du bord.
    showZones: true,
    zoneHeight_m: 0.5,
    zoneFeather_m: 10,
    // Synchronisation des relevés vers un fichier du dépôt (le jeton, lui, est stocké à
    // part et jamais exporté). Ces valeurs se changent pour un autre plan d'eau.
    syncRepo: 'magcad/relieflac',
    syncPath: 'data/corrections/vassiviere.json',
    syncBranch: 'main',
    syncWaterbody: 'vassiviere',
    // Retouches de couleurs par l'utilisateur, par préréglage : { marine: { emerged_color,
    // bands: [{ max_depth_m, color }] , stops: [...] } }. Appliquées sur la palette en
    // mémoire au démarrage ; « réinitialiser » les efface.
    paletteOverrides: {},
    z2009_m_ngf: model.reference_levels.ofb2009.value_m_ngf,
    waterPlane_m_ngf: model.reference_levels.rge_alti.value_m_ngf,
  };
}

function load() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) ?? {};
  } catch {
    return {};
  }
}

function save(values) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(values));
  } catch {
    // Navigation privée ou quota plein : l'application reste utilisable, sans mémoire.
  }
}
