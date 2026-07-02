const CACHE = "vc-v3";
const ASSETS = ["./index.html","./admin-vc.html","./manifest.json","./icon-192.png","./icon-512.png"];

self.addEventListener("install", e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting()));
});
self.addEventListener("activate", e=>{
  e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});
self.addEventListener("fetch", e=>{
  const url = e.request.url;
  if(url.includes("productos.json")){
    e.respondWith(fetch(e.request).then(r=>{const c=r.clone();caches.open(CACHE).then(ch=>ch.put(e.request,c));return r;}).catch(()=>caches.match(e.request)));
    return;
  }
  if(url.includes("/imagenes/")){
    e.respondWith(caches.match(e.request).then(c=>{if(c)return c;return fetch(e.request).then(r=>{const cl=r.clone();caches.open(CACHE).then(ch=>ch.put(e.request,cl));return r;});}));
    return;
  }
  e.respondWith(caches.match(e.request).then(c=>c||fetch(e.request)));
});
