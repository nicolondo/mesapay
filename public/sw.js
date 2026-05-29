/* MESAPAY service worker.
 *
 * Responsabilidades:
 *   1. Web Push — recibir notificaciones server-sent y mostrarlas.
 *      (Único motivo original por el que armamos este SW.)
 *   2. Cache de chunks estáticos de Next.js (cache-first sobre
 *      /_next/static/) — los chunks tienen hash en el nombre, así
 *      que cachearlos fuerte no genera staleness. El bundle pesado
 *      de @kushki/js (~500KB) carga instantáneo en visitas posteriores.
 *
 * Lifecycle: skipWaiting + clients.claim para que cada deploy nuevo
 * tome control sin requerir hard refresh. La policy de cleanup borra
 * caches viejos en cada activate.
 */

const STATIC_CACHE = "mesapay-static-v1";

self.addEventListener("install", (event) => {
  // Activate this version as soon as it's installed. With each new
  // deploy the SW updates silently in the background; without
  // skipWaiting it would otherwise wait for every open tab to close.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Borrar caches huérfanos de versiones anteriores del SW.
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k !== STATIC_CACHE).map((k) => caches.delete(k)),
      );
      // Take control of pages that were open with the previous SW.
      await self.clients.claim();
    })(),
  );
});

/**
 * Cache-first para chunks immutables de Next. Todo lo demás (HTML,
 * /api/*, etc.) pasa por la red sin tocar — no queremos cachear datos
 * vivos ni la shell de las páginas.
 */
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith("/_next/static/")) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(STATIC_CACHE);
      const cached = await cache.match(req);
      if (cached) return cached;
      try {
        const res = await fetch(req);
        // Solo cacheamos respuestas exitosas — un 404 transitorio no
        // debería contaminar el cache.
        if (res.ok) cache.put(req, res.clone());
        return res;
      } catch (err) {
        // Fallo de red: si por algún motivo tenemos algo en cache,
        // lo devolvemos. Si no, propaga el error original.
        if (cached) return cached;
        throw err;
      }
    })(),
  );
});

/**
 * Push event. Server-sent payload looks like:
 *   { title, body, url?, tag? }
 * The url is where we navigate when the user taps the notification.
 * tag groups duplicates (same orderId across N rapid events).
 */
self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (_e) {
    payload = { title: "MESAPAY", body: event.data ? event.data.text() : "" };
  }
  const title = payload.title || "MESAPAY";
  const options = {
    body: payload.body || "",
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    tag: payload.tag || undefined,
    // Renotify so the user sees an OS banner even when an older
    // notification with the same tag is still visible.
    renotify: Boolean(payload.tag),
    data: {
      url: payload.url || "/mesero/salon",
    },
    // Keep the OS notification visible until the user dismisses it on
    // platforms that respect this hint (Chrome desktop). iOS PWA push
    // already requires explicit dismissal.
    requireInteraction: false,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

/** Tap → focus/open the linked URL. */
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || "/mesero/salon";
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      // If we already have a window on the same origin, focus it and
      // navigate. Avoids opening a second app instance every time.
      for (const client of all) {
        try {
          const u = new URL(client.url);
          const o = new URL(targetUrl, self.location.origin);
          if (u.origin === o.origin) {
            await client.focus();
            if ("navigate" in client) {
              try {
                await client.navigate(o.href);
              } catch (_e) {
                /* navigate fails on some Safari builds — focus is enough */
              }
            }
            return;
          }
        } catch (_e) {
          /* malformed url, ignore */
        }
      }
      // Otherwise pop a fresh window.
      await self.clients.openWindow(targetUrl);
    })(),
  );
});
