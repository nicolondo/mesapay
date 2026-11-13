// Eliminar un insumo DE VERDAD (no archivarlo) — la regla y la operación.
//
// Un insumo solo se puede eliminar si NADA en el sistema lo referencia, ni
// como historia ni como dependencia viva. Esta es la única fuente de esa
// regla: la usan la API (individual y masiva) y las pantallas (Insumos e
// Inventario), siempre a través de `ingredientDeletionChecks`.
//
// Clasificación de CADA relación de `Ingredient` en prisma/schema.prisma:
//
//   HISTORIA → bloquea
//     StockMovement            cualquier movimiento (entrada, ajuste, merma,
//                              conteo, consumo por venta, producción)
//     StockLevel ≠ 0           «tiene existencias» (cantidad o valor)
//     PurchaseOrderItem        líneas de órdenes NO borrador (enviadas,
//                              recibidas, anuladas) — por el insumo o por una
//                              de sus presentaciones de proveedor
//     SupplierPriceHistory     historial de precios de sus presentaciones
//     StockCountItem (cerrado) líneas de conteos cerrados
//     ProductionBatch          lotes de producción del elaborado
//
//   DEPENDENCIA VIVA → bloquea, diciendo cuál
//     RecipeItem               línea de la receta de un plato o sub-receta
//     ModifierRecipeItem       insumo de una opción de modificador
//     Recipe (IngredientRecipe) el insumo ES una sub-receta con líneas
//     PurchaseOrderItem        líneas de órdenes en BORRADOR (dice cuáles)
//     StockCountItem (borrador) está en el conteo abierto (dice cuál)
//
//   CONFIGURACIÓN → se va con el insumo (ON DELETE CASCADE)
//     IngredientBarcode        sus códigos de barras (quedan libres)
//     SupplierIngredient       presentaciones en listas de precios, sin
//                              órdenes ni historial de precios
//     SupplierInvoiceAlias     nombres de factura recordados
//     StockLevel en cero       la fila del saldo, sin cantidad ni valor
//     Recipe vacía             una sub-receta sin líneas (no debería existir)
//     reorderPointBase/…       columnas del propio insumo
//
// No hay más referencias: gastos, asientos, platos y traducciones no
// apuntan a insumos, y la extracción de una factura por revisar guarda
// textos, no ids (la coincidencia se recalcula al abrirla).
//
// OJO: movimientos, líneas de conteo, saldo y sub-receta cuelgan del insumo
// con ON DELETE CASCADE — la base los borraría en silencio. Por eso la
// eliminación vuelve a revisar la regla DENTRO de la transacción, con el
// candado de inventario y la fila del insumo bloqueada (ver
// `deleteIngredientsPermanently`).

import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { lockStock } from "@/lib/orderLock";
import { recordAuditEvent } from "@/lib/auditLog";

type Client = Prisma.TransactionClient;

/** Motivos de la regla, en el orden en que se le cuentan a la persona. */
export const INGREDIENT_DELETION_REASONS = [
  "stock",
  "movements",
  "purchases",
  "draftPurchases",
  "production",
  "closedCounts",
  "draftCount",
  "recipes",
  "modifierRecipes",
  "ownRecipe",
  "priceHistory",
] as const;

export type IngredientDeletionRuleCode = (typeof INGREDIENT_DELETION_REASONS)[number];
/** `busy` no es de la regla: otra operación tiene el insumo tomado ahora mismo. */
export type IngredientDeletionReasonCode = IngredientDeletionRuleCode | "busy";

export type IngredientDeletionReason = {
  code: IngredientDeletionReasonCode;
  count: number;
  /**
   * Cuáles, cuando ayuda a destrabarlo (hasta MAX_REASON_LABELS): nombres de
   * las recetas, número de la orden en borrador, fecha ISO del conteo abierto.
   */
  labels?: string[];
};

/** Lo que se va con el insumo. */
export type IngredientDeletionRemoves = {
  barcodes: number;
  supplierItems: number;
  invoiceAliases: number;
};

export type IngredientDeletionCheck =
  | { deletable: true; removes: IngredientDeletionRemoves }
  | { deletable: false; reasons: IngredientDeletionReason[] };

export const MAX_REASON_LABELS = 3;
/** Tope de ids por consulta (los `IN (…)` van como parámetros). */
const CHUNK = 2000;

type Tally = Partial<Record<IngredientDeletionRuleCode, { count: number; labels: Set<string> }>>;

