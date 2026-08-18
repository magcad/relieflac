// Réglages persistants, avec notification des modules qui en dépendent.
//
// Les valeurs par défaut viennent de config/palette.json et config/model.json, pour que
// « réinitialiser » ramène exactement à ce que produit la chaîne de préparation des
// données, sans duplication de constantes entre le Python et le JavaScript.

const STORAGE_KEY = 'relieflac.settings.v1';

/**
 * Version du jeu de réglages.
 *
 * Changer une valeur par défaut ne change rien pour qui a déjà ouvert l'application une
 * fois : ses réglages sont en mémoire locale, défauts compris, et ils gagnent. Or certains
 * défauts ne sont pas des préférences mais des **décisions de fond** — quelle carte on
 * montre, et à quel recalage — qu'il faut pouvoir imposer à tout le monde. D'où ce numéro :
 * les clés listées ci-dessous reprennent leur valeur d'usine au premier démarrage qui suit.
 */
const SCHEMA = 2;

const MIGRATIONS = {
  // 2 — 16/08/2026 : la carte communautaire devient la carte affichée par défaut, et son
  // recalage passe à la valeur mesurée sur l'eau le 15/08/2026, cote vérifiée.
  2: ['bedSource', 'quickdrawDatum_m'],
};

export class Settings extends EventTarget {
  constructor(defaults) {
    super();
    this.defaults = defaults;
    this.values = migrate({ ...defaults, ...load() }, defaults);
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
    // Migré comme au démarrage : un profil exporté avant la bascule vers la carte
    // communautaire ne doit pas la défaire en revenant.
    this.update(migrate({ ...this.defaults, ...filtered }, this.defaults));
  }
}

/** Applique les migrations non encore passées, et mémorise le palier atteint. */
function migrate(values, defaults) {
  const from = Number.isFinite(values.settingsSchema) ? values.settingsSchema : 0;
  if (from >= SCHEMA) return values;
  for (let step = from + 1; step <= SCHEMA; step += 1) {
    for (const key of MIGRATIONS[step] ?? []) values[key] = defaults[key];
  }
  values.settingsSchema = SCHEMA;
  save(values);
  return values;
}

export function defaultsFrom(palette, model) {
  return {
    settingsSchema: SCHEMA,
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
    // Fond bathymétrique : 'quickdraw' (carte communautaire seule) ou 'ofb2009' (levé +
    // apports). Les deux grilles partagent la maille, les relevés manuels s'appliquent sur
    // celle qui est active. Voir BED_SOURCES dans src/bed.js.
    //
    // La communautaire est celle qu'on montre par défaut : c'est celle que la plupart des
    // plaisanciers du lac ont déjà sous les yeux au traceur, elle couvre 94 % du lac avec le
    // passage réel d'un sondeur, et elle laisse le reste vide au lieu de l'inventer.
    bedSource: 'quickdraw',
    // Recalage vertical de la carte communautaire, en mètres. `null` = celui inscrit dans
    // data/bed_quickdraw.json par la chaîne Python ; toute autre valeur le remplace, ce qui
    // permet de le mesurer sur l'eau en plusieurs points sans reconstruire la grille.
    //
    // 1,72 m : mesuré sur l'eau le 15/08/2026, cote du lac vérifiée cette fois-là — le 2,72
    // du fichier avait été relevé alors qu'une cote de simulation traînait dans les
    // réglages, donc contre un trait de côte faux.
    quickdrawDatum_m: 1.72,
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
    // Trajets et sorties voyagent par le même dépôt et le même jeton, dans leurs propres
    // fichiers : les trajets en un seul (ils se retouchent), les sorties en un dossier —
    // une trace par fichier, plus un catalogue, parce qu'une trace pèse mille fois un
    // trajet et ne sera jamais modifiée. Voir src/sync.js.
    syncRoutesPath: 'data/routes/vassiviere.json',
    syncTripsDir: 'data/trips/vassiviere',
    // Plages de vitesse du ski nautique retouchées par l'utilisateur, par activité :
    // { monoski: { adulte: [30, 36] } }. Seuls les ÉCARTS au tableau d'usine sont
    // mémorisés — voir `normalizeSkiSpeeds` dans src/ski.js — pour qu'une correction
    // d'usine ultérieure rattrape toutes les lignes qu'on n'a pas touchées.
    skiSpeeds: {},
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
