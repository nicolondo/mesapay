"use client";

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useVisibleEventSource } from "@/lib/useVisibleEventSource";

/**
 * Aviso de PANTALLA COMPLETA para el administrador: "la mesa X pidió la
 * cuenta".
 *
 * Sólo se monta cuando el comercio activó "solo el administrador cobra"
 * (ver Restaurant.adminOnlyCharge) y el que mira es un administrador. Es
 * la contraparte de haberle quitado el cobro al mesero: si el dueño es el
 * único que puede cobrar, tiene que enterarse sin estar mirando el panel.
 *
 * Diseño:
 *   - Naranja de marca (`--rail-accent` / `--terracotta-2`), no un hex suelto.
 *   - 3 destellos tipo flash al aparecer y DESPUÉS FIJO. Nunca parpadeo
 *     indefinido: molesta y es un riesgo de accesibilidad.
 *   - `prefers-reduced-motion` ⇒ aparece igual, sin destellar (la clase
 *     .bill-alert-flash queda anulada en globals.css).
 *   - COLA, no pila: si tres mesas piden la cuenta seguidas se muestra
 *     una a la vez con un contador "+N"; cerrar pasa a la siguiente. Nunca
 *     hay dos capas superpuestas dejando la app inutilizable.
 *   - Se cierra con Esc, con el botón, o yendo a cobrar.
 *
 * Costo de red: abre su propio EventSource. Es una conexión más por
 * pestaña VISIBLE sobre el mismo endpoint que LiveRefresh (el hook cierra
 * la conexión al pasar a segundo plano, así que las pestañas de fondo no
 * gastan). Aceptable porque es opt-in: sólo existe con la política
 * encendida.
 */

export type BillRequest = {
  key: string;
  orderId: string;
  shortCode: string;
  tableNumber: number;
  tableLabel: string | null;
  source: "diner" | "staff";
};

const STORAGE_KEY = "mp_bill_requests";
const MAX_QUEUE = 20;
const EMPTY: BillRequest[] = [];

// ── Store externo ────────────────────────────────────────────────────────
//
// La cola vive fuera de React (módulo + useSyncExternalStore) por dos
// razones: se espeja en sessionStorage —un F5 no se come un aviso que el
// administrador todavía no vio— y rehidratar desde storage en un
// useEffect obligaría a un setState dentro del efecto, que es justo el
// anti-patrón de renders en cascada. El snapshot del servidor es siempre
// vacío, así que el HTML servido y el primer render del cliente coinciden.

let queue: BillRequest[] = EMPTY;
let hydrated = false;
const listeners = new Set<() => void>();

function readStored(): BillRequest[] {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return EMPTY;
    // Validación defensiva: sessionStorage lo puede haber escrito una
    // versión anterior del componente.
    const clean = parsed.filter(
      (r): r is BillRequest =>
        !!r &&
        typeof r === "object" &&
        typeof (r as BillRequest).key === "string" &&
        typeof (r as BillRequest).orderId === "string",
    );
    return clean.length > 0 ? clean : EMPTY;
  } catch {
    return EMPTY;
  }
}

function persist(next: BillRequest[]) {
  queue = next;
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Modo privado / storage lleno: el aviso sigue vivo en memoria.
  }
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  // Primera suscripción del proceso: recuperamos lo que quedó pendiente.
  // React vuelve a leer el snapshot justo después de suscribirse, así que
  // cambiarlo acá se refleja sin un render extra.
  if (!hydrated) {
    hydrated = true;
    const stored = readStored();
    if (stored.length > 0) queue = stored;
  }
  return () => {
    listeners.delete(listener);
  };
}

const getSnapshot = () => queue;
const getServerSnapshot = () => EMPTY;

function enqueue(req: BillRequest) {
  // Una mesa que insiste no genera dos avisos: refrescamos el que ya
  // estaba en cola en vez de apilar duplicados.
  const without = queue.filter((r) => r.orderId !== req.orderId);
  persist([...without, req].slice(-MAX_QUEUE));
}

