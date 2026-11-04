/**
 * Estado del DESPLIEGUE de un reporte en la URL (lógica pura): qué renglones
 * están abiertos, como lista separada por comas en `?abrir=` (p. ej.
 * `?abrir=inc,inc-ventas-8`). Así el enlace se comparte con lo desplegado,
 * el botón «atrás» deshace el último despliegue y la página del servidor
 * sabe qué imprimir abierto.
 *
 * Reglas: ids de letras, dígitos, `_`, `.` y `-` (hasta 80); sin repetidos;
 * como mucho `MAX_OPEN` (lo que sobre se descarta: una URL manipulada no
 * debe obligar a cargar cientos de auxiliares). Se serializa ORDENADO para
 * que el mismo estado sea siempre la misma URL.
 */
export const OPEN_PARAM = "abrir";
export const MAX_OPEN = 40;

const ID_RE = /^[A-Za-z0-9_.-]{1,80}$/;

export function isDrillId(id: string): boolean {
  return ID_RE.test(id);
}

/** `?abrir=` crudo → conjunto de ids válidos. */
export function parseOpen(raw: string | null | undefined): Set<string> {
  const out = new Set<string>();
  if (!raw) return out;
  for (const part of raw.split(",")) {
    const id = part.trim();
    if (!isDrillId(id)) continue;
    out.add(id);
    if (out.size >= MAX_OPEN) break;
  }
  return out;
}

/** Conjunto → valor de `?abrir=` (null = nada abierto: se quita el parámetro). */
export function serializeOpen(open: ReadonlySet<string>): string | null {
  const ids = [...open].filter(isDrillId).sort().slice(0, MAX_OPEN);
  return ids.length ? ids.join(",") : null;
}

/** Abre o cierra un renglón. Al cerrar, cierra también sus descendientes (`id-…`). */
export function toggleOpen(open: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(open);
  if (next.has(id)) {
    for (const k of next) if (k === id || k.startsWith(`${id}-`)) next.delete(k);
  } else if (isDrillId(id)) {
    next.add(id);
  }
  return next;
}

/** Abre varios renglones a la vez (p. ej. un impuesto y su desglose desde una alerta). */
export function openAll(open: ReadonlySet<string>, ids: readonly string[]): Set<string> {
  const next = new Set(open);
  for (const id of ids) if (isDrillId(id)) next.add(id);
  return next;
}

/**
 * Query string con `abrir` actualizado y el resto intacto. Las comas de la
 * lista van tal cual (`?abrir=inc,inc-ventas-8`, no `%2C`): los ids sólo
 * llevan caracteres seguros y la URL queda legible al compartirla.
 */
export function withOpen(search: string, open: ReadonlySet<string>, param = OPEN_PARAM): string {
  const sp = new URLSearchParams(search);
  sp.delete(param);
  const raw = serializeOpen(open);
  const rest = sp.toString();
  const s = [rest, raw ? `${encodeURIComponent(param)}=${raw}` : ""].filter(Boolean).join("&");
  return s ? `?${s}` : "";
}
