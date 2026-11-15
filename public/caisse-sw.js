// IzyVendeur Caisse - service worker minimal (Etape 88).
// Il ne met en cache QUE la coque de la page (HTML, manifeste, icones) pour que la caisse s'installe et s'ouvre vite, meme sur un reseau lent.
// Il ne touche JAMAIS aux appels /api : une vente, un stock ou un prix ne doivent jamais venir d'un cache (le mode hors ligne, Etape 91, garde ses ventes dans IndexedDB cote page : le service worker ne sert QUE la coque).
const VERSION = "caisse-v1";
const COQUE = ["/caisse", "/caisse.webmanifest", "/caisse-icon-192.png", "/caisse-icon-512.png"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(VERSION).then((c) => c.addAll(COQUE)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((cles) => Promise.all(cles.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin || url.pathname.indexOf("/api/") === 0 || COQUE.indexOf(url.pathname) === -1) return;
  // Reseau d'abord (la page est toujours a jour), cache en secours.
  e.respondWith(fetch(req).then((rep) => { if (rep && rep.ok) { const copie = rep.clone(); caches.open(VERSION).then((c) => c.put(req, copie)); } return rep; }).catch(() => caches.match(req)));
});
