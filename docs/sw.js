"use strict";
// Offline copy for the published page. Every request goes to the network
// first so a republished plan shows up at once; the last good copy is kept
// and served when there is no signal, or when the network takes too long.
// Registered only by the published page, never by server.py's.

const CACHE = "eas3010-itinerary";
const SHELL = ["./", "index.html", "app.js", "style.css", "snapshot.json"];
const PATIENCE = 4000;  // ms to wait for the network before using the saved copy

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  const network = fetch(e.request);
  // save a copy as it arrives; cross-origin fonts come back opaque (status 0), keep those too
  // (clone before the page reads the body)
  e.waitUntil(network.then(res => {
    if (!res.ok && res.type !== "opaque") return;
    const copy = res.clone();
    return caches.open(CACHE).then(c => c.put(e.request, copy));
  }).catch(() => {}));
  e.respondWith(answer(e.request, network));
});

async function answer(request, network) {
  const saved = await caches.match(request, {ignoreSearch: true});
  if (!saved) return network;
  const slow = new Promise(resolve => setTimeout(resolve, PATIENCE, saved));
  return Promise.race([network.catch(() => saved), slow]);
}
