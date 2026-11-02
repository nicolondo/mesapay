// Platos agotados para el aviso al abrir el turno (Cierre → «Abrir turno»).
//
// En la carta «agotado» es simplemente `MenuItem.available = false`: no hay
// un «agotado hasta mañana» ni un reseteo automático al cambiar de día, y
// «archivar» (o borrar un plato con ventas) apaga el mismo campo. Por eso el
// aviso lista TODO lo que hoy no se ofrece y el operador decide qué vuelve.
// Funciones puras: la ruta las usa para ordenar y el diálogo para agrupar.

export type SoldOutItem = {
  id: string;
  name: string;
  /** Etiqueta de la categoría; «Padre › Hija» si es una subcategoría. */
  categoryName: string;
  /**
   * ISO. Aproximado: es la última edición del plato, que normalmente es el
   * momento en que se marcó agotado (no hay columna propia para eso).
   */
  soldOutSince: string;
};

/** Fila mínima que devuelve Prisma para armar la lista. */
export type SoldOutRow = {
  id: string;
  name: string;
  sortOrder: number;
  updatedAt: Date;
  category: {
    label: string;
    sortOrder: number;
    parent: { label: string; sortOrder: number } | null;
  };
};

export type SoldOutGroup = { categoryName: string; items: SoldOutItem[] };

const SUBCATEGORY_SEPARATOR = " › ";

/**
 * Ordena como la carta (categoría padre, subcategoría, plato) y proyecta al
 * contrato de la API. El nombre del plato desempata los `sortOrder` iguales
 * para que la lista no cambie de orden entre una carga y otra.
 */
export function toSoldOutItems(rows: SoldOutRow[]): SoldOutItem[] {
  const collate = (a: string, b: string) => a.localeCompare(b, "es");
  const topOf = (r: SoldOutRow) => r.category.parent ?? r.category;
  const subOrder = (r: SoldOutRow) => (r.category.parent ? r.category.sortOrder : -1);
  return [...rows]
    .sort(
      (a, b) =>
        topOf(a).sortOrder - topOf(b).sortOrder ||
        collate(topOf(a).label, topOf(b).label) ||
        subOrder(a) - subOrder(b) ||
        collate(a.category.label, b.category.label) ||
        a.sortOrder - b.sortOrder ||
        collate(a.name, b.name),
    )
    .map((r) => ({
      id: r.id,
      name: r.name,
      categoryName: r.category.parent
        ? `${r.category.parent.label}${SUBCATEGORY_SEPARATOR}${r.category.label}`
        : r.category.label,
      soldOutSince: r.updatedAt.toISOString(),
    }));
}

/** Agrupa por categoría conservando el orden en que llegan los platos. */
export function groupSoldOutByCategory(items: SoldOutItem[]): SoldOutGroup[] {
  const groups: SoldOutGroup[] = [];
  const byName = new Map<string, SoldOutGroup>();
  for (const item of items) {
    let group = byName.get(item.categoryName);
    if (!group) {
      group = { categoryName: item.categoryName, items: [] };
      byName.set(item.categoryName, group);
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups;
}

/** Días enteros transcurridos desde `iso` (nunca negativo). */
export function daysSince(iso: string, now: number = Date.now()): number {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((now - t) / 86_400_000));
}
