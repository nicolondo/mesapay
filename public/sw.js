/* MESAPAY service worker — SOLO Web Push.
 *
 * IMPORTANTE: este SW NO intercepta fetch ni cachea assets. Lo
 * intentamos (cache-first sobre /_next/static/ para acelerar 2das
 * visitas) pero rompía a usuarios recurrentes: tras un deploy, el SW
 * servía chunks viejos mientras el HTML/RSC payload eran del build
 * nuevo → "Failed to fetch RSC payload" + la sesión authjs fallaba.
 * El síntoma clásico: incógnito funcionaba (sin SW), ventana normal no.
 *
 * Si en el futuro queremos cachear estáticos, hay que hacerlo con una
 * key versionada por build-id (no por URL) y network-first para
 * navegación — no vale la pena el riesgo por ahora.
 *
 * Lifecycle: skipWaiting + clients.claim para que esta versión tome
 * control de inmediato y, crucialmente, el activate de abajo PURGA
 * cualquier cache que la versión anterior haya dejado — así los
 * clientes con el cache malo se recuperan solos al actualizar el SW.
 */

self.addEventListener("install", (event) => {
  // Activate this version as soon as it's installed. With each new
  // deploy the SW updates silently in the background; without
  // skipWaiting it would otherwise wait for every open tab to close.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Purga TODOS los caches — incluido el "mesapay-static-v1" que
      // dejó la versión anterior del SW. Esto es lo que recupera a los
      // usuarios que quedaron con chunks stale tras el deploy.
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
      // Take control of pages that were open with the previous SW.
      await self.clients.claim();
    })(),
  );
});

// (Sin handler de fetch — todo va a la red normalmente.)

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
