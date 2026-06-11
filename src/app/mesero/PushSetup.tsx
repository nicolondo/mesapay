"use client";

import { useEffect, useState } from "react";

type Status =
  | "unsupported"
  | "not_configured"
  | "default"
  | "denied"
  | "granted"
  | "subscribing"
  | "subscribed"
  | "error";

/**
 * Discreet "Activar notificaciones" button for the mesero PWA. Lives
 * in the mesero layout so meseros see the prompt the first time they
 * open the app on their phone.
 *
 * Flow:
 *   1. Check that this browser supports Notification + ServiceWorker
 *      + PushManager. iOS Safari needs the app to be installed to
 *      home screen FIRST — without that it returns "unsupported".
 *   2. Register /sw.js (idempotent — subsequent visits reuse the
 *      existing registration).
 *   3. If permission already granted, double-check that we have an
 *      active subscription server-side; if missing, re-subscribe.
 *   4. On tap: request permission → subscribe → POST to
 *      /api/push/subscribe.
 *
 * Once subscribed the button hides itself. Nothing to do, no clutter.
 *
 * `copy` — optional pre-translated strings. When omitted, falls back
 * to the default mesero Spanish copy (backward-compatible). Pass from
 * a server layout using `getTranslations` to provide context-specific
 * text (e.g. CRM variant).
 */
type PushCopy = {
  body: string;
  denied: string;
  error: string;
  enable: string;
  enabling: string;
};

const MESERO_COPY: PushCopy = {
  body: "Recibe avisos cuando una mesa te llame o pida cobrar.",
  denied: "Las notificaciones están bloqueadas en este celular. Habílitalas desde los ajustes del navegador y vuelve a abrir la app.",
  error: "No pudimos activar las notificaciones. Intenta de nuevo.",
  enable: "Activar",
  enabling: "Activando…",
};

export function PushSetup({ copy }: { copy?: PushCopy }) {
  const strings = copy ?? MESERO_COPY;
  const [status, setStatus] = useState<Status>("default");

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (
      !("Notification" in window) ||
      !("serviceWorker" in navigator) ||
      !("PushManager" in window)
    ) {
      setStatus("unsupported");
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const reg = await navigator.serviceWorker.register("/sw.js");
        // Wait until the worker is active so PushManager has something
        // to attach to.
        await navigator.serviceWorker.ready;

        const perm = Notification.permission as
          | "default"
          | "granted"
          | "denied";
        if (cancelled) return;

        if (perm === "denied") {
          setStatus("denied");
          return;
        }

        if (perm === "granted") {
          // Already opted in — make sure the server has the current
          // subscription. Browsers occasionally drop subs (storage
          // clear, key rotation) and we'd silently stop receiving
          // notifs without this check.
          const existing = await reg.pushManager.getSubscription();
          if (existing) {
            setStatus("subscribed");
            // Send to server in case our row was lost (idempotent
            // upsert by endpoint).
            await persistSubscription(existing).catch(() => undefined);
            return;
          }
          // Permission granted but no sub — subscribe now.
          const result = await subscribe(reg);
          if (cancelled) return;
          if (result.kind === "not_configured") {
            setStatus("not_configured");
            return;
          }
          if (result.kind === "ok" && result.sub) {
            await persistSubscription(result.sub).catch(() => undefined);
            setStatus("subscribed");
          } else {
            setStatus("error");
          }
          return;
        }

        // perm === "default" → wait for tap.
        setStatus("default");
      } catch (err) {
        console.error("[PushSetup] init failed", err);
        if (!cancelled) setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function enable() {
    if (status === "subscribed" || status === "subscribing") return;
    setStatus("subscribing");
    try {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        setStatus(perm === "denied" ? "denied" : "default");
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const result = await subscribe(reg);
      if (result.kind === "not_configured") {
        // VAPID no está seteado en el server todavía. No es un error
        // del mesero; ocultamos el banner hasta que ops lo configure.
        setStatus("not_configured");
        return;
      }
      if (result.kind === "error" || !result.sub) {
        setStatus("error");
        return;
      }
      await persistSubscription(result.sub);
      setStatus("subscribed");
    } catch (err) {
      console.error("[PushSetup] enable failed", err);
      setStatus("error");
    }
  }

  // No UI when nothing actionable is left.
  if (
    status === "subscribed" ||
    status === "unsupported" ||
    status === "not_configured"
  ) {
    return null;
  }

  return (
    <div className="border-b border-hairline bg-ivory px-4 py-2.5 flex items-center justify-between gap-3">
      <div className="text-[12px] text-ink/80 min-w-0">
        {status === "denied" ? (
          <>{strings.denied}</>
        ) : status === "error" ? (
          <>{strings.error}</>
        ) : (
          <>{strings.body}</>
        )}
      </div>
      {status !== "denied" && (
        <button
          type="button"
          onClick={enable}
          disabled={status === "subscribing"}
          className="shrink-0 h-8 px-3 rounded-full bg-ink text-bone text-[11px] font-medium disabled:opacity-60"
        >
          {status === "subscribing" ? strings.enabling : strings.enable}
        </button>
      )}
    </div>
  );
}

type SubscribeResult =
  | { kind: "ok"; sub: PushSubscription }
  | { kind: "not_configured" }
  | { kind: "error" };

async function subscribe(
  reg: ServiceWorkerRegistration,
): Promise<SubscribeResult> {
  const res = await fetch("/api/push/vapid-key");
  // 503 = server-side VAPID no configurado. Distinto a un error
  // real porque no hay nada que el mesero pueda hacer; lo manejamos
  // ocultando el banner.
  if (res.status === 503) return { kind: "not_configured" };
  if (!res.ok) return { kind: "error" };
  const { publicKey } = (await res.json()) as { publicKey?: string };
  if (!publicKey) return { kind: "not_configured" };
  try {
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      // Cast to BufferSource — DOM types for applicationServerKey are
      // overly strict about SharedArrayBuffer that Uint8Array doesn't
      // even use here.
      applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
    });
    return { kind: "ok", sub };
  } catch (err) {
    console.error("[PushSetup] subscribe failed", err);
    return { kind: "error" };
  }
}

async function persistSubscription(sub: PushSubscription): Promise<void> {
  const json = sub.toJSON();
  const endpoint = json.endpoint;
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!endpoint || !p256dh || !auth) return;
  await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      endpoint,
      keys: { p256dh, auth },
    }),
  });
}

// Standard helper for the Web Push protocol — the VAPID public key
// is sent over the wire as a URL-safe base64 string, but PushManager
// wants raw bytes.
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const out = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) out[i] = rawData.charCodeAt(i);
  return out;
}
