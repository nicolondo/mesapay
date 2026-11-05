"use client";

import { useSyncExternalStore } from "react";

/** ¿La pantalla cumple la media query? (false en el servidor). */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const media = window.matchMedia(query);
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** Tabla de escritorio desde 1024 px; tarjetas en celular y tableta. */
export const DESKTOP_QUERY = "(min-width: 1024px)";
/** Opciones avanzadas en una columna al lado de la tabla desde 1440 px. */
export const WIDE_QUERY = "(min-width: 1440px)";
