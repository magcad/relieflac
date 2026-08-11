// Points de simulation : « et si la cote descendait à… ? »
//
// Le mode simulation sert à anticiper l'étiage — quelles pointes émergent, quels passages
// se ferment — sans attendre que le lac descende. On pose des points sur la carte ; chacun
// retient une altitude de fond en m NGF (relevée sur le modèle au moment de la pose, puis
// ajustable pour tester un haut-fond hypothétique). À une cote donnée, le point est émergé
// si cette cote passe sous son altitude. Rien de tout cela ne touche la bathymétrie réelle :
// c'est un bac à sable, distinct des sondes mesurées.

const STORAGE_KEY = 'relieflac.sim.v1';

export class SimPoints extends EventTarget {
  constructor() {
    super();
    this.records = load();
  }

  get count() {
    return this.records.length;
  }

  add({ lon, lat, bedZ }) {
    const entry = { id: crypto.randomUUID(), at: new Date().toISOString(), lon, lat, bedZ };
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
