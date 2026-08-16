// Historique de la cote du lac : ce que le dépôt en sait, et ce que cet appareil a vu.
//
// Deux sources se rejoignent ici, et il en faut deux :
//
//   • data/level-history.json, écrit toutes les heures par le workflow GitHub Actions.
//     C'est la source complète — trois ans d'historique horaire — mais elle ne progresse
//     que si l'Action tourne, et elle n'arrive qu'avec le réseau.
//   • ce que l'appareil relève lui-même. À chaque ouverture, l'application inscrit la cote
//     du moment dans une réserve locale. Sur l'eau, sans réseau, c'est elle qui garde la
//     trace de la journée ; et si l'Action s'arrête (GitHub suspend les workflows planifiés
//     d'un dépôt inactif), la courbe continue de se remplir quand même.
//
// Les deux jeux sont fusionnés à la lecture, sur la date de MESURE. La cote EDF est datée à
// l'heure ronde : deux ouvertures dans la même heure décrivent le même relevé, et se
// rangent naturellement au même endroit sans jamais faire deux points.
//
// La clé est l'instant en millisecondes, jamais la chaîne de caractères : le fichier écrit
// « 2026-08-16T07:00:00Z » là où JavaScript écrirait « 2026-08-16T07:00:00.000Z ». Comparer
// les textes ferait deux relevés du même instant, et la courbe monterait deux fois.

const STORAGE_KEY = 'relieflac.levelhist.v1';

// Un an d'heures. Au-delà, la réserve locale ne sert plus à rien : le fichier du dépôt
// couvre trois ans, et localStorage est une ressource rare sur iOS.
const MAX_LOCAL = 24 * 400;

export class LevelHistory extends EventTarget {
  constructor(baseUrl = '.') {
    super();
    this.baseUrl = baseUrl;
    this.remote = new Map(); // instant de mesure (ms) -> cote, venu du dépôt
    this.local = load();     // instant de mesure (ms) -> cote, relevé par cet appareil
    this.error = null;
    this.loaded = false;
  }

  /** Récupère l'historique du dépôt. Sans réseau, la réserve locale suffit à tracer. */
  async load() {
    try {
      const response = await fetch(`${this.baseUrl}/data/level-history.json`, { cache: 'no-cache' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      this.remote = new Map(
        (payload.entries ?? [])
          .map((e) => [new Date(e?.t).getTime(), e?.v])
          .filter(([t, v]) => Number.isFinite(t) && Number.isFinite(v)),
      );
      this.error = null;
      // Ce que le dépôt sait déjà n'a plus à occuper la mémoire du téléphone. La réserve
      // locale ne garde donc, à terme, que l'avance qu'elle a sur le workflow.
      let pruned = false;
      for (const t of [...this.local.keys()]) {
        if (this.remote.has(t)) { this.local.delete(t); pruned = true; }
      }
      if (pruned) save(this.local);
    } catch (err) {
      this.error = err.message;
    }
    this.loaded = true;
    this.dispatchEvent(new CustomEvent('change'));
    return this.count;
  }

  /**
   * Inscrit la cote relevée à l'ouverture. Renvoie `true` si elle était inconnue.
   *
   * On n'inscrit que ce qui vient d'EDF : une saisie manuelle est une lecture d'échelle
   * faite par une personne, pas une mesure du barrage, et elle n'a rien à faire dans une
   * courbe censée montrer ce qu'a fait le lac.
   */
  record(measuredAt, value) {
    if (!Number.isFinite(value)) return false;
    const t = new Date(measuredAt).getTime();
    if (!Number.isFinite(t)) return false;
    if (this.remote.get(t) === value || this.local.get(t) === value) return false;

    this.local.set(t, value);
    if (this.local.size > MAX_LOCAL) {
      const keep = [...this.local.entries()].sort((a, b) => a[0] - b[0]).slice(-MAX_LOCAL);
      this.local = new Map(keep);
    }
    save(this.local);
    this.dispatchEvent(new CustomEvent('change'));
    return true;
  }

  get count() {
    return this.entries().length;
  }

  /** Série complète, fusionnée et triée : `[{ t: ms, v: m NGF }]`. */
  entries() {
    const merged = new Map(this.remote);
    for (const [t, v] of this.local) merged.set(t, v);
    return [...merged.entries()]
      .map(([t, v]) => ({ t, v }))
      .sort((a, b) => a.t - b.t);
  }
}

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return new Map(
      (raw?.entries ?? [])
        .map((e) => [new Date(e?.t).getTime(), e?.v])
        .filter(([t, v]) => Number.isFinite(t) && Number.isFinite(v)),
    );
  } catch {
    return new Map();
  }
}

/** Écrit en ISO plutôt qu'en millisecondes : la réserve reste lisible à l'œil nu. */
function save(entries) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      v: 1,
      entries: [...entries.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([t, v]) => ({ t: new Date(t).toISOString(), v })),
    }));
  } catch {
    // Navigation privée ou quota plein : la courbe se limitera à l'historique du dépôt.
  }
}
