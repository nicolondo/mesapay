"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";

/**
 * Devuelve el scroll al inicio cuando cambia la ruta, en los paneles cuyo
 * contenido scrollea dentro de un `<main>` propio (app-shell) y no en la
 * ventana.
 *
 * Next sólo reinicia el scroll de la VENTANA al navegar; el `<main>` del
 * shell vive en el layout, sobrevive a la navegación y conserva su
 * `scrollTop`. Resultado: salías de una pantalla larga con el scroll
 * abajo y la siguiente (Mesas, por ejemplo) «abría montada arriba», con
 * el título fuera de vista y los filtros a medio tapar (reporte del dueño
 * en la PWA).
 *
 * Con atrás/adelante del navegador se restaura la posición que tenía esa
 * ruta (como hace la ventana); con un enlace normal se va al inicio. Sólo
 * reacciona al pathname: cambiar filtros por query (`?f=…`) no mueve nada.
 */
export function ScrollerNavigationReset({ scrollerId }: { scrollerId: string }) {
  const pathname = usePathname();
  const positions = useRef(new Map<string, number>());
  const lastPath = useRef(pathname);
  const poppedTo = useRef<string | null>(null);

  useEffect(() => {
    // `popstate` llega antes de que Next cambie el pathname: se anota la
    // URL destino para saber que el próximo cambio es atrás/adelante.
    const onPop = () => {
      poppedTo.current = window.location.pathname;
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    const el = document.getElementById(scrollerId);
    if (!el) return;
    if (lastPath.current === pathname) return;
    positions.current.set(lastPath.current, el.scrollTop);
    const restoring = poppedTo.current === pathname;
    poppedTo.current = null;
    lastPath.current = pathname;
    el.scrollTop = restoring ? (positions.current.get(pathname) ?? 0) : 0;
  }, [pathname, scrollerId]);

  return null;
}
