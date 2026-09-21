"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { resolveActiveHref } from "@/lib/operatorNav";
import type { NavEntry } from "./OperatorMobileMenu";

/**
 * Ítem activo de la nav para la URL actual (ruta + `?tab=`, porque las
 * pestañas de contabilidad tienen ítem propio). `locationKey` cambia con
 * cualquiera de las dos — sirve para "cerrar el menú al navegar" también
 * cuando sólo cambió la pestaña.
 *
 * `useSearchParams` no necesita Suspense acá: todo /operator es dinámico
 * (el layout lee cookies y sesión), nunca se prerenderiza.
 */
export function useActiveNav(items: readonly NavEntry[]): {
  activeHref: string | null;
  locationKey: string;
} {
  const pathname = usePathname();
  const tab = useSearchParams().get("tab");
  return {
    activeHref: resolveActiveHref(items, { pathname, tab }),
    locationKey: `${pathname ?? ""}?${tab ?? ""}`,
  };
}