function bump(tallies: Map<string, Tally>, id: string, code: IngredientDeletionRuleCode, by: number, label?: string | null) {
  const tally = tallies.get(id);
  if (!tally) return;
  const entry = (tally[code] ??= { count: 0, labels: new Set<string>() });
  entry.count += by;
  if (label) entry.labels.add(label);
}

async function checkChunk(client: Client, restaurantId: string, ids: string[], out: Map<string, IngredientDeletionCheck>) {
  const owned = (await client.ingredient.findMany({
    where: { restaurantId, id: { in: ids } },
    select: { id: true },
  })).map((row) => row.id);
  if (owned.length === 0) return;
  const inIds = { in: owned };
  const tallies = new Map<string, Tally>(owned.map((id) => [id, {}]));
  const removes = new Map<string, IngredientDeletionRemoves>(
    owned.map((id) => [id, { barcodes: 0, supplierItems: 0, invoiceAliases: 0 }]),
  );

  // Las consultas no dependen entre sí: van a la vez (la lista de Insumos
  // revisa todos los insumos sin saldo al abrir la página). Los hijos se
  // buscan SOLO por el insumo, sin filtrar por comercio: lo que importa es
  // qué arrastraría (o qué frenaría) el borrado de esa fila.
  const [
    stocked, movements, orderLines, draftLines, supplierItems, batches,
    closedCountLines, draftCountLines, recipeLines, modifierLines, ownRecipes, barcodes, aliases,
  ] = await Promise.all([
    client.stockLevel.findMany({
      where: { ingredientId: inIds, OR: [{ qtyBase: { not: 0 } }, { totalValueCents: { not: 0 } }] },
      select: { ingredientId: true },
    }),
    client.stockMovement.groupBy({ by: ["ingredientId"], where: { ingredientId: inIds }, _count: { _all: true } }),
    client.purchaseOrderItem.groupBy({
      by: ["ingredientId", "purchaseOrderId"],
      where: { ingredientId: inIds, purchaseOrder: { status: { not: "draft" } } },
      _count: { _all: true },
    }),
    client.purchaseOrderItem.findMany({
      where: { ingredientId: inIds, purchaseOrder: { status: "draft" } },
      select: { ingredientId: true, purchaseOrder: { select: { id: true, number: true } } },
    }),
    client.supplierIngredient.findMany({ where: { ingredientId: inIds }, select: { id: true, ingredientId: true } }),
    client.productionBatch.groupBy({ by: ["outputIngredientId"], where: { outputIngredientId: inIds }, _count: { _all: true } }),
    // Conteos: cualquier estado que no sea borrador es un documento cerrado.
    client.stockCountItem.groupBy({
      by: ["ingredientId"],
      where: { ingredientId: inIds, count: { status: { not: "draft" } } },
      _count: { _all: true },
    }),
    client.stockCountItem.findMany({
      where: { ingredientId: inIds, count: { status: "draft" } },
      select: { ingredientId: true, count: { select: { createdAt: true } } },
    }),
    client.recipeItem.findMany({
      where: { ingredientId: inIds },
      select: {
        ingredientId: true,
        recipe: { select: { menuItem: { select: { name: true } }, outputIngredient: { select: { name: true } } } },
      },
      orderBy: { id: "asc" },
    }),
    client.modifierRecipeItem.findMany({
      where: { ingredientId: inIds },
      select: { ingredientId: true, optLabel: true, recipe: { select: { menuItem: { select: { name: true } } } } },
      orderBy: { id: "asc" },
    }),
    client.recipe.findMany({
      where: { outputIngredientId: inIds },
      select: { outputIngredientId: true, items: { select: { id: true } }, modifierItems: { select: { id: true } } },
    }),
    client.ingredientBarcode.groupBy({ by: ["ingredientId"], where: { ingredientId: inIds }, _count: { _all: true } }),
    client.supplierInvoiceAlias.groupBy({ by: ["ingredientId"], where: { ingredientId: inIds }, _count: { _all: true } }),
  ]);

  // Presentaciones de proveedor: configuración, salvo que ya tengan órdenes
  // o historial de precios. Una línea de orden normal ya se cuenta por su
  // insumo; acá entran las que cuelgan de la presentación con OTRO insumo
  // (borrar la presentación les dejaría el vínculo en null).
  const itemIds = { in: supplierItems.map((item) => item.id) };
  const [itemOrderLines, priceHistory] = supplierItems.length === 0 ? [[], []] : await Promise.all([
    client.purchaseOrderItem.groupBy({
      by: ["supplierItemId", "ingredientId", "purchaseOrderId"],
      where: { supplierItemId: itemIds },
      _count: { _all: true },
    }),
    client.supplierPriceHistory.groupBy({ by: ["supplierItemId"], where: { supplierItemId: itemIds }, _count: { _all: true } }),
  ]);

  for (const row of stocked) bump(tallies, row.ingredientId, "stock", 1);
  for (const row of movements) bump(tallies, row.ingredientId, "movements", row._count._all);

  // Compras: se cuentan ÓRDENES distintas, no líneas.
  const orders = new Map<string, Set<string>>();
  const addOrder = (id: string, orderId: string) => {
    if (!tallies.has(id)) return;
    const set = orders.get(id) ?? new Set<string>();
    set.add(orderId);
    orders.set(id, set);
  };
  for (const row of orderLines) addOrder(row.ingredientId, row.purchaseOrderId);
  const itemOwner = new Map(supplierItems.map((item) => [item.id, item.ingredientId]));
  for (const row of itemOrderLines) {
    const owner = row.supplierItemId ? itemOwner.get(row.supplierItemId) : undefined;
    if (owner && owner !== row.ingredientId) addOrder(owner, row.purchaseOrderId);
  }
  for (const [id, set] of orders) bump(tallies, id, "purchases", set.size);

  const draftOrders = new Map<string, Map<string, number>>();
  for (const row of draftLines) {
    const map = draftOrders.get(row.ingredientId) ?? new Map<string, number>();
    map.set(row.purchaseOrder.id, row.purchaseOrder.number);
    draftOrders.set(row.ingredientId, map);
  }
  for (const [id, map] of draftOrders) {
    const numbers = [...map.values()].sort((a, b) => a - b);
    for (const number of numbers) bump(tallies, id, "draftPurchases", 1, String(number));
  }

  for (const item of supplierItems) {
    const entry = removes.get(item.ingredientId);
    if (entry) entry.supplierItems++;
  }
  for (const row of priceHistory) {
    const owner = itemOwner.get(row.supplierItemId);
    if (owner) bump(tallies, owner, "priceHistory", row._count._all);
  }

  for (const row of batches) bump(tallies, row.outputIngredientId, "production", row._count._all);
  for (const row of closedCountLines) bump(tallies, row.ingredientId, "closedCounts", row._count._all);
  for (const row of draftCountLines) bump(tallies, row.ingredientId, "draftCount", 1, row.count.createdAt.toISOString());
  for (const row of recipeLines) {
    bump(tallies, row.ingredientId, "recipes", 1, row.recipe.menuItem?.name ?? row.recipe.outputIngredient?.name);
  }
  for (const row of modifierLines) {
    const dish = row.recipe.menuItem?.name;
    bump(tallies, row.ingredientId, "modifierRecipes", 1, dish ? `${dish} · ${row.optLabel}` : row.optLabel);
  }
  // El insumo ES una sub-receta. Con líneas es una dependencia viva (se
  // borra primero la sub-receta); vacía no dice nada y se va con él.
  for (const row of ownRecipes) {
    const lines = row.items.length + row.modifierItems.length;
    if (row.outputIngredientId && lines > 0) bump(tallies, row.outputIngredientId, "ownRecipe", lines);
  }

  for (const row of barcodes) {
    const entry = removes.get(row.ingredientId);
    if (entry) entry.barcodes = row._count._all;
  }
  for (const row of aliases) {
    const entry = removes.get(row.ingredientId);
    if (entry) entry.invoiceAliases = row._count._all;
  }

  for (const id of owned) {
    const tally = tallies.get(id)!;
    const reasons: IngredientDeletionReason[] = [];
    for (const code of INGREDIENT_DELETION_REASONS) {
      const entry = tally[code];
      if (!entry || entry.count <= 0) continue;
      const labels = [...entry.labels].slice(0, MAX_REASON_LABELS);
      reasons.push(labels.length > 0 ? { code, count: entry.count, labels } : { code, count: entry.count });
    }
    out.set(id, reasons.length > 0 ? { deletable: false, reasons } : { deletable: true, removes: removes.get(id)! });
  }
}

