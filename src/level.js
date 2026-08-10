// Cote du lac : chargement, fraîcheur, saisie manuelle.
//
// data/level.json est écrit toutes les heures par un workflow GitHub Actions. L'API EDF
// ne renvoyant aucun en-tête CORS, elle ne peut pas être appelée depuis cette page — le
// relais côté serveur est la seule voie possible sans hébergement dédié.
//
// Sur l'eau, le réseau est inégal : la cote peut être périmée, absente, ou remplacée par
// une valeur relevée à l'échelle limnimétrique du port. L'application doit toujours dire
// laquelle des trois elle utilise.

const STALE_AFTER_MS = 6 * 3600e3;

export const LevelSource = {
  LIVE: 'live',
  STALE: 'stale',
  MANUAL: 'manual',
  UNKNOWN: 'unknown',
};

export class Level {
  constructor(baseUrl = '.') {
    this.baseUrl = baseUrl;
    this.data = null;
    this.manual = null;
    this.error = null;
  }

  async refresh() {
    try {
      const response = await fetch(`${this.baseUrl}/data/level.json`, { cache: 'no-cache' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      this.data = await response.json();
      this.error = null;
    } catch (err) {
      this.error = err.message;
    }
    return this.current();
  }

  setManual(value) {
    this.manual = Number.isFinite(value) ? value : null;
  }

  /** État complet de la cote : valeur, provenance, âge, condition de navigation. */
  current() {
    if (this.manual != null) {
      return {
        value: this.manual,
        source: LevelSource.MANUAL,
        label: 'saisie manuelle',
        ageMs: 0,
        condition: this.#condition(this.manual),
      };
    }

    if (!this.data) {
      return {
        value: null,
        source: LevelSource.UNKNOWN,
        label: this.error ? `indisponible (${this.error})` : 'indisponible',
        ageMs: null,
        condition: null,
      };
    }

    const measured = new Date(this.data.measured_at).getTime();
    const ageMs = Date.now() - measured;
    const stale = this.data.stale || ageMs > STALE_AFTER_MS;
    return {
      value: this.data.level_m_ngf,
      source: stale ? LevelSource.STALE : LevelSource.LIVE,
      label: stale ? 'donnée périmée' : 'EDF',
      ageMs,
      measuredAt: new Date(measured),
      condition: this.#condition(this.data.level_m_ngf),
    };
  }

  get thresholds() {
    return this.data?.thresholds ?? { forbidden_below: 642, delicate_below: 643, normal_max: 650 };
  }

  #condition(value) {
    const t = this.thresholds;
    if (value < t.forbidden_below) return { key: 'forbidden', label: 'Navigation interdite' };
    if (value < t.delicate_below) return { key: 'delicate', label: 'Délicat' };
    return { key: 'normal', label: 'Navigable' };
  }
}

export function formatAge(ms) {
  if (ms == null) return '';
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return "à l'instant";
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `il y a ${hours} h`;
  return `il y a ${Math.round(hours / 24)} jours`;
}
