/* MESAPAY service worker — primarily for Web Push.
 *
 * Not a full PWA caching strategy yet (no offline shell, no asset
 * precache). The only reason we ship a SW is because Web Push REQUIRES
 * one to register a subscription and to deliver notifications even
 * when the page isn't open.
 *
 * Lifecycle: skipWaiting + clients.claim so freshly-deployed versions
 * take over immediately without a hard refresh.
 */

self.addEventListener("install", (event) => {
  // Activate this version as soon as it's installed. With each new
  // deploy the SW updates silently in the background; without
  // skipWaiting it would otherwise wait for every open tab to close.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  // Take control of pages that were open with the previous SW.
  event.waitUntil(self.clients.claim());
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
