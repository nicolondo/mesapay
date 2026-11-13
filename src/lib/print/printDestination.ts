/**
 * ¿DÓNDE imprime el personal? «Impresora de caja» o «Este dispositivo».
 *
 * El dueño: «cuando es un usuario de cajero o de datáfono y se necesita
 * hacer una impresión quiero que haya la opción de imprimir en impresora de
 * caja o imprimir en el mismo dispositivo para cuando se están utilizando
 * dispositivos móviles con impresora integrada y que la última opción la
 * recuerde».
 *
 *   - `caja`: lo de siempre. La factura, la precuenta y el cierre de turno
 *     van al AGENTE de impresión (la térmica de la caja, como las
 *     comandas); sin impresora o con el agente caído, el respaldo de
 *     siempre: imprimir desde el navegador (ver `staffPrint.ts`).
 *   - `device`: ni se intenta el agente. La tirilla se imprime desde ESTE
 *     navegador, con el diálogo de impresión del sistema (en Android, el
 *     servicio de impresión del equipo; en el Sunmi P3 del datáfono, su
 *     impresora térmica integrada), al ANCHO DEL PAPEL DEL EQUIPO (58 u
 *     80 mm), que no tiene por qué ser el de la caja.
 *
 * QUIÉN elige: el personal que cobra o lleva la cuenta — operador (y los
 * admins que entran como operador), mesero y el usuario Datáfono, que son
 * `STAFF_PRINT_ROLES` (staffPrint.ts). «Cajero» no es un rol: es quien
 * cobra, y en MESAPAY eso es el operador o el mesero. Cocina y bar no: sus
 * comandas salen solas y no cambian.
 *
 * SE RECUERDA POR DISPOSITIVO y por comercio: en el almacenamiento local
 * del navegador (un celular puede trabajar en dos comercios del grupo, con
 * impresoras distintas). Si el almacenamiento no existe o tira (modo
 * privado, datos bloqueados), se imprime igual y la próxima vez se vuelve
 * al valor por defecto.
 *
 * POR DEFECTO, la primera vez en un equipo:
 *   - usuario Datáfono → `device`: es el Smart POS con la impresora
 *     integrada; mandar a la caja sería caminar hasta ella;
 *   - los demás → `caja`: es lo que hacía el botón hasta hoy, y si el
 *     comercio no tiene impresora de facturas en el agente el respaldo YA
 *     imprime desde este dispositivo, así que nadie se queda sin papel.
 * El papel del equipo arranca en 58 mm: es el de los equipos móviles con
 * impresora integrada (Sunmi P2/P3/V2, PAX, iMin…); 80 mm se elige una vez
 * y queda recordado.
 *
 * Archivo sin React ni DOM: lo usan los botones y los tests.
 */

export type PrintDestination = "caja" | "device";

/** Anchos de papel que se pueden elegir para «Este dispositivo». */
export const DEVICE_PAPER_WIDTHS = [58, 80] as const;
export type DevicePaperMm = (typeof DEVICE_PAPER_WIDTHS)[number];

/** El papel de los equipos móviles con impresora integrada. */
export const DEFAULT_DEVICE_PAPER_MM: DevicePaperMm = 58;

export type PrintPreference = {
  destination: PrintDestination;
  paperMm: DevicePaperMm;
};

/** Lo que quedó guardado en el equipo (puede faltar cualquiera de los dos). */
export type StoredPrintPreference = Partial<PrintPreference>;

/** El destino de la primera vez en un equipo (ver el encabezado). */
export function defaultPrintDestination(role: string | null | undefined): PrintDestination {
  return role === "terminal" ? "device" : "caja";
}

/**
 * Clave del almacenamiento local: por comercio. Sin comercio en la sesión
 * (un admin de plataforma o de grupo entrando a uno), una clave general.
 */
export function printPreferenceStorageKey(scope: string | null | undefined): string {
  const s = scope?.trim();
  return `mesapay.imprimir.${s ? s : "general"}`;
}

export function isPrintDestination(v: unknown): v is PrintDestination {
  return v === "caja" || v === "device";
}

export function isDevicePaperMm(v: unknown): v is DevicePaperMm {
  return v === 58 || v === 80;
}