// ── Componente ───────────────────────────────────────────────────────────

export function BillRequestAlert({ tenantSlug }: { tenantSlug: string }) {
  const t = useTranslations("billAlert");
  const router = useRouter();
  const items = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const dismissRef = useRef<HTMLButtonElement | null>(null);

  useVisibleEventSource(
    `/api/tenant/${tenantSlug}/events`,
    (es) =>
      es.addEventListener("message", (ev) => {
        try {
          const data = JSON.parse(ev.data);
          if (data?.type !== "order.bill_requested") return;
          enqueue({
            key: `${data.orderId}:${Date.now()}`,
            orderId: String(data.orderId),
            shortCode: String(data.shortCode ?? ""),
            tableNumber: Number(data.tableNumber ?? 0),
            tableLabel: data.tableLabel ?? null,
            source: data.source === "staff" ? "staff" : "diner",
          });
          try {
            navigator.vibrate?.([200, 90, 200, 90, 200]);
          } catch {}
        } catch {}
      }),
    undefined,
  );

  const current = items[0] ?? null;

  const dismiss = useCallback(() => {
    persist(queue.slice(1));
  }, []);

  // Esc cierra. Sólo escuchamos mientras hay un aviso vivo.
  useEffect(() => {
    if (!current) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") dismiss();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, dismiss]);

  // Foco al botón de cerrar al aparecer, para que el teclado no siga
  // navegando la página que quedó detrás del aviso.
  useEffect(() => {
    dismissRef.current?.focus();
  }, [current?.key]);

  if (!current) return null;

  const where =
    current.tableLabel ?? t("table", { number: current.tableNumber });
  const pending = items.length - 1;

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="bill-alert-title"
      className="fixed inset-0 z-[100] flex items-center justify-center p-5 print:hidden"
      style={{
        background:
          "linear-gradient(160deg, var(--rail-accent), var(--terracotta-2))",
        color: "#FFFDF9",
      }}
    >
      <div
        key={current.key}
        className="bill-alert-flash bill-alert-pop w-full max-w-2xl text-center"
      >
        <div className="font-mono text-[11px] md:text-sm tracking-[0.28em] uppercase opacity-90">
          {current.source === "staff" ? t("kickerStaff") : t("kickerDiner")}
        </div>

        <div
          id="bill-alert-title"
          className="font-display leading-[0.95] mt-3 text-[clamp(3rem,16vw,8rem)]"
        >
          {where}
        </div>

        <div className="font-display mt-2 text-[clamp(1.5rem,6vw,3rem)] opacity-95">
          {t("headline")}
        </div>

        {current.shortCode && (
          <div className="font-mono text-xs md:text-sm tracking-[0.2em] uppercase mt-4 opacity-80">
            {current.shortCode}
          </div>
        )}

        <div className="mt-8 flex flex-col sm:flex-row items-stretch justify-center gap-3">
          <Link
            href={`/t/${tenantSlug}/pay/${current.orderId}?op=1`}
            target="_blank"
            rel="noreferrer"
            onClick={dismiss}
            className="h-12 px-7 rounded-full bg-ivory text-ink text-base font-medium inline-flex items-center justify-center hover:opacity-90"
          >
            {t("charge")}
          </Link>
          <button
            type="button"
            ref={dismissRef}
            onClick={dismiss}
            className="h-12 px-7 rounded-full border border-ivory/60 text-ivory text-base font-medium inline-flex items-center justify-center hover:bg-ivory/10"
          >
            {t("dismiss")}
          </button>
        </div>

        {pending > 0 && (
          <button
            type="button"
            onClick={() => {
              // Ver el resto implica ir al piso: vaciamos la cola y
              // mandamos al Salón, que las lista todas.
              persist(EMPTY);
              router.push("/operator/serve");
            }}
            className="mt-6 font-mono text-[11px] tracking-[0.18em] uppercase underline opacity-90"
          >
            {t("more", { count: pending })}
          </button>
        )}
      </div>
    </div>
  );
}