/**
 * La regla para varios insumos a la vez (tres tandas de consultas, sin
 * importar cuántos sean). Los ids que no son de este comercio no salen en
 * el mapa: quien llama los trata como «no existe».
 */
export async function ingredientDeletionChecks(
  client: Client,
  restaurantId: string,
  ids: string[],
): Promise<Map<string, IngredientDeletionCheck>> {
  const out = new Map<string, IngredientDeletionCheck>();
  const unique = [...new Set(ids)];
  for (let start = 0; start < unique.length; start += CHUNK) {
    await checkChunk(client, restaurantId, unique.slice(start, start + CHUNK), out);
  }
  return out;
}

/** La regla para un insumo. `null` = no existe en este comercio. */
export async function ingredientDeletionCheck(
  client: Client,
  restaurantId: string,
  id: string,
): Promise<IngredientDeletionCheck | null> {
  return (await ingredientDeletionChecks(client, restaurantId, [id])).get(id) ?? null;
}

/**
 * ¿Cuáles insumos del comercio se pueden eliminar? Para pintar «Eliminar» y
 * el filtro «Sin movimientos» de la lista de Insumos. Un saldo distinto de
 * cero ya lo descarta, así que solo se revisan los que no tienen
 * existencias: los que mueven inventario todos los días ni se consultan.
 * No depende de otras consultas de la página: corre en paralelo con ellas.
 */
