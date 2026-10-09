// Service Worker de la Planilla — permite abrir y llenar el formulario sin conexión.
const CACHE_NAME = "planilla-cache-v3";
const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./ia.js",
  "./icon-192.png",
  "./icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // cache: "reload" evita instalar una copia vieja guardada en la caché HTTP
      cache.addAll(APP_SHELL.map((u) => new Request(u, { cache: "reload" })))
    )
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Estrategia: cache-first para el propio sitio, network-first (con caché de respaldo) para lo externo (ej. Google Fonts)
self.addEventListener("fetch", (event) => {
  // Solo se gestionan peticiones GET. Las peticiones POST (p. ej. al servicio de IA)
  // NUNCA pasan por la caché: contienen datos de clientes.
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  const isSameOrigin = url.origin === self.location.origin;
  const isFont = url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com";
  // Cualquier otro origen (el Worker de IA, etc.) va directo a la red, sin caché.
  if (!isSameOrigin && !isFont) return;

  if (isSameOrigin) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        return (
          cached ||
          fetch(event.request)
            .then((response) => {
              const clone = response.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
              return response;
            })
            .catch(() => caches.match("./index.html"))
        );
      })
    );
  } else {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          return response;
        })
        .catch(() => caches.match(event.request))
    );
  }
});
