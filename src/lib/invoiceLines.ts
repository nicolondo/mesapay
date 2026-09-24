/**
 * AGRUPAR los artículos repetidos de una factura (o precuenta) para
 * mostrarla a una persona. Pura: sin DB, sin i18n.
 *
 * El dueño lo pidió textual: "en las facturas, cuando se imprima, agrupe
 * los artículos repetidos". Una mesa que pidió tres Bretañas en tres
 * rondas tiene tres `OrderItem`, y la tirilla decía tres veces
 * "1x Bretaña"; ahora dice "3x Bretaña" con el importe de las tres.
 *
 * DÓNDE se usa y dónde NO:
 *
 *   · SÍ en las representaciones para humanos: el ticket ESC/POS (tirilla
 *     y factura electrónica impresa, `print/invoiceDoc.ts`), la vista web
 *     `/factura/[id]`, el correo de la tirilla (`invoice.ts`, HTML y
 *     texto), la tirilla del datáfono (`payments/kushki/cloudPrint.ts`) y
 *     la precuenta (`prebill.ts`).
 *   · NUNCA en el XML de la DIAN (`dian/emit.ts` / `ubl.ts`): sigue
 *     saliendo una línea por ítem de la orden. Cada rechazo de la DIAN
 *     consume un consecutivo real, y la emisión no se toca por una
 *     cuestión de presentación. Tampoco se toca el snapshot guardado:
 *     se agrupa al LEER, así una factura vieja se imprime agrupada igual.
 *
 * Cuándo dos líneas son "el mismo artículo" (todas a la vez):
 *
 *   · misma referencia de plato: `menuItemId` si lo hay (una línea libre
 *     no lo tiene) Y el mismo nombre normalizado. Se exigen los dos a
 *     propósito: si el plato cambió de nombre en medio del servicio, una
 *     sola línea con uno de los dos nombres estaría mintiendo sobre la
 *     otra;
 *   · mismo precio UNITARIO al centavo (un plato que cambió de precio
 *     entre rondas son dos líneas: el papel no puede promediar);
 *   · mismo impuesto (`taxKind`/`taxPct`): un plato del menú (impuesto
 *     embebido) nunca se junta con una línea libre (impuesto encima);
 *   · mismos modificadores, sin importar el orden;
 *   · la misma nota. Una línea con nota distinta NO se agrupa: la nota es
 *     parte de lo que se pidió.
 *
 * Normalizar = recortar, colapsar espacios, NFC y minúsculas. Lo que se
 * MUESTRA es la primera aparición tal cual, no la versión normalizada.
 *
 * Los totales cuadran al centavo por construcción: el importe de un grupo
 * es la SUMA de qty × unitario de cada línea agrupada, que con el unitario
 * igual es exactamente (Σ qty) × unitario. Nada se redondea.
 */

/** Lo mínimo que tiene que traer una línea para poder agruparla. */
export type InvoiceLineInput = {
  qty: number;
  /** Nombre del plato tal como se muestra. */
  name: string;
  /** Precio UNITARIO en centavos. */
  priceCents: number;
  /** null/ausente = línea libre, o snapshot anterior a que se guardara. */
  menuItemId?: string | null;
  /** null = plato del menú (impuesto embebido del comercio). */
  taxKind?: string | null;
  taxPct?: number | null;
  /** Modificadores ya legibles ("Término: Medio"). El orden no importa. */
  modifiers?: readonly string[] | null;
  notes?: string | null;
};

/** Una línea agrupada: la primera aparición, con la cantidad y el importe sumados. */
export type GroupedInvoiceLine<T extends InvoiceLineInput = InvoiceLineInput> =
  T & {
    qty: number;
    /** Σ qty × unitario de las líneas agrupadas, en centavos. */
    totalCents: number;
  };

/** Recorta, colapsa espacios, NFC y minúsculas. */
function norm(s: string | null | undefined): string {
  return (s ?? "").normalize("NFC").replace(/\s+/g, " ").trim().toLocaleLowerCase("es");
}

/**
 * Un modificador normalizado. `formatItemSelections` arma
 * "Grupo: Opción A, Opción B" en el orden en que se tocaron las opciones,
 * así que se ordenan también las opciones de adentro: "Adición: Queso,
 * Tocineta" y "Adición: Tocineta, Queso" son lo mismo.
 */
function normModifier(m: string): string {
  const s = norm(m);
  const colon = s.indexOf(": ");
  if (colon < 0) return s;
  const group = s.slice(0, colon);
  const options = s
    .slice(colon + 2)
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o.length > 0)
    .sort();
  return `${group}: ${options.join(", ")}`;
}

/**
 * La clave de "mismo artículo" (ver el encabezado). Exportada para los
 * tests; los llamadores usan `groupInvoiceLines`.
 */
export function invoiceLineKey(line: InvoiceLineInput): string {
  const kind = line.taxKind ?? null;
  // El % sólo significa algo con un impuesto propio: "none" con un 8 suelto
  // y "none" con null son la misma línea sin impuesto.
  const pct = kind && kind !== "none" ? (line.taxPct ?? 0) : null;
  const modifiers = (line.modifiers ?? [])
    .map(normModifier)
    .filter((m) => m.length > 0)
    .sort();
  return JSON.stringify([
    line.menuItemId ?? null,
    norm(line.name),
    line.priceCents,
    kind,
    pct,
    modifiers,
    norm(line.notes),
  ]);
}

/**
 * Agrupa las líneas repetidas conservando el orden de PRIMERA aparición
 * (la cuenta se sigue leyendo como se fue pidiendo). No muta la entrada.
 */
export function groupInvoiceLines<T extends InvoiceLineInput>(
  lines: readonly T[],
): Array<GroupedInvoiceLine<T>> {
  const out: Array<GroupedInvoiceLine<T>> = [];
  const byKey = new Map<string, GroupedInvoiceLine<T>>();
  for (const line of lines) {
    const key = invoiceLineKey(line);
    const lineTotal = line.qty * line.priceCents;
    const seen = byKey.get(key);
    if (seen) {
      seen.qty += line.qty;
      seen.totalCents += lineTotal;
      continue;
    }
    const grouped: GroupedInvoiceLine<T> = {
      ...line,
      qty: line.qty,
      totalCents: lineTotal,
    };
    byKey.set(key, grouped);
    out.push(grouped);
  }
  return out;
}
