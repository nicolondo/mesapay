// Consecutivo interno de gastos («G-0012»), por comercio.
//
// Por qué uno propio y no el de comprobantes: el número de comprobante
// (`JournalEntry.voucherNumber`) se asigna al CERRAR el mes y numera
// asientos —el motor junta todos los gastos de un día en UN asiento
// «Gastos del día»—, así que no identifica a un gasto ni existe mientras el
// mes está abierto. El del gasto nace con el gasto y lo acompaña en la
// lista, el detalle, el CSV, el Excel del contador, la cartera y los
// auxiliares de impuestos. Mismo formato que las órdenes de compra
// («OC-0007»).
//
// Reglas:
//  · Se asigna en la MISMA transacción del alta, con la fila del comercio
//    bloqueada (`FOR NO KEY UPDATE` sobre `Restaurant.expenseNextNumber`):
//    dos altas simultáneas se ordenan y no repiten ni dejan huecos (si la
//    transacción se cae, su número nunca existió).
//  · Nunca se reutiliza: el contador sólo crece. Borrar un gasto deja su
//    número quemado; restaurar una copia no lo baja (restore.ts lo trata
//    como columna monótona, igual que el consecutivo de facturas).
//  · Las plantillas recurrentes no son gastos: no llevan número. Sus copias
//    sí, cuando el cron las crea.
//  · Blue/green: mientras conviven, la versión vieja crea gastos con
//    `number` NULL (no conoce la columna). Cada asignación numera PRIMERO
//    esos pendientes, en orden de creación, y la lista los numera al
//    abrirse: nadie ve un gasto sin número por más de un momento.
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

export const EXPENSE_NUMBER_PREFIX = "G-";

/** 12 → «G-0012» (crece sin cortar: «G-12345»). null si no tiene número. */
export function formatExpenseNumber(n: number | null | undefined): string | null {
  if (n == null || !Number.isInteger(n) || n < 1) return null;
  return `${EXPENSE_NUMBER_PREFIX}${String(n).padStart(4, "0")}`;
}

/** Mayor entero que cabe en la columna (INTEGER de Postgres). */
const INT4_MAX = 2_147_483_647;

/**
 * Lo escrito en el buscador → consecutivo, si lo parece: «G-0012», «g12»,
 * «G 12», «#12». Sólo dígitos NO cuenta como consecutivo seguro (puede ser
 * un NIT o una factura del proveedor): eso lo decide quien busca.
 */
export function parseExpenseNumber(text: string): number | null {
  const m = /^\s*(?:g\s*-?\s*|#\s*)0*(\d{1,10})\s*$/i.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n >= 1 && n <= INT4_MAX ? n : null;
}

/** Sólo dígitos («12», «0012») → el número, o null. */
export function digitsAsNumber(text: string): number | null {
  const m = /^\s*0*(\d{1,10})\s*$/.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n >= 1 && n <= INT4_MAX ? n : null;
}

export type PendingExpense = { id: string; createdAt: Date };

/**
 * Pura: a qué gasto pendiente le toca qué número. Se arranca en el mayor
 * entre el contador y el mayor número ya asignado + 1 (un contador atrasado
 * —datos viejos, una copia restaurada por una versión anterior— nunca hace
 * chocar el índice único) y se reparte en orden de creación (empate: id).
 */
export function planExpenseNumbers(args: {
  nextNumber: number;
  maxAssigned: number | null;
  pending: readonly PendingExpense[];
}): { assignments: Array<{ id: string; number: number }>; nextNumber: number } {
  const start = Math.max(1, args.nextNumber, (args.maxAssigned ?? 0) + 1);
  const ordered = [...args.pending].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const assignments = ordered.map((p, i) => ({ id: p.id, number: start + i }));
  return { assignments, nextNumber: start + ordered.length };
}

type Tx = Prisma.TransactionClient;

/**
 * Numera los gastos sin número del comercio (los recién creados en esta
 * transacción y los que dejó la versión vieja del código). Debe correr
 * DENTRO de la transacción del alta: el candado sobre la fila del comercio
 * se suelta al confirmar. `FOR NO KEY UPDATE` (no `FOR UPDATE`) para no
 * frenar los INSERT de pedidos, pagos, etc. que sólo referencian al
 * comercio por llave foránea.
 *
 * Devuelve el número asignado a cada gasto (id → número).
 */
export async function numberPendingExpenses(tx: Tx, restaurantId: string): Promise<Map<string, number>> {
  const locked = await tx.$queryRaw<Array<{ expenseNextNumber: number }>>`
    SELECT "expenseNextNumber" FROM "Restaurant" WHERE "id" = ${restaurantId} FOR NO KEY UPDATE`;
  if (locked.length === 0) return new Map();
  // Después del candado: cada consulta ve lo que confirmó quien lo tenía antes.
  const pending = await tx.expense.findMany({
    where: { restaurantId, recurring: false, number: null },
    select: { id: true, createdAt: true },
  });
  if (pending.length === 0) return new Map();
  const max = await tx.expense.aggregate({ where: { restaurantId }, _max: { number: true } });
  const plan = planExpenseNumbers({
    nextNumber: locked[0]!.expenseNextNumber,
    maxAssigned: max._max.number,
    pending,
  });
  for (const a of plan.assignments) {
    await tx.expense.updateMany({ where: { id: a.id, number: null }, data: { number: a.number } });
  }
  // SQL directo: no tocar `Restaurant.updatedAt` por un contador.
  await tx.$executeRaw`UPDATE "Restaurant" SET "expenseNextNumber" = ${plan.nextNumber} WHERE "id" = ${restaurantId}`;
  return new Map(plan.assignments.map((a) => [a.id, a.number]));
}

/**
 * Para las lecturas (la lista): si quedó algún gasto sin número —creado por
 * la versión anterior durante un despliegue—, numerarlo ya. Lo normal es
 * que no haya ninguno y sea una sola consulta por índice.
 */
export async function ensureExpenseNumbers(restaurantId: string): Promise<void> {
  const pending = await db.expense.findFirst({
    where: { restaurantId, recurring: false, number: null },
    select: { id: true },
  });
  if (!pending) return;
  await db.$transaction((tx) => numberPendingExpenses(tx, restaurantId));
}

/**
 * Cómo citan los reportes a un gasto (auxiliares de impuestos, cartera):
 * el consecutivo y, si hay, el número del documento del proveedor —
 * «G-0012 · FE-1280»—. Sin consecutivo todavía, el documento o `fallback`.
 */
export function expenseDocumentLabel(
  e: { number?: number | null; documentNumber?: string | null },
  fallback: string,
): string {
  const parts = [formatExpenseNumber(e.number), e.documentNumber?.trim() || null].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : fallback;
}
