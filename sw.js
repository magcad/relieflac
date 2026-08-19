// Service worker « réseau d'abord ».
//
// Objectif double :
//   • toujours servir la DERNIÈRE version quand il y a du réseau (fini le cache HTTP
//     collant d'iOS qui rejoue une version périmée) ;
//   • rester utilisable HORS LIGNE sur le lac, en resservant le dernier état connu.
//
// Stratégie : pour chaque ressource du même origine, on tente le réseau d'abord, on met la
// réponse en cache, et on ne se rabat sur le cache qu'en cas d'échec réseau. Les requêtes
// vers d'autres origines (tuiles IGN, API GitHub, cote EDF) ne sont pas interceptées.

const CACHE = 'relieflac-2026-08-19.4';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // tuiles, API GitHub, EDF : intacts

  event.respondWith((async () => {
    try {
      // `no-cache` : on revalide toujours auprès du serveur (304 bon marché si inchangé),
      // pour ne pas laisser le cache HTTP du navigateur intercaler une version périmée.
      const fresh = await fetch(request, { cache: 'no-cache' });
      if (fresh && fresh.ok) {
        const cache = await caches.open(CACHE);
        cache.put(request, fresh.clone());
      }
      return fresh;
    } catch {
      const cached = await caches.match(request);
      if (cached) return cached;
      throw new Error('hors ligne et non mis en cache');
    }
  })());
});
