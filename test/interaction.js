// Banc d'essai des enchaînements de l'interface.
//
// On charge le vrai `index.html` (une seule source de vérité pour le balisage), on démarre
// la vraie application, et l'on provoque sur la carte factice les mêmes événements que la
// vraie carte. Ce qui est vérifié ici n'est pas la logique des modules — `selftest.js` s'en
// charge — mais la chaîne complète : un geste, un état d'application, un affichage, et ce
// qui reste dans le stockage local une fois l'opération faite.

const results = [];
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition), detail });
}
function group(name) {
  results.push({ group: name });
}

/** Un bouton destructeur demande deux appuis : le premier arme, le second exécute. */
function press(id) {
  $(id).click();
  $(id).click();
}

// ------------------------------------------------- emprunt du stockage de l'appareil
//
// Le banc tourne sur la MÊME origine que l'application : ses sondes, ses zones, ses
// réglages et son jeton d'écriture sont là, à portée. Deux dangers, tous deux réels sur le
// site publié : effacer des relevés que l'utilisateur a pris sur l'eau, et — pire —
// déclencher un envoi vers le dépôt, puisqu'une sonde ajoutée ici serait poussée comme une
// vraie dès lors qu'un jeton traîne. On met donc tout de côté avant de commencer, jeton
// compris (sans jeton, la synchronisation reste en lecture seule), et on remet l'appareil
// exactement dans l'état où on l'a trouvé — y compris si le banc échoue en route.

const KEPT = new Map();

function borrowStorage() {
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (key?.startsWith('relieflac.')) KEPT.set(key, localStorage.getItem(key));
  }
  for (const key of KEPT.keys()) localStorage.removeItem(key);
}

function returnStorage() {
  for (let i = localStorage.length - 1; i >= 0; i -= 1) {
    const key = localStorage.key(i);
    if (key?.startsWith('relieflac.')) localStorage.removeItem(key);
  }
  for (const [key, value] of KEPT) localStorage.setItem(key, value);
}

const stored = (key) => {
  try { return JSON.parse(localStorage.getItem(key)) ?? []; } catch { return []; }
};
const probes = () => stored('relieflac.probes.v1');
const zones = () => stored('relieflac.zones.v1');
const sims = () => stored('relieflac.sim.v1');

/** Attend qu'une condition devienne vraie, ou renonce — pour ne jamais figer la page. */
async function until(condition, timeout = 5000) {
  const t0 = performance.now();
  while (performance.now() - t0 < timeout) {
    if (condition()) return true;
    await sleep(50);
  }
  return false;
}

async function boot() {
  // Le balisage vient de l'application elle-même : dupliquer les écrans ici, ce serait
  // vérifier une copie qui divergerait au premier bouton ajouté.
  const html = await fetch('./index.html', { cache: 'no-cache' }).then((r) => r.text());
  const page = new DOMParser().parseFromString(html, 'text/html');
  const report = $('rapport');
  for (const node of [...page.body.children]) {
    if (node.tagName === 'SCRIPT') continue;
    document.body.insertBefore(document.adoptNode(node), report);
  }

  // Le banc part d'un appareil vierge — et rendra le vrai stockage intact à la fin.
  borrowStorage();
  check('le stockage de l\'appareil est mis de côté, jeton compris',
    localStorage.getItem('relieflac.token.v1') === null,
    `${KEPT.size} clé(s) en dépôt`);
  // Aucun leurre sur `confirm` : l'application ne doit plus en dépendre du tout. On le
  // piège au contraire pour le prouver — ce navigateur, comme un Chrome où la case
  // « empêcher les boîtes de dialogue » a été cochée, le fait renvoyer `false`, ce qui
  // rendait toute suppression silencieusement inopérante.
  let dialogs = 0;
  Object.defineProperty(window, 'confirm', {
    value: () => { dialogs += 1; return false; }, configurable: true, writable: true,
  });
  window.__dialogs = () => dialogs;

  // Adresses relatives à CE module (et non à la base du document) : c'est ainsi que se
  // résout un import dynamique. La carte d'import de la page les renvoie sur le leurre.
  const { LakeMap } = await import('../src/map.js');
  await import('../src/main.js');
  const started = await until(() => $('chargement').hidden, 15000);
  check('l\'application démarre entièrement', started,
    started ? '' : $('chargement').textContent.trim());
  if (!started) return null;

  // `initSync` récupère les relevés publiés en tâche de fond et remplace le jeu local :
  // provoquer un geste avant qu'il ait fini le ferait écraser sans rapport avec le geste.
  await sleep(2000);
  return LakeMap.last;
}

