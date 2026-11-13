"use client";

import { useCallback, useId, useMemo, useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";
import { useSession } from "next-auth/react";
import {
  DEVICE_PAPER_WIDTHS,
  parseStoredPrintPreference,
  printPreferenceStorageKey,
  resolvePrintPreference,
  serializePrintPreference,
  type DevicePaperMm,
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
  setDestination: (destination: PrintDestination) => void;
  setPaperMm: (paperMm: DevicePaperMm) => void;
};

/**
 * La preferencia de impresión de este equipo. El rol y el comercio salen de
 * la sesión (o de `override`, si la pantalla ya los sabe). En el servidor y
 * en el primer pintado no hay recuerdo (no se desarma la hidratación): se
 * muestra el valor por defecto del rol y enseguida el guardado.
 */
export function usePrintPreference(
  override: { role?: string | null; scope?: string | null } = {},
): PrintPreferenceState {
  const { data } = useSession();
  const role = override.role !== undefined ? override.role : (data?.user?.role ?? null);
  const scope = override.scope !== undefined ? override.scope : (data?.user?.restaurantId ?? null);
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
  const setDestination = useCallback(
    (destination: PrintDestination) => {
      writeRaw(key, serializePrintPreference({ destination, paperMm: resolved.paperMm }));
    },
    [key, resolved.paperMm],
  );
  const setPaperMm = useCallback(
    (paperMm: DevicePaperMm) => {
      writeRaw(key, serializePrintPreference({ destination: resolved.destination, paperMm }));
    },
    [key, resolved.destination],
  );
  return { ...resolved, role, setDestination, setPaperMm };
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
 * El selector: dos opciones de destino y, con «Este dispositivo», el ancho
 * del papel del equipo. Elegir no imprime: sólo cambia a dónde va el
 * próximo «Imprimir».
 */
export function PrintDestinationPicker({
  pref,
  disabled = false,
  variant = "op",
  className = "",
}: {
  pref: Pick<PrintPreferenceState, "destination" | "paperMm" | "setDestination" | "setPaperMm">;
  disabled?: boolean;
  variant?: PrintDestinationVariant;
  className?: string;
}) {
  const t = useTranslations("staffPrint");
  const destId = useId();
  const paperId = useId();
  const s = STYLES[variant];
  const chip = (checked: boolean) => `${s.chip} ${checked ? s.on : s.off} disabled:opacity-50`;
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
              aria-checked={pref.destination === d.value}
              disabled={disabled}
              onClick={() => pref.setDestination(d.value)}
              className={chip(pref.destination === d.value)}
            >
              {d.label}
            </button>
          ))}
        </div>
      </div>
      {pref.destination === "device" && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span id={paperId} className={`font-mono text-[10px] tracking-wider uppercase ${s.label}`}>
            {t("paperLabel")}
          </span>
          <div role="radiogroup" aria-labelledby={paperId} className="flex flex-wrap gap-1.5">
            {DEVICE_PAPER_WIDTHS.map((mm) => (
              <button
                key={mm}
                type="button"
                role="radio"
                aria-checked={pref.paperMm === mm}
                disabled={disabled}
                onClick={() => pref.setPaperMm(mm)}
                className={chip(pref.paperMm === mm)}
              >
                {t("paperMm", { mm })}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
