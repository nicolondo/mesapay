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
 *     impresora térmica integrada), al ANCHO DEL PAPEL DEL EQUIPO (55, 58,
 *     80 mm u otro), que no tiene por qué ser el de la caja.
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
 * EL PAPEL DEL EQUIPO es un número en mm (40–120), recordado por equipo,
 * con 55 · 58 · 80 como atajos y «Otro» para lo que haga falta: el ancho
 * que de verdad imprime un equipo se ajusta probando en el equipo, sin
 * esperar un despliegue. Arranca en:
 *   - 55 mm para el usuario Datáfono: el ancho que pidió el dueño para la
 *     tirilla en el Sunmi P3 de Kushki;
 *   - 58 mm para los demás: el rollo de los equipos móviles con impresora
 *     integrada (Sunmi P2/P3/V2, PAX, iMin…).
 * Sólo afecta a «Este dispositivo»: la impresora de caja (el agente) y su
 * respaldo siguen con el papel del comercio.
 *
 * Archivo sin React ni DOM: lo usan los botones y los tests.
 */

/**
 * Los destinos de «Imprimir en»:
 *   - `caja`: la impresora de caja, por el agente;
 *   - `terminal` («Datáfono»): la impresora integrada del datáfono Kushki
 *     del comercio, por su Print API cloud (`terminalPrint.ts`). Para todo
 *     el personal, sólo si el comercio tiene datáfonos Kushki;
 *   - `device` («Este dispositivo»): este navegador. Para el usuario
 *     Datáfono es su propio datáfono, por Kushki (#622): a él no se le
 *     muestra «Datáfono», que sería lo mismo (`printDestinationsFor`).
 */
export type PrintDestination = "caja" | "terminal" | "device";

/** Ancho del papel del equipo, en mm enteros (`DEVICE_PAPER_MIN_MM`–`MAX`). */
export type DevicePaperMm = number;

/** Atajos del selector de papel; cualquier otro entero del rango vale. */
export const DEVICE_PAPER_PRESETS: readonly DevicePaperMm[] = [55, 58, 80];

/**
 * El rango aceptado: el mismo que `fitPageToContent` acepta para declarar
 * la página (`paperWidthMmFrom`), así lo pedido y lo impreso coinciden.
 */
export const DEVICE_PAPER_MIN_MM = 40;
export const DEVICE_PAPER_MAX_MM = 120;

/** El papel de los equipos móviles con impresora integrada. */
export const DEFAULT_DEVICE_PAPER_MM: DevicePaperMm = 58;

/** El papel del Smart POS del usuario Datáfono (Sunmi P3 de Kushki). */
export const TERMINAL_DEVICE_PAPER_MM: DevicePaperMm = 55;

/** El papel de la primera vez en un equipo, según el rol. */
export function defaultDevicePaperMm(role: string | null | undefined): DevicePaperMm {
  return role === "terminal" ? TERMINAL_DEVICE_PAPER_MM : DEFAULT_DEVICE_PAPER_MM;
}

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
 * Qué destinos se ofrecen, en orden: «Impresora de caja · Datáfono · Este
 * dispositivo». «Datáfono» sólo con datáfonos Kushki y nunca al usuario
 * Datáfono (su «Este dispositivo» ya imprime en el datáfono).
 */
export function printDestinationsFor(
  role: string | null | undefined,
  terminalAvailable: boolean,
): PrintDestination[] {
  if (role === "terminal") return ["caja", "device"];
  return terminalAvailable ? ["caja", "terminal", "device"] : ["caja", "device"];
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
  return v === "caja" || v === "terminal" || v === "device";
}

export function isDevicePaperMm(v: unknown): v is DevicePaperMm {
  return (
    typeof v === "number" &&
    Number.isInteger(v) &&
    v >= DEVICE_PAPER_MIN_MM &&
    v <= DEVICE_PAPER_MAX_MM
  );
}

/**
 * Lo que alguien escribió en «Otro» (texto o número) → mm enteros dentro
 * del rango, o null si no sirve. Redondea ("57,5" → 58).
 */
export function parseDevicePaperMm(raw: unknown): DevicePaperMm | null {
  const n =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && /^\s*\d+([.,]\d+)?\s*$/.test(raw)
        ? Number(raw.trim().replace(",", "."))
        : NaN;
  if (!Number.isFinite(n)) return null;
  const mm = Math.round(n);
  return isDevicePaperMm(mm) ? mm : null;
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
  /** ¿El comercio tiene datáfonos Kushki? `undefined` = todavía no se sabe. */
  terminalAvailable?: boolean,
): PrintPreference & { remembered: boolean } {
  let destination = stored?.destination ?? defaultPrintDestination(role);
  // Para el usuario Datáfono, «Datáfono» es su «Este dispositivo».
  if (role === "terminal" && destination === "terminal") destination = "device";
  // Sin datáfonos Kushki no se puede mandar al datáfono: la caja.
  if (destination === "terminal" && terminalAvailable === false) destination = "caja";
  return {
    destination,
    paperMm: stored?.paperMm ?? defaultDevicePaperMm(role),
    remembered: !!stored?.destination,
  };
}

/** El otro destino (para «Reintentar en…»). */
export function otherDestination(d: PrintDestination): PrintDestination {
  return d === "caja" ? "device" : "caja";
}

/**
 * Parámetro con el que la vista imprimible recibe el ancho del papel DEL
 * EQUIPO (`/factura/[id]?w=55`). Sin él, la vista usa el papel del
 * comercio, como siempre.
 */
export const DEVICE_PAPER_PARAM = "w";

/**
 * `?w=` → mm enteros del rango (40–120); cualquier otra cosa, null (el papel
 * del comercio). Sólo dígitos: `?w=55mm` o `?w=5e1` no valen.
 */
export function devicePaperFromParam(raw: string | string[] | null | undefined): DevicePaperMm | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (typeof v !== "string" || !/^\d{2,3}$/.test(v)) return null;
  const mm = Number(v);
  return isDevicePaperMm(mm) ? mm : null;
}

/**
 * Relleno a cada lado de la tirilla, en mm, para un papel de `paperMm`. El
 * contenido apunta a ~48 mm, el ancho de un cabezal térmico de 384 puntos:
 * 58 → 5 mm (como siempre), 55 → 3,5 mm, 52 o menos → 2 mm (el mínimo,
 * para no pegar el texto al borde). 80 mm conserva sus 4 mm de siempre.
 */
export function receiptSidePaddingMm(paperMm: number): number {
  if (paperMm >= 80) return 4;
  return Math.max(2, Math.min(5, (paperMm - 48) / 2));
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