async function run() {
  const map = await boot();
  if (!map) return render();

  const lngLat = { lng: 1.87132, lat: 45.79328 };
  const fire = (type, detail) => map.dispatchEvent(new CustomEvent(type, { detail }));

  // ---------------------------------------------------- point posé sans GPS
  group('Point posé au clic droit, sans position GPS');
  const before = probes().length;
  fire('pinpoint', lngLat);
  check('le repère de visée est posé sur la carte', map.pin !== null,
    JSON.stringify(map.pin));
  check('la barre de saisie s\'ouvre', $('capture').hidden === false);
  check('l\'abandon est proposé', $('btn-cap-cancel').hidden === false);

  $('cap-input').value = '3.2';
  $('cap-input').dispatchEvent(new Event('input'));
  $('btn-capture').click();
  check('la sonde est enregistrée', probes().length === before + 1,
    `${probes().length} sonde(s), ${before} avant`);
  check('la position vient du point désigné',
    probes().at(-1)?.fixSource === 'map' && probes().at(-1)?.lon === lngLat.lng,
    `${probes().at(-1)?.fixSource}`);
  check('le repère de visée est retiré une fois la sonde posée', map.pin === null);

  // -------------------------------------------- suppression par la barre de saisie
  group('Suppression depuis la barre de saisie');
  const target = probes().at(-1);
  fire('probeselect', target.id);
  check('toucher la pastille ouvre la correction',
    $('capture').hidden === false && $('capture').classList.contains('is-editing'));
  check('le bouton de suppression apparaît', $('btn-cap-delete').hidden === false);
  check('le rayon d\'influence est proposé', $('cap-radius-box').hidden === false,
    `rayon ${$('cap-radius').value}`);

  // Le premier appui ne doit rien détruire : il arme, et cela doit se voir.
  $('btn-cap-delete').click();
  check('un seul appui n\'efface rien',
    probes().some((p) => p.id === target.id)
    && $('btn-cap-delete').classList.contains('is-arming'),
    `libellé « ${$('btn-cap-delete').textContent} »`);

  $('btn-cap-delete').click();
  check('la sonde est supprimée du stockage',
    probes().every((p) => p.id !== target.id),
    `${probes().length} restante(s)`);
  check('la pastille disparaît de la carte',
    map.probes.every((p) => p.id !== target.id));
  check('la barre revient en saisie', $('btn-capture').textContent === 'Relever'
    && $('btn-cap-delete').hidden === true);

  // ------------------------------------- suppression depuis la liste des Paramètres
  group('Suppression depuis la liste des Paramètres');
  fire('pinpoint', { lng: 1.8720, lat: 45.7935 });
  $('cap-input').value = '4.5';
  $('cap-input').dispatchEvent(new Event('input'));
  $('btn-capture').click();
  const listed = probes().at(-1);
  location.hash = '#/parametres';
  await sleep(60);
  // La liste est présentée du plus récent au plus ancien : la sonde qu'on vient de poser
  // est en tête.
  const row = $('probe-records').children[0];
  check('la sonde figure en tête de liste', row?.textContent.includes('4.5 m'),
    `${$('probe-records').children.length} ligne(s) · « ${row?.textContent.trim().slice(0, 24)} »`);
  row?.querySelector('button:last-child')?.click();
  check('la croix de la liste supprime la sonde',
    probes().every((p) => p.id !== listed.id), `${probes().length} restante(s)`);
  location.hash = '#/';
  await sleep(60);

  // ------------------------------------- la suppression survit-elle à la synchronisation ?
  group('Suppression et relevés partagés');
  const shared = probes().find((p) => p.levelSource === 'sync');
  if (!shared) {
    check('un relevé partagé est disponible pour l\'essai', false, 'aucun relevé venu du dépôt');
  } else {
    const others = probes().length - 1;
    fire('probeselect', shared.id);
    press('btn-cap-delete');
    check('un relevé venu du dépôt se supprime localement',
      probes().every((p) => p.id !== shared.id), `${probes().length} restante(s)`);
    // « Récupérer les relevés » refait exactement ce que fait l'ouverture de l'application.
    $('btn-sync-now').click();
    await until(() => probes().length !== others, 4000);
    check('et il ne revient pas à la synchronisation suivante',
      probes().every((p) => p.id !== shared.id),
      probes().some((p) => p.id === shared.id) ? 'ressuscité par la fusion' : 'bien absent');
  }

  // ------------------------------------------------------------- zones émergées
  group('Zone émergée : tracé, sélection, suppression');
  $('btn-zone').click();
  check('le panneau s\'ouvre sur la liste, sans commencer à tracer',
    map.zoneMode === true && map.tracing === false
    && $('zone-list').hidden === false && $('btn-zone-new').hidden === false);

  $('btn-zone-new').click();
  check('« Nouvelle zone » démarre le tracé',
    map.tracing === true && $('btn-zone-undo').hidden === false);
  const ring = [[1.8710, 45.7930], [1.8716, 45.7930], [1.8716, 45.7935], [1.8710, 45.7935]];
  for (const [lng, lat] of ring) fire('zonevertex', { lngLat: { lng, lat }, zoneId: null });
  check('les sommets s\'accumulent', map.zoneDraft.length === 4, `${map.zoneDraft.length}`);
  check('la fermeture devient possible', $('btn-zone-close').disabled === false);

  fire('zoneclose');
  check('la zone est enregistrée', zones().length === 1, `${zones().length}`);
  check('elle est reprise en réglage aussitôt', $('btn-zone-del').hidden === false);
  check('son contour est affiché', map.zones.length === 1 && map.zones[0].selected === true);
  const zoneId = zones()[0]?.id;

  // Sortir du mode puis y revenir pour reprendre une zone posée plus tôt : c'est le geste
  // courant, et le chemin vers sa suppression depuis la carte.
  $('btn-zone-exit').click();
  $('btn-zone').click();
  fire('zonevertex', { lngLat: { lng: 1.8713, lat: 45.7932 }, zoneId });
  check('un contour posé plus tôt se reprend au toucher',
    $('btn-zone-del').hidden === false, `zone ${zoneId ? 'présente' : 'absente'}`);

  // Le défaut signalé par l'utilisateur : un sommet posé par mégarde avant de viser le
  // contour rendait la zone injoignable, donc impossible à supprimer. Le tracé ne
  // commençant plus tout seul, un clic hors tracé ne peut plus poser de sommet.
  $('btn-zone-exit').click();
  $('btn-zone').click();
  fire('zonevertex', { lngLat: { lng: 1.8700, lat: 45.7920 }, zoneId: null });
  check('hors tracé, un clic sur la carte ne pose aucun sommet',
    map.zoneDraft.length === 0, `${map.zoneDraft.length} sommet(s)`);
  fire('zonevertex', { lngLat: { lng: 1.8713, lat: 45.7932 }, zoneId });
  check('le contour reste joignable ensuite',
    $('btn-zone-del').hidden === false, `${map.zoneDraft.length} sommet(s) en cours`);

  // Un tracé abandonné en route ne doit rien laisser derrière lui.
  $('btn-zone-new').click();
  fire('zonevertex', { lngLat: { lng: 1.8700, lat: 45.7920 }, zoneId: null });
  $('btn-zone-cancel').click();
  check('annuler un tracé le retire de la carte',
    map.zoneDraft.length === 0 && map.tracing === false && $('zone-list').hidden === false);

  // La liste du panneau : la reprise qui ne dépend d'aucun visé.
  check('la zone figure dans la liste du panneau',
    $('zone-list').children.length === 1,
    `${$('zone-list').children.length} ligne(s) · « ${$('zone-list').textContent.trim().slice(0, 30)} »`);
  $('btn-zone-exit').click();
  location.hash = '#/parametres';
  await sleep(60);
  check('et dans celle des Paramètres',
    $('zone-records').children.length === 1,
    `${$('zone-records').children.length} ligne(s)`);
  location.hash = '#/';
  await sleep(60);

  // Suppression par la liste du panneau, sans passer par la carte du tout.
  $('btn-zone').click();
  $('zone-list').children[0].querySelector('.zone__del').click();
  check('la croix de la liste supprime la zone', zones().length === 0, `${zones().length}`);

  // Puis la même chose par le gros bouton, sur une zone tracée à neuf.
  $('btn-zone-new').click();
  for (const [lng, lat] of ring) fire('zonevertex', { lngLat: { lng, lat }, zoneId: null });
  fire('zoneclose');
  check('une seconde zone se trace après une suppression', zones().length === 1);
  press('btn-zone-del');
  check('la zone est supprimée du stockage', zones().length === 0, `${zones().length}`);
  check('son contour disparaît de la carte', map.zones.length === 0);
  check('le panneau repasse à la liste', $('btn-zone-del').hidden === true
    && $('zone-list').hidden === false && map.tracing === false);
  $('btn-zone-exit').click();
  check('quitter le mode zone rend le clic à la sonde ponctuelle', map.zoneMode === false);

  // -------------------------------------------------- témoins de simulation
  group('Témoin de simulation : pose et suppression');
  $('btn-sim').click();
  fire('probe', { lng: 1.8714, lat: 45.7933 });
  check('le témoin est posé', sims().length === 1, `${sims().length}`);
  check('il est sélectionné pour réglage', $('sim-sel').hidden === false);
  $('btn-sim-del').click();
  check('le témoin est supprimé', sims().length === 0, `${sims().length}`);
  check('sa pastille disparaît', map.simPoints.length === 0);

  // La simulation pilote la cote par `manualLevel`, qui est PERSISTANT. Tant qu'on en
  // sort par le bouton, tout va bien ; fermée en route, elle laissait une cote inventée
  // derrière elle, prise ensuite pour la cote du lac — et une cote fausse fausse toutes
  // les profondeurs. On vérifie donc les deux chemins de sortie, dont celui qui n'en est
  // pas un.
  const settings = () => { try { return JSON.parse(localStorage.getItem('relieflac.settings.v1')) ?? {}; } catch { return {}; } };
  $('sim-slider').value = '644.95';
  $('sim-slider').dispatchEvent(new Event('input'));
  check('la simulation pilote bien la cote affichée',
    Math.abs(Number(settings().manualLevel) - 644.95) < 0.005
    && settings().manualFromSim === true,
    `cote ${settings().manualLevel}, marqueur ${settings().manualFromSim}`);
  check('la cote saisie se voit sur le bandeau',
    $('btn-cote').classList.contains('level--manual'),
    $('btn-cote').className);

  $('btn-sim-exit').click();
  check('sortir de la simulation rend la cote du lac',
    settings().manualLevel === null && settings().manualFromSim === false,
    `cote ${settings().manualLevel}`);

  // ------------------------------------------------- bascule de fond bathymétrique
  //
  // Le seul moyen de prouver que la bascule change vraiment la carte lue, et pas seulement
  // le libellé affiché : poser deux fois la même sonde au même point, une fois sur chaque
  // fond, et comparer l'altitude que le modèle annonce dessous.
  group('Bascule de fond bathymétrique');
  // Point choisi pour que les deux cartes y diffèrent franchement : celui des sondes
  // précédentes tombe, depuis le recalage de terrain, à 3 cm près sur les deux — un
  // enchaînement juste y échouerait sans que rien ne soit cassé.
  const forkPoint = { lng: 1.90, lat: 45.79 };
  const readModel = async () => {
    fire('pinpoint', forkPoint);
    $('cap-input').value = '3.0';
    $('cap-input').dispatchEvent(new Event('input'));
    $('btn-capture').click();
    return probes().at(-1)?.modelBedZ;
  };

  const onSurvey = await readModel();
  location.hash = '#/parametres';
  await sleep(60);
  $('set-bed-source').value = 'quickdraw';
  $('set-bed-source').dispatchEvent(new Event('change'));
  // Le menu ne montre pas le souhait mais le fond RÉELLEMENT chargé : `refreshSettingsUi`
  // le remet sur la source affichée, et il ne bascule qu'une fois la grille échangée. C'est
  // donc le signal d'attente le plus honnête dont dispose le banc.
  const swapped = await until(() => $('set-bed-source').value === 'quickdraw', 8000);
  check('le réglage bascule sur la carte communautaire', swapped,
    $('hint-bed-source').textContent.slice(0, 90));

  location.hash = '#/';
  await sleep(60);
  const onCommunity = await readModel();
  check('le modèle lu sous le bateau change avec le fond',
    Number.isFinite(onSurvey) && Number.isFinite(onCommunity)
    && Math.abs(onSurvey - onCommunity) > 0.5,
    `${onSurvey?.toFixed(2)} m NGF (levé) · ${onCommunity?.toFixed(2)} m NGF (communauté)`);

  // ------------------------------------- recalage réglable de la carte communautaire
  //
  // C'est le réglage qui sert à mesurer le bon décalage sur l'eau : il doit déplacer la
  // grille pour de vrai, et « valeur d'origine » doit rendre exactement le fichier.
  group('Recalage de la carte communautaire');
  location.hash = '#/parametres';
  await sleep(60);
  check('le réglage du recalage apparaît avec cette carte',
    $('bloc-recalage').hidden === false);
  const baseline = Number($('set-qd-datum').value);
  $('set-qd-datum').value = (baseline + 1.5).toFixed(2);
  $('set-qd-datum').dispatchEvent(new Event('change'));
  const moved = await until(
    () => Math.abs(Number($('set-qd-datum').value) - (baseline + 1.5)) < 0.005, 8000);
  location.hash = '#/';
  await sleep(60);
  const raised = await readModel();
  check('le fond remonte de la valeur réglée',
    moved && Number.isFinite(raised) && Math.abs(raised - onCommunity - 1.5) < 0.05,
    `${onCommunity?.toFixed(2)} → ${raised?.toFixed(2)} m NGF, attendu `
    + `${(onCommunity + 1.5).toFixed(2)}`);

  location.hash = '#/parametres';
  await sleep(60);
  $('btn-qd-datum-reset').click();
  const back0 = await until(
    () => Math.abs(Number($('set-qd-datum').value) - baseline) < 0.005, 8000);
  location.hash = '#/';
  await sleep(60);
  const restored = await readModel();
  check('« Valeur d\'origine » rend exactement le fichier',
    back0 && Number.isFinite(restored) && Math.abs(restored - onCommunity) < 0.005,
    `${restored?.toFixed(2)} m NGF`);

  group('Retour au fond du levé');
  location.hash = '#/parametres';
  await sleep(60);
  $('set-bed-source').value = 'ofb2009';
  $('set-bed-source').dispatchEvent(new Event('change'));
  const back = await until(() => $('set-bed-source').value === 'ofb2009', 8000);
  location.hash = '#/';
  await sleep(60);
  const again = await readModel();
  check('retour au levé : la même valeur qu\'au départ',
    back && Number.isFinite(again) && Math.abs(again - onSurvey) < 0.01,
    `${again?.toFixed(2)} m NGF`);

  // ------------------------------------------ effacement en bloc et persistance
  group('Effacement en bloc');
  fire('pinpoint', lngLat);
  $('cap-input').value = '2.0';
  $('cap-input').dispatchEvent(new Event('input'));
  $('btn-capture').click();
  const withOne = probes().length;
  location.hash = '#/parametres';
  await sleep(60);
  press('btn-probe-clear');
  check('« Tout effacer » vide bien les sondes', probes().length === 0,
    `${withOne} avant, ${probes().length} après`);
  check('aucune suppression n\'a eu besoin d\'une boîte de dialogue', window.__dialogs() === 0,
    `${window.__dialogs()} appel(s) à confirm()`);
  location.hash = '#/';

  render();
}

