// Relevés manuels corrigeant la carte, et simulation d'étiage.
//
// On pose des points sur la carte ; chacun retient une altitude de fond en m NGF (`bedZ`,
// invariante) et la provenance de la mesure (profondeur lue et cote du jour au moment du
// relevé). Ces points CORRIGENT la carte courante : autour de chacun, le modèle 2009 est
// ramené vers le fond mesuré (voir BedGrid.applyCorrections). Le curseur de cote permet en
// plus de simuler l'étiage — quelle pointe émerge à quelle cote — puisque le shader
// recolore la carte corrigée à n'importe quelle cote.
//
// Stockage local pour l'instant ; le format porte déjà la provenance (depth_m, cote_m) pour
// qu'une synchronisation serveur multi-utilisateurs se branche ensuite sans migration.

const STORAGE_KEY = 'relieflac.sim.v1';

export class SimPoints extends EventTarget {
  constructor() {
    super();
    this.records = load();
  }

  get count() {
    return this.records.length;
  }

  add({ lon, lat, bedZ, depth_m = null, cote_m = null, radius_m = null }) {
    const entry = {
      id: crypto.randomUUID(), at: new Date().toISOString(),
      lon, lat, bedZ, depth_m, cote_m, radius_m,
    };
    this.records.push(entry);
    this.#persist();
    return entry;
  }

  remove(id) {
    this.records = this.records.filter((r) => r.id !== id);
    this.#persist();
  }

  get(id) {
    return this.records.find((r) => r.id === id) ?? null;
  }

  update(id, changes) {
    const record = this.records.find((r) => r.id === id);
    if (!record) return;
    Object.assign(record, changes);
    this.#persist();
  }

  clear() {
    this.records = [];
    this.#persist();
  }

  /** Remplace tout le jeu de relevés (adoption d'une version distribuée). */
  replaceAll(records) {
    this.records = Array.isArray(records) ? records : [];
    this.#persist();
  }

  #persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.records));
    } catch {
      // Navigation privée ou quota plein : les points restent en mémoire pour la session.
    }
    this.dispatchEvent(new CustomEvent('change'));
  }
}

function load() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) ?? [];
  } catch {
    return [];
  }
}
