/**
 * Service Worker offline-first pour WebRecovery.
 * Stratégie Cache-First sur les assets statiques versionnés de même origine
 * pour un fonctionnement instantané et 100 % autonome hors-ligne.
 * Network-Only strict sur Intervals.icu, Gemini API et Google Apps Script.
 */

const CACHE_NAME = "webrecovery-v1";

const PRECACHE_ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./engine.js",
  "./intervalsClient.js",
  "./geminiClient.js",
  "./fallbackGenerator.js",
  "./timer.js",
  "./bleOximeter.js",
  "./catalog.js",
  "./vault.js",
  "./outbox.js",
  "./driveSync.js",
  "./errorGuard.js",
  "./icon.svg",
  "./manifest.webmanifest",
];

const PRECACHE_PATHS = new Set(
  PRECACHE_ASSETS.map((asset) => new URL(asset, self.location.href).pathname)
);

/**
 * Pré-cache tous les assets applicatifs locaux lors de l'installation.
 */
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) =>
        Promise.all(
          PRECACHE_ASSETS.map(async (assetUrl) => {
            const response = await fetch(assetUrl, { cache: "no-cache" });
            if (!response.ok) {
              throw new Error(
                `Échec du pré-cache (${response.status}) : ${assetUrl}`
              );
            }
            return cache.put(assetUrl, response);
          })
        )
      )
      .then(() => self.skipWaiting())
  );
});

/**
 * Purge les anciens caches lors de l'activation et prend le contrôle des clients.
 */
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((oldKey) => caches.delete(oldKey))
        )
      )
      .then(() => self.clients.claim())
  );
});

/**
 * Vérifie si la requête cible un hôte API externe à traiter en Network-Only strict.
 * @param {URL} url
 * @returns {boolean}
 */
function isNetworkOnlyHost(url) {
  const host = url.hostname.toLowerCase();
  return (
    host === "intervals.icu" ||
    host.endsWith(".intervals.icu") ||
    host === "generativelanguage.googleapis.com" ||
    host === "script.google.com" ||
    host === "script.googleusercontent.com"
  );
}

/**
 * Stratégie Cache-First stricte limitée aux seuls assets de PRECACHE_ASSETS
 * (sans ignoreSearch ni mise en cache opportuniste).
 */
self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") {
    return;
  }

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }

  if (isNetworkOnlyHost(url) || url.origin !== self.location.origin) {
    return;
  }

  if (!PRECACHE_PATHS.has(url.pathname) || url.search) {
    return;
  }

  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }

      return fetch(request).catch(async () => {
        if (request.mode === "navigate") {
          const shell = await caches.match("./index.html");
          if (shell) {
            return shell;
          }
        }
        return new Response("Ressource indisponible hors-ligne.", {
          status: 503,
          statusText: "Service Unavailable",
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      });
    })
  );
});