function render() {
  const box = $('rapport');
  const failed = results.filter((r) => r.name && !r.ok).length;
  const total = results.filter((r) => r.name).length;
  $('etat').remove();

  const count = document.createElement('p');
  count.className = 'n';
  count.textContent = failed
    ? `${failed} enchaînement(s) en échec sur ${total}`
    : `${total} enchaînements vérifiés`;
  count.style.color = failed ? '#ff8080' : '#22c55e';
  box.append(count);

  const list = document.createElement('ol');
  for (const r of results) {
    const item = document.createElement('li');
    if (r.group) {
      item.style.listStyle = 'none';
      item.style.marginLeft = '-1.2rem';
      item.innerHTML = `<b>${r.group}</b>`;
    } else {
      item.className = r.ok ? 'ok' : 'ko';
      item.textContent = r.name;
      if (r.detail) {
        const detail = document.createElement('span');
        detail.className = 'detail';
        detail.textContent = ` — ${r.detail}`;
        item.append(detail);
      }
    }
    list.append(item);
  }
  box.append(list);
}

// Le stockage revient à l'appareil quoi qu'il arrive : échec du banc, ou page quittée en
// plein essai. Sans ce filet, une exécution interrompue laisserait l'application amputée
// de ses relevés et de son jeton.
window.addEventListener('beforeunload', returnStorage);

run()
  .catch((err) => {
    results.push({
      name: `interrompu : ${err.message}`,
      ok: false,
      detail: String(err.stack).split('\n')[1]?.trim() ?? '',
    });
    render();
  })
  .finally(() => {
    returnStorage();
    const note = document.createElement('p');
    note.textContent = `Stockage de l'application rendu intact — ${KEPT.size} clé(s) restaurée(s).`;
    $('rapport').append(note);
  });
