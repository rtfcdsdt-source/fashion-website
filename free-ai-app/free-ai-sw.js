// Free AI Chat — service worker v3
// Static cheezein (icons, skills list) cache-first; HTML network-first
// (taaki naya deploy turant dikhe), net na ho to last saved page.
// API / cross-origin calls kabhi cache nahi hoti.
var CACHE = "free-ai-shell-v3";
var PAGE = new URL(self.registration.scope).pathname;
var SHELL = [
  "/free-ai-manifest.json",
  "/free-ai-skills.js",
  "/free-ai-icon.svg",
  "/free-ai-icon-192.png",
  "/free-ai-icon-512.png"
];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE)
      .then(function (c) { return c.addAll(SHELL.concat([PAGE])); })
      .catch(function () {})
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (event) {
  var req = event.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // API, Google, Pollinations — seedha network

  // Static cheezein (icons, skills list): cache-first — turant khulti hain
  if (/\/free-ai-(skills\.js|icon)/.test(url.pathname)) {
    event.respondWith(
      caches.match(req).then(function (hit) {
        return hit || fetch(req).then(function (res) {
          if (res && res.ok) { var c2 = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, c2); }).catch(function () {}); }
          return res;
        });
      })
    );
    return;
  }

  event.respondWith(
    fetch(req)
      .then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); }).catch(function () {});
        }
        return res;
      })
      .catch(function () {
        return caches.match(req).then(function (hit) {
          return hit || (req.mode === "navigate" ? caches.match(PAGE) : Response.error());
        });
      })
  );
});
