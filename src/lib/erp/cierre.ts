// Cierre de período y comprobantes numerados (port del patrón de zenith).
//
// Regla: los meses ABIERTOS se regeneran libremente (asientos-resumen
// idempotentes); al CERRAR un mes, sus comprobantes reciben número
// consecutivo por comercio y el mes queda con candado — el motor de
// generación lo rechaza. Reabrir levanta el candado (los números asignados
// se conservan; si el mes se regenera, el próximo cierre re-numera esos
// asientos con números nuevos de la secuencia — queda rastro en auditoría).
import { db } from "@/lib/db";
import { UVT_DEFAULT_CENTS } from "./retenciones";

export type AccountingConfigDto = {
  uvtCents: number;
  closedThrough: string | null;
  nextVoucherNumber: number;
};

/** Config contable del comercio, creándola perezosamente la primera vez. */
export async function getAccountingConfig(
  restaurantId: string,
): Promise<AccountingConfigDto> {
  const row = await db.accountingConfig.upsert({
    where: { restaurantId },
    create: { restaurantId, uvtCents: UVT_DEFAULT_CENTS },
    update: {},
    select: { uvtCents: true, closedThrough: true, nextVoucherNumber: true },
  });
  return row;
}

/** ¿El mes (YYYY-MM) está dentro del período cerrado? Comparación lexicográfica. */
export function isMonthClosed(
  closedThrough: string | null,
  month: string,
): boolean {
  return closedThrough != null && month <= closedThrough;
}

export type CloseResult =
  | { ok: true; numbered: number; closedThrough: string }
  | { ok: false; error: "already_closed" | "no_entries" | "invalid_month" };

/**
 * Cierra un mes: numera los comprobantes SIN número de todos los meses hasta
 * `month` (orden fecha → fuente) continuando la secuencia y fija el candado.
 * Idempotente sobre lo numerado: un asiento con número no se renumera.
 */
export async function closeMonth(
  restaurantId: string,
  month: string,
): Promise<CloseResult> {
  if (!/^\d{4}-\d{2}$/.test(month)) return { ok: false, error: "invalid_month" };
  const cfg = await getAccountingConfig(restaurantId);
  if (isMonthClosed(cfg.closedThrough, month)) {
    return { ok: false, error: "already_closed" };
  }

  // Fin de mes exclusivo: todo asiento con fecha < inicio del mes siguiente.
  const [y, m] = month.split("-").map(Number);
  const monthEnd = new Date(Date.UTC(y!, m!, 1));

  return db.$transaction(async (tx) => {
    const pending = await tx.journalEntry.findMany({
      where: {
        restaurantId,
        voucherNumber: null,
        date: { lt: monthEnd },
      },
      orderBy: [{ date: "asc" }, { source: "asc" }, { createdAt: "asc" }],
      select: { id: true },
    });
    let next = cfg.nextVoucherNumber;
    for (const e of pending) {
      await tx.journalEntry.update({
        where: { id: e.id },
        data: { voucherNumber: next++ },
      });
    }
    await tx.accountingConfig.update({
      where: { restaurantId },
      data: { closedThrough: month, nextVoucherNumber: next },
    });
    return { ok: true, numbered: pending.length, closedThrough: month };
  });
}

/** "YYYY-MM" → el mes anterior ("2026-01" → "2025-12"). */
function prevMonthOf(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y!, (m ?? 1) - 2, 1));
  return d.toISOString().slice(0, 7);
}

/**
 * Reabre el ÚLTIMO mes cerrado (el candado retrocede un mes). Los números de
 * comprobante ya asignados se conservan; si el mes reabierto se regenera,
 * el próximo cierre numera los asientos nuevos continuando la secuencia.
 */
export async function reopenLastMonth(
  restaurantId: string,
): Promise<{ ok: boolean; closedThrough: string | null }> {
  const cfg = await getAccountingConfig(restaurantId);
  if (!cfg.closedThrough) return { ok: false, closedThrough: null };
  const value = prevMonthOf(cfg.closedThrough);
  await db.accountingConfig.update({
    where: { restaurantId },
    data: { closedThrough: value },
  });
  return { ok: true, closedThrough: value };
}