export async function deletableIngredientIds(client: Client, restaurantId: string): Promise<string[]> {
  const candidates = (await client.ingredient.findMany({
    where: { restaurantId, OR: [{ stockLevel: null }, { stockLevel: { qtyBase: 0, totalValueCents: 0 } }] },
    select: { id: true },
  })).map((row) => row.id);
  if (candidates.length === 0) return [];
  const checks = await ingredientDeletionChecks(client, restaurantId, candidates);
  return candidates.filter((id) => checks.get(id)?.deletable === true);
}

export type IngredientDeletionPreview = {
  deletable: { id: string; name: string }[];
  skipped: SkippedIngredient[];
  missing: string[];
};

/**
 * Qué pasaría al eliminar estos insumos, SIN tocar nada: cuáles se irían y
 * cuáles no, con sus motivos. La eliminación masiva lo muestra antes de
 * pedir la confirmación (y al confirmar la regla se vuelve a revisar).
 */
export async function previewIngredientDeletion(
  client: Client,
  restaurantId: string,
  ids: string[],
): Promise<IngredientDeletionPreview> {
  const requested = [...new Set(ids)];
  const checks = await ingredientDeletionChecks(client, restaurantId, requested);
  const rows = await client.ingredient.findMany({
    where: { restaurantId, id: { in: [...checks.keys()] } },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
  const preview: IngredientDeletionPreview = { deletable: [], skipped: [], missing: [] };
  const seen = new Set<string>();
  for (const row of rows) {
    const check = checks.get(row.id);
    if (!check) continue;
    seen.add(row.id);
    if (check.deletable) preview.deletable.push({ id: row.id, name: row.name });
    else preview.skipped.push({ id: row.id, name: row.name, reasons: check.reasons });
  }
  preview.missing = requested.filter((id) => !seen.has(id));
  return preview;
}

export type DeletedIngredient = {
  id: string;
  name: string;
  category: string | null;
  measureKind: string;
  sku: string | null;
  active: boolean;
  barcodes: string[];
  removes: IngredientDeletionRemoves;
};
export type SkippedIngredient = { id: string; name: string; reasons: IngredientDeletionReason[] };
export type IngredientDeletionResult = {
  deleted: DeletedIngredient[];
  /** Existen, pero no se eliminaron: con sus motivos. */
  skipped: SkippedIngredient[];
  /** Ids que no son de este comercio (o ya no existen). */
  missing: string[];
};

/**
 * Elimina, dentro de una transacción, los insumos que la regla permite y
 * devuelve cuáles quedaron y por qué.
 *
 * 1. Toma el candado de inventario del comercio: el mismo de movimientos,
 *    conteos, producción, recetas, listas de precios y códigos de barras.
 *    Si alguno está a mitad de camino, se espera a que termine.
 * 2. Bloquea las filas de los insumos (FOR UPDATE). Insertar un hijo que
 *    apunte a un insumo necesita esa fila (FOR KEY SHARE), así que mientras
 *    dure la transacción NADIE puede referenciarlos, use o no el candado.
 *    SKIP LOCKED: si otra operación ya tiene tomado un insumo, no se espera
 *    por ella (evita abrazos mortales con quien luego pide el candado); ese
 *    insumo se salta con el motivo `busy`.
 * 3. Revisa la regla con las filas ya bloqueadas y borra solo los que pasan.
 */
export async function deleteIngredientsPermanently(
  tx: Client,
  restaurantId: string,
  ids: string[],
): Promise<IngredientDeletionResult> {
  const requested = [...new Set(ids)];
  await lockStock(tx, restaurantId);

  const owned = await tx.ingredient.findMany({
    where: { restaurantId, id: { in: requested } },
    select: { id: true, name: true },
  });
  const ownedIds = new Set(owned.map((row) => row.id));
  const missing = requested.filter((id) => !ownedIds.has(id));
  if (owned.length === 0) return { deleted: [], skipped: [], missing };

  const locked = new Set((await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Ingredient"
    WHERE "restaurantId" = ${restaurantId} AND "id" IN (${Prisma.join([...ownedIds])})
    ORDER BY "id"
    FOR UPDATE SKIP LOCKED
  `).map((row) => row.id));

  const skipped: SkippedIngredient[] = owned
    .filter((row) => !locked.has(row.id))
    .map((row) => ({ id: row.id, name: row.name, reasons: [{ code: "busy" as const, count: 1 }] }));
  if (locked.size === 0) return { deleted: [], skipped, missing };

  // Con las filas bloqueadas: datos para la auditoría y la regla, frescos.
  const rows = await tx.ingredient.findMany({
    where: { restaurantId, id: { in: [...locked] } },
    select: {
      id: true, name: true, category: true, measureKind: true, sku: true, active: true, barcode: true,
      barcodes: { select: { barcode: true }, orderBy: { barcode: "asc" } },
    },
    orderBy: { name: "asc" },
  });
  const checks = await ingredientDeletionChecks(tx, restaurantId, rows.map((row) => row.id));

  const deleted: DeletedIngredient[] = [];
  for (const row of rows) {
    const check = checks.get(row.id);
    if (!check) {
      missing.push(row.id);
    } else if (!check.deletable) {
      skipped.push({ id: row.id, name: row.name, reasons: check.reasons });
    } else {
      deleted.push({
        id: row.id, name: row.name, category: row.category, measureKind: row.measureKind, sku: row.sku, active: row.active,
        barcodes: [...new Set([...(row.barcode ? [row.barcode] : []), ...row.barcodes.map((entry) => entry.barcode)])],
        removes: check.removes,
      });
    }
  }
  if (deleted.length > 0) {
    const result = await tx.ingredient.deleteMany({
      where: { restaurantId, id: { in: deleted.map((row) => row.id) } },
    });
    // Si la cuenta no cuadra, algo cambió bajo nuestros pies: se deshace todo.
    if (result.count !== deleted.length) throw new IngredientDeletionConflict();
  }
  skipped.sort((a, b) => a.name.localeCompare(b.name));
  return { deleted, skipped, missing };
}

export class IngredientDeletionConflict extends Error {
  constructor() {
    super("ingredient_deletion_conflict");
  }
}

/** Choques de concurrencia: candado no disponible, abrazo mortal o una
 *  referencia (FK) que apareció a último momento. Nada se borró. */
function isConcurrencyConflict(error: unknown): boolean {
  if (error instanceof IngredientDeletionConflict) return true;
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2003" || error.code === "P2034" || error.code === "P2028") return true;
    const code = (error.meta as { code?: unknown } | undefined)?.code;
    if (error.code === "P2010" && typeof code === "string" && ["40P01", "40001", "55P03", "23503"].includes(code)) return true;
  }
  return error instanceof Error && /deadlock detected|could not obtain lock|could not serialize access/i.test(error.message);
}

/**
 * La operación completa para las rutas: transacción + auditoría. Devuelve
 * `{ error: "conflict" }` si chocó con otra operación (nada se borró; se
 * puede reintentar).
 */
export async function runIngredientDeletion(
  restaurantId: string,
  ids: string[],
): Promise<IngredientDeletionResult | { error: "conflict" }> {
  let result: IngredientDeletionResult;
  try {
    result = await db.$transaction((tx) => deleteIngredientsPermanently(tx, restaurantId, ids), {
      maxWait: 10_000,
      timeout: 60_000,
    });
  } catch (error) {
    if (isConcurrencyConflict(error)) return { error: "conflict" };
    throw error;
  }
  // Uno por insumo, en fila: un borrado masivo no debe agotar el pool.
  for (const row of result.deleted) {
    await recordAuditEvent({
      kind: "ingredient.delete",
      restaurantId,
      target: { type: "ingredient", id: row.id },
      summary: row.name,
      diff: {
        before: {
          name: row.name,
          category: row.category,
          measureKind: row.measureKind,
          sku: row.sku,
          active: row.active,
          barcodes: row.barcodes,
          supplierItems: row.removes.supplierItems,
          invoiceAliases: row.removes.invoiceAliases,
        },
      },
    });
  }
  return result;
}