/**
 * Lee lo guardado. Tolerante a todo: almacenamiento que no existe o tira,
 * JSON roto, valores de otra versión. Lo que no sirve se ignora.
 */
export function parseStoredPrintPreference(raw: string | null | undefined): StoredPrintPreference | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  const out: StoredPrintPreference = {};
  if (isPrintDestination(o.destination)) out.destination = o.destination;
  if (isDevicePaperMm(o.paperMm)) out.paperMm = o.paperMm;
  return out.destination || out.paperMm ? out : null;
}

type StorageLike = Pick<Storage, "getItem" | "setItem">;

export function readPrintPreference(
  storage: StorageLike | null | undefined,
  key: string,
): StoredPrintPreference | null {
  try {
    return parseStoredPrintPreference(storage?.getItem(key) ?? null);
  } catch {
    return null;
  }
}

/** Guarda la elección. Devuelve si quedó guardada (sin almacenamiento, no). */
export function writePrintPreference(
  storage: StorageLike | null | undefined,
  key: string,
  pref: PrintPreference,
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(key, serializePrintPreference(pref));
    return true;
  } catch {
    return false;
  }
}

export function serializePrintPreference(pref: PrintPreference): string {
  return JSON.stringify({ destination: pref.destination, paperMm: pref.paperMm });
}

/**
 * Lo que vale para este equipo: lo guardado y, lo que falte, el valor por
 * defecto del rol. `remembered` dice si el destino lo eligió alguien acá.
 */
export function resolvePrintPreference(
  stored: StoredPrintPreference | null | undefined,
  role: string | null | undefined,
): PrintPreference & { remembered: boolean } {
  return {
    destination: stored?.destination ?? defaultPrintDestination(role),
    paperMm: stored?.paperMm ?? DEFAULT_DEVICE_PAPER_MM,
    remembered: !!stored?.destination,
  };
}

/** El otro destino (para «Reintentar en…»). */
export function otherDestination(d: PrintDestination): PrintDestination {
  return d === "caja" ? "device" : "caja";
}

/**
 * Parámetro con el que la vista imprimible recibe el ancho del papel DEL
 * EQUIPO (`/factura/[id]?w=58`). Sin él, la vista usa el papel del
 * comercio, como siempre.
 */
export const DEVICE_PAPER_PARAM = "w";

/** `?w=` → 58 u 80; cualquier otra cosa, null (el papel del comercio). */
export function devicePaperFromParam(raw: string | string[] | null | undefined): DevicePaperMm | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (v === "58") return 58;
  if (v === "80") return 80;
  return null;
}

/**
 * Agrega (o reemplaza) un parámetro a una ruta de este mismo origen sin
 * tocar el resto de la consulta ni el ancla.
 */
export function withQueryParam(href: string, name: string, value: string): string {
  const hashAt = href.indexOf("#");
  const hash = hashAt >= 0 ? href.slice(hashAt) : "";
  const noHash = hashAt >= 0 ? href.slice(0, hashAt) : href;
  const qAt = noHash.indexOf("?");
  const path = qAt >= 0 ? noHash.slice(0, qAt) : noHash;
  const params = new URLSearchParams(qAt >= 0 ? noHash.slice(qAt + 1) : "");
  params.set(name, value);
  return `${path}?${params.toString()}${hash}`;
}

/** La vista imprimible al ancho del papel del equipo. */
export function devicePrintHref(href: string, paperMm: DevicePaperMm): string {
  return withQueryParam(href, DEVICE_PAPER_PARAM, String(paperMm));
}

/**
 * La guía de «Este dispositivo» en la ayuda, para quien puede abrirla: el
 * panel (operador y admins) o la app del mesero. El usuario Datáfono no
 * tiene ayuda: a él el aviso le dice el paso en una línea.
 */
export const DEVICE_PRINT_HELP_SLUG = "imprimir-en-este-dispositivo";
export const DEVICE_PRINT_HELP_CATEGORY = "impresion-y-equipos";

export function devicePrintHelpHref(role: string | null | undefined): string | null {
  if (!role || role === "terminal") return null;
  const base = role === "mesero" ? "/mesero/ayuda" : "/operator/ayuda";
  return `${base}/${DEVICE_PRINT_HELP_CATEGORY}/${DEVICE_PRINT_HELP_SLUG}`;
}
