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
    followBoat: true,
    calibrationOffset_m: 0,
    manualLevel: null,
    // Sondes saisies à la main : immersion du transducteur sous la flottaison, et
    // affichage des points mesurés en surcouche.
    transducer_m: 0.3,
    showProbes: true,
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
