"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useState, useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";

/**
 * Guía para instalar la PWA "MP CRM" (manifest /api/manifest/comercial).
 *
 * Dos modos:
 *  - `card`   → tarjeta en /comercial/mas (ancla #instalar): explicación y la
 *               acción que corresponda al entorno.
 *  - `banner` → franja compacta en la cabecera del pipeline, sólo móvil,
 *               descartable (localStorage) y con salida a la tarjeta.
 *
 * Entornos:
 *  (a) Chrome / Edge / Android: el navegador dispara `beforeinstallprompt`;
 *      lo retenemos y mostramos "Instalar", que llama a `prompt()`.
 *  (b) iOS Safari: no existe ese evento; van los pasos Compartir → Agregar a
 *      pantalla de inicio → Agregar.
 *  (c) Escritorio u otros: se instala desde el menú del navegador.
 *
 * En modo standalone (la app ya instalada) no renderiza nada.
 */

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

type Platform = "ios" | "android" | "other";

type Snapshot = {
  ready: boolean;
  standalone: boolean;
  platform: Platform;
  canPrompt: boolean;
  installed: boolean;
  dismissed: boolean;
};

const DISMISSED_KEY = "mp-crm-install-dismissed";

// ── Store a nivel de módulo ────────────────────────────────────────────────
// Chrome dispara `beforeinstallprompt` UNA sola vez por carga y, en general,
// antes de que React hidrate: escucharlo en un efecto lo perdería. El bundle
// del cliente se evalúa al cargar la página, así que acá llegamos a tiempo, y
// el evento retenido queda disponible para cualquier instancia que monte
// después (p. ej. al navegar del pipeline a "Más").

const SERVER_SNAPSHOT: Snapshot = {
  ready: false,
  standalone: false,
  platform: "other",
  canPrompt: false,
  installed: false,
  dismissed: false,
};

let deferredPrompt: BeforeInstallPromptEvent | null = null;
let installed = false;
// Respaldo en memoria por si localStorage está bloqueado (Safari privado).
let dismissedThisSession = false;
let snapshot: Snapshot | null = null;
const listeners = new Set<() => void>();

function readDismissed(): boolean {
  if (dismissedThisSession) return true;
  try {
    return window.localStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

function detectPlatform(): Platform {
  const ua = navigator.userAgent;
  // iPadOS se presenta como Mac de escritorio; se delata por el multitouch.
  const iPadOs = navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  if (/iPhone|iPad|iPod/i.test(ua) || iPadOs) return "ios";
  if (/Android/i.test(ua)) return "android";
  return "other";
}

function isStandalone(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean };
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    nav.standalone === true
  );
}

function compute(): Snapshot {
  return {
    ready: true,
    standalone: isStandalone(),
    platform: detectPlatform(),
    canPrompt: deferredPrompt !== null,
    installed,
    dismissed: readDismissed(),
  };
}

function refresh() {
  snapshot = compute();
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): Snapshot {
  if (snapshot === null) snapshot = compute();
  return snapshot;
}

function getServerSnapshot(): Snapshot {
  return SERVER_SNAPSHOT;
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    // Sin preventDefault, Chrome Android muestra su mini-barra además de la nuestra.
    e.preventDefault();
    deferredPrompt = e as BeforeInstallPromptEvent;
    refresh();
  });
  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    installed = true;
    refresh();
  });
}

function dismiss() {
  dismissedThisSession = true;
  try {
    window.localStorage.setItem(DISMISSED_KEY, "1");
  } catch {
    // Sin almacenamiento: queda oculta durante esta carga igual.
  }
  refresh();
}

async function promptInstall(): Promise<"accepted" | "dismissed" | "unavailable"> {
  const ev = deferredPrompt;
  if (!ev) return "unavailable";
  // El evento sólo admite un prompt(); si el usuario lo cierra, Chrome puede
  // volver a disparar beforeinstallprompt más adelante y lo retomamos.
  deferredPrompt = null;
  refresh();
  try {
    await ev.prompt();
    const { outcome } = await ev.userChoice;
    if (outcome === "accepted") {
      installed = true;
      refresh();
    }
    return outcome;
  } catch {
    return "unavailable";
  }
}

function useInstallState(): Snapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

// ── UI ─────────────────────────────────────────────────────────────────────

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta focus-visible:ring-offset-2 focus-visible:ring-offset-op-surface";

