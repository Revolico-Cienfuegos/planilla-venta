const CACHE = "vc-v5"; // Cambio de versión para forzar actualización
const ASSETS = [
  "./index.html",
  "./admin-vc.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png"
];

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const url = e.request.url;

  // Para productos.json: siempre ir a la red, y si falla, devolver un array vacío
  if (url.includes("productos.json")) {
    e.respondWith(
      fetch(e.request, { cache: "no-store" })
        .then(res => {
          // Clonar y cachear para futuros fallos
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
          return res;
        })
        .catch(() => {
          // Si la red falla, devolver un JSON vacío en lugar de error
          return new Response(JSON.stringify([]), {
            headers: { "Content-Type": "application/json" }
          });
        })
    );
    return;
  }

  // Para imágenes: caché primero, luego red
  if (url.includes("/imagenes/")) {
    e.respondWith(
      caches.match(e.request).then(cached => {
        if (cached) return cached;
        return fetch(e.request).then(res => {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
          return res;
        });
      })
    );
    return;
  }

  // Para el resto: caché primero, red como fallback
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});