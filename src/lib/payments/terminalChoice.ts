/**
 * A qué datáfono Kushki mandar un cobro. Los datáfonos son del COMERCIO
 * (cualquier mesero cobra con cualquiera), así que se elige al cobrar:
 *
 *   - uno solo disponible → ése, sin preguntar;
 *   - dos o más → "¿A qué datáfono?". Cada aparato (el navegador del celular
 *     o la tablet) recuerda el último que eligió y lo deja preseleccionado;
 *     se cambia con un toque. Sin uno recordado (o si ya no está), no se
 *     adivina: hay que elegir.
 *
 * Antes el cobro iba al datáfono "asignado" al mesero, y Salón usaba siempre
 * el primero de la lista: con dos equipos, el cobro podía llegar al
 * equivocado.
 *
 * Archivo sin dependencias de servidor ni de React: lo usan las pantallas y
 * los tests.
 */

export type TerminalChoiceDevice = { id: string; label: string };

/** Clave de localStorage: por comercio (un celular puede cobrar en varios). */
export function terminalChoiceStorageKey(tenantSlug: string): string {
  return `mesapay.datafono.${tenantSlug}`;
}

/** El datáfono al que va el cobro, o null si hay que elegir (o no hay ninguno). */
export function resolveTerminalChoice<D extends TerminalChoiceDevice>(
  devices: readonly D[],
  rememberedId: string | null | undefined,
): D | null {
  if (devices.length === 1) return devices[0];
  if (!rememberedId) return null;
  return devices.find((d) => d.id === rememberedId) ?? null;
}

/** ¿Hay que mostrar "¿A qué datáfono?"? Sólo con dos o más. */
export function needsTerminalPicker(devices: readonly TerminalChoiceDevice[]): boolean {
  return devices.length >= 2;
}

type StorageLike = Pick<Storage, "getItem" | "setItem">;

/**
 * El último datáfono elegido en este aparato. localStorage puede no existir
 * o tirar (modo privado, datos bloqueados): entonces no hay recuerdo.
 */
export function readRememberedTerminal(storage: StorageLike | null | undefined, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** Recuerda el elegido. Si no se puede guardar, igual se cobra. */
export function rememberTerminal(storage: StorageLike | null | undefined, key: string, deviceId: string): void {
  try {
    storage?.setItem(key, deviceId);
  } catch {
    // Sin almacenamiento: la próxima vez se vuelve a elegir.
  }
}
