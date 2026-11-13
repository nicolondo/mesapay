"use client";

import { useCallback, useContext, useEffect, useId, useMemo, useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";
import { SessionContext } from "next-auth/react";
import {
  parseStoredPrintPreference,
  printPreferenceStorageKey,
  resolvePrintPreference,
  serializePrintPreference,
  staleStoredPrintPreference,
  type PrintDestination,
  type PrintPreference,
} from "@/lib/print/printDestination";

/**
 * «Imprimir en: Impresora de caja · Este dispositivo», recordado en ESTE
 * equipo y para este comercio (ver `lib/print/printDestination.ts`).
 *
 * Un solo recuerdo por página: si en la lista de pedidos hay veinte
 * botones de reimprimir, cambiar el destino en uno los cambia a todos. Por
 * eso el valor vive en un almacén del módulo (con `useSyncExternalStore`),
 * no en el estado de cada botón.
 *
 * El almacenamiento local puede no existir o tirar (modo privado, datos
 * bloqueados): la elección igual vale mientras la página esté abierta
 * (queda en memoria) y se imprime igual; sólo no sobrevive a recargar.
 */

/** Lo elegido en esta página, por clave: gana sobre el almacenamiento. */
const memory = new Map<string, string>();
const listeners = new Set<() => void>();

function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function readRaw(key: string): string | null {
  if (memory.has(key)) return memory.get(key) ?? null;
  try {
    return browserStorage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeRaw(key: string, raw: string): void {
  memory.set(key, raw);
  try {
    browserStorage()?.setItem(key, raw);
  } catch {
    // Sin almacenamiento: vale para esta página y nada más.
  }
  for (const l of listeners) l();
}

/** Borra lo guardado (en memoria queda "": sin recuerdo). */
function removeRaw(key: string): void {
  memory.set(key, "");
  try {
    browserStorage()?.removeItem(key);
  } catch {
    // Sin almacenamiento: vale para esta página y nada más.
  }
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Otra pestaña del mismo equipo cambió el destino.
  const onStorage = (e: StorageEvent) => {
    if (e.key?.startsWith("mesapay.imprimir.")) {
      if (e.key) memory.delete(e.key);
      listener();
    }
  };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

export type PrintPreferenceState = PrintPreference & {
  remembered: boolean;
  role: string | null;
  /**
   * Ya se sabe quién mira (rol y comercio). Mientras la sesión carga no se
   * sabe qué recuerdo leer ni cuál es el valor por defecto: el selector no
   * marca nada y el botón espera, para no imprimir en el destino equivocado.
   */
  ready: boolean;
  setDestination: (destination: PrintDestination) => void;
};

/** Quién mira, cuando la pantalla ya lo sabe (lo decide el servidor). */
export type PrintViewer = { role: string | null; scope: string | null };

/**
 * La preferencia de impresión de este equipo. El rol y el comercio
 * (`session.user.restaurantId`) salen de `viewer` si la pantalla ya los
 * sabe —las vistas imprimibles los pasan desde el servidor— o de la sesión
 * del cliente, que llega con un pequeño retraso (`ready`). En el servidor y
 * en el primer pintado no hay recuerdo (no se desarma la hidratación).
 *
 * La sesión se lee del contexto y no con `useSession`, que tira fuera de un
 * `<SessionProvider>` (un render suelto, un test): sin proveedor no hay a
 * quién esperar y vale el valor por defecto.
 *
 * El papel de «Este dispositivo» no se elige (`DEVICE_PAPER_MM`): el ancho
 * que guardaba la versión con selector se borra del equipo al leerlo.
 */
export function usePrintPreference(viewer?: PrintViewer | null): PrintPreferenceState {
  const session = useContext(SessionContext);
  const role = viewer ? viewer.role : (session?.data?.user?.role ?? null);
  const scope = viewer ? viewer.scope : (session?.data?.user?.restaurantId ?? null);
  const ready = !!viewer || session?.status !== "loading";
  const key = printPreferenceStorageKey(scope);
  const raw = useSyncExternalStore(
    subscribe,
    () => readRaw(key),
    () => null,
  );
  const resolved = useMemo(
    () => resolvePrintPreference(parseStoredPrintPreference(raw), role),
    [raw, role],
  );
  // Lo que quedó de otra versión (el ancho de papel por equipo) se limpia;
  // el destino recordado se conserva.
  useEffect(() => {
    const fix = staleStoredPrintPreference(raw);
    if (fix === undefined) return;
    if (fix === null) removeRaw(key);
    else writeRaw(key, fix);
  }, [key, raw]);
  const setDestination = useCallback(
    (destination: PrintDestination) => {
      writeRaw(key, serializePrintPreference({ destination }));
    },
    [key],
  );
  return { ...resolved, role, ready, setDestination };
}

export type PrintDestinationVariant = "op" | "pay" | "receipt";

const STYLES: Record<
  PrintDestinationVariant,
  { label: string; on: string; off: string; chip: string }
> = {
  // Panel del operador y app del mesero.
  // Mismos colores que «¿A qué datáfono?» (TerminalPicker).
  op: {
    label: "text-op-muted",
    on: "border-terracotta bg-terracotta text-bone font-medium",
    off: "border-op-border bg-op-bg text-op-text",
    chip: "min-h-9 px-3 rounded-full border text-xs",
  },
  // Pantallas con los colores del cobro (datáfono, "listo" del cobro).
  pay: {
    label: "text-muted",
    on: "border-terracotta bg-terracotta text-bone font-medium",
    off: "border-hairline bg-paper text-ink",
    chip: "min-h-9 px-3 rounded-full border text-xs",
  },
  // La vista imprimible (blanco y negro, monoespaciada).
  receipt: {
    label: "",
    on: "pd-on",
    off: "pd-off",
    chip: "pd-chip",
  },
};

/**
 * El selector: dos opciones de destino. Con «Este dispositivo» el papel es
 * siempre `DEVICE_PAPER_MM` (no se elige). Elegir no imprime: sólo cambia a
 * dónde va el próximo «Imprimir».
 */
export function PrintDestinationPicker({
  pref,
  disabled = false,
  variant = "op",
  className = "",
}: {
  pref: Pick<
    PrintPreferenceState,
    "destination" | "ready" | "setDestination"
  >;
  disabled?: boolean;
  variant?: PrintDestinationVariant;
  className?: string;
}) {
  const t = useTranslations("staffPrint");
  const destId = useId();
  const s = STYLES[variant];
  const chip = (checked: boolean) => `${s.chip} ${checked ? s.on : s.off} disabled:opacity-50`;
  // Mientras la sesión carga, nada marcado (todavía no se sabe qué vale).
  const isOn = (checked: boolean) => pref.ready && checked;
  const off = disabled || !pref.ready;
  const destinations: { value: PrintDestination; label: string }[] = [
    { value: "caja", label: t("destinationCaja") },
    { value: "device", label: t("destinationDevice") },
  ];
  return (
    <div className={`print-destination space-y-1.5 ${className}`}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span id={destId} className={`font-mono text-[10px] tracking-wider uppercase ${s.label}`}>
          {t("destinationLabel")}
        </span>
        <div role="radiogroup" aria-labelledby={destId} className="flex flex-wrap gap-1.5">
          {destinations.map((d) => (
            <button
              key={d.value}
              type="button"
              role="radio"
              aria-checked={isOn(pref.destination === d.value)}
              disabled={off}
              onClick={() => pref.setDestination(d.value)}
              className={chip(isOn(pref.destination === d.value))}
            >
              {d.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