const PRIMARY_BTN =
  "inline-flex min-h-[44px] items-center justify-center rounded-xl bg-terracotta px-4 text-sm font-medium text-white disabled:opacity-50 " +
  FOCUS_RING;

const PRIMARY_BTN_SM =
  "shrink-0 inline-flex min-h-[44px] items-center justify-center rounded-lg bg-terracotta px-3 text-[12px] font-medium text-white disabled:opacity-50 " +
  FOCUS_RING;

const SECONDARY_BTN_SM =
  "shrink-0 inline-flex min-h-[44px] items-center justify-center rounded-lg border border-terracotta px-3 text-[12px] font-medium text-terracotta " +
  FOCUS_RING;

export function InstallCrmApp({ mode }: { mode: "card" | "banner" }) {
  const t = useTranslations("crm");
  const s = useInstallState();
  // Ya se mostró el diálogo nativo (Chrome no lo repite en la misma carga):
  // se cae al texto de "instálala desde el menú".
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);

  const onInstall = useCallback(async () => {
    setBusy(true);
    const outcome = await promptInstall();
    setBusy(false);
    if (outcome !== "accepted") setAttempted(true);
  }, []);

  if (!s.ready || s.standalone) return null;

  if (mode === "banner") {
    if (s.installed || s.dismissed) return null;
    return (
      <aside
        aria-label={t("installBannerTitle")}
        className="lg:hidden mx-4 mt-3 flex items-center gap-3 rounded-xl border border-op-border bg-op-surface py-1.5 pl-3 pr-1"
      >
        <AppIcon size={36} />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold leading-tight">
            {t("installBannerTitle")}
          </div>
          <div className="truncate text-[12px] text-op-muted">
            {t("installBannerBody")}
          </div>
        </div>
        {s.canPrompt ? (
          <button
            type="button"
            onClick={onInstall}
            disabled={busy}
            className={PRIMARY_BTN_SM}
          >
            {t("installButton")}
          </button>
        ) : (
          <Link href="/comercial/mas#instalar" className={SECONDARY_BTN_SM}>
            {t("installBannerHow")}
          </Link>
        )}
        <button
          type="button"
          onClick={dismiss}
          aria-label={t("installDismiss")}
          title={t("installDismiss")}
          className={
            "shrink-0 inline-flex h-11 w-11 items-center justify-center rounded-full text-op-muted hover:text-op-text " +
            FOCUS_RING
          }
        >
          <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4" aria-hidden>
            <path
              fillRule="evenodd"
              d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
              clipRule="evenodd"
            />
          </svg>
        </button>
      </aside>
    );
  }

  return (
    <section
      id="instalar"
      aria-labelledby="instalar-titulo"
      className="scroll-mt-4 mb-6 rounded-2xl border border-op-border bg-op-surface p-4"
    >
      <div className="flex items-start gap-3">
        <AppIcon size={44} />
        <div className="min-w-0 flex-1">
          <h2 id="instalar-titulo" className="text-sm font-semibold">
            {s.installed ? t("installInstalledTitle") : t("installCardTitle")}
          </h2>
          <p className="mt-1 text-sm text-op-muted">
            {s.installed ? t("installInstalledBody") : t("installCardBody")}
          </p>

          {!s.installed && (
            <div className="mt-3 text-sm">
              {s.canPrompt ? (
                <button
                  type="button"
                  onClick={onInstall}
                  disabled={busy}
                  className={PRIMARY_BTN}
                >
                  {t("installButton")}
                </button>
              ) : s.platform === "ios" ? (
                <>
                  <p>{t("installIosIntro")}</p>
                  <ol className="mt-1 list-decimal space-y-1 pl-5">
                    <li>{t("installIosStep1")}</li>
                    <li>{t("installIosStep2")}</li>
                    <li>{t("installIosStep3")}</li>
                  </ol>
                </>
              ) : (
                <p>{attempted ? t("installManualHint") : t("installOtherBody")}</p>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

/** El icono real de la app, para que se reconozca en la pantalla de inicio. */
function AppIcon({ size }: { size: number }) {
  return (
    <Image
      src="/icons/crm-192.png"
      alt=""
      aria-hidden
      width={size}
      height={size}
      className="shrink-0 rounded-xl"
    />
  );
}
