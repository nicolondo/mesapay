// Decide si, al cargar las facturas del proveedor elegido, el foco debe
// saltar solo al campo «Valor a pagar». La regla: saltar siempre, salvo que
// el usuario ya esté escribiendo en OTRO campo del formulario (fecha, nota,
// referencia…). Venir del combobox de proveedor sí cuenta como "acabo de
// elegir proveedor", así que ahí el salto es bienvenido.
//
// Tipos estructurales mínimos para poder probarla sin DOM (vitest en node).

type NodeLike = { tagName: string };

const FORM_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

export function shouldAutofocusAmount({
  active,
  supplierBox,
  amountInput,
}: {
  /** `document.activeElement` en el momento en que llega el contexto. */
  active: NodeLike | null;
  /** Contenedor del combobox de proveedor (su input y su lista). */
  supplierBox: { contains(node: unknown): boolean } | null;
  /** El input del monto; si aún no está montado, no hay nada que enfocar. */
  amountInput: NodeLike | null;
}): boolean {
  if (!amountInput) return false;
  // Ya está en el monto: re-seleccionar el contenido propuesto está bien.
  if (active === amountInput) return true;
  // Foco en el body o en un botón: no le quitamos nada a nadie.
  if (!active || !FORM_TAGS.has(active.tagName)) return true;
  // Está en un campo: solo robamos el foco si ese campo es el combobox de
  // proveedor (el flujo normal de "elegí proveedor → escribo el valor").
  return supplierBox?.contains(active) ?? false;
}
