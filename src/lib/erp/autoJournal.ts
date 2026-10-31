// Generación automática de los asientos-resumen (motor de posting.ts).
//
// Antes los asientos sólo existían si alguien tocaba «Generar / actualizar
// asientos» en Contabilidad → Diario, mes por mes. Ahora la corrida diaria
// (cron accounting-daily, 05:30 hora de Colombia) regenera todos los meses
// ABIERTOS con actividad, y el botón queda para "actualizar ya".
//
// Las dos vías comparten tres piezas de este archivo:
//   - `regenerateMonth`: lo que hacía la ruta del botón (rango del mes con
//     `monthRange`, candado de cierre y `generateJournalForMonth`), sin
//     inventar otro cálculo de rango.
//   - `withJournalLock`: advisory lock de Postgres por comercio, para que el
//     botón, la corrida diaria y el cierre de mes no se pisen.
//   - `ENGINE_SOURCES`: las fuentes que arma el motor (y sólo esas).
//
// Idempotencia y lo que NO se toca: el motor borra y recrea por
// `(source, sourceRef = "YYYY-MM")` de SUS fuentes; los comprobantes
// manuales (`source = "manual"`, sourceRef aleatorio) nunca caen en ese
// filtro. Los meses cerrados (`AccountingConfig.closedThrough`) no se
// regeneran.
import { db } from "@/lib/db";
import { monthRange } from "./accounting";
import { startMonth } from "./activos";
import { getAccountingConfig, isMonthClosed } from "./cierre";
import { isMonth, nextMonthOf } from "./cierrePeriodo";
import { ENGINE_SOURCES } from "./engineCodes";
import { type GenResult, generateJournalForMonth } from "./posting";

/**
 * Fuentes de los asientos-resumen que arma `buildMonthEntries` (posting.ts).
 * Viven en engineCodes.ts para que el motor también las use (borra las que
 * el mes ya no produce) sin importar este archivo.
 */
export { ENGINE_SOURCES };

// ── Lock por comercio ───────────────────────────────────────────────────────

/**
 * Segunda llave del advisory lock `(hashtext(restaurantId), 949)`. Las otras
 * clases en uso: 42 (mesas), 731 (pedidos), 733 (factura manual), 735
 * (pickup), 917 (bonos), 947 (notas crédito / borrado / restauración), 948
 * (fijar notas crédito en el mes). En el SQL va como literal (igual que las
 * demás): como parámetro Prisma lo mandaría como bigint y Postgres no
 * encuentra `pg_try_advisory_xact_lock(integer, bigint)`.
 */
export const JOURNAL_LOCK_CLASS = 949;

/** Espera del botón manual y del cierre de mes antes de responder "busy". */
export const MANUAL_LOCK_WAIT_MS = 20_000;
/** Espera de la corrida diaria por comercio (cubre un botón en curso). */
export const DAILY_LOCK_WAIT_MS = 15_000;
/** Tope de un mes suelto (botón) con el lock tomado. */
export const MANUAL_LOCK_HOLD_MS = 2 * 60_000;
/** Tope de todos los meses abiertos de un comercio con el lock tomado. */
export const DAILY_LOCK_HOLD_MS = 10 * 60_000;

const POLL_MS = 250;

export type LockResult<T> = { ok: true; value: T } | { ok: false; reason: "busy" };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Corre `fn` con el lock contable del comercio tomado. El lock es de
 * transacción (`pg_try_advisory_xact_lock`): vive en una transacción que
 * sólo lo sostiene —el trabajo va por `db`, porque el motor abre sus propias
 * transacciones— y se suelta solo al terminar, falle o no `fn`.
 *
 * Sin espera (`waitMs` 0) devuelve `busy` si otro lo tiene; con espera,
 * reintenta cada 250 ms hasta `waitMs`. `holdMs` es el tope de la
 * transacción que sostiene el lock.
 */
export async function withJournalLock<T>(
  restaurantId: string,
  fn: () => Promise<T>,
  opts: { waitMs?: number; holdMs?: number } = {},
): Promise<LockResult<T>> {
  const waitMs = Math.max(0, opts.waitMs ?? 0);
  const holdMs = opts.holdMs ?? MANUAL_LOCK_HOLD_MS;
  return db.$transaction(
    async (tx): Promise<LockResult<T>> => {
      const deadline = Date.now() + waitMs;
      for (;;) {
        const rows = await tx.$queryRaw<Array<{ locked: boolean }>>`SELECT pg_try_advisory_xact_lock(hashtext(${restaurantId}), 949) AS locked`;
        if (rows[0]?.locked) break;
        if (Date.now() >= deadline) return { ok: false, reason: "busy" };
        await sleep(POLL_MS);
      }
      return { ok: true, value: await fn() };
    },
    { maxWait: 10_000, timeout: waitMs + holdMs },
  );
}

// ── Un mes ──────────────────────────────────────────────────────────────────

export type MonthOutcome =
  | { month: string; status: "ok"; results: GenResult[] }
  | { month: string; status: "closed" }
  | { month: string; status: "invalid" }
  /** Mes abierto con asientos del motor numerados o anulados (reabierto). */
  | { month: string; status: "numbered" }
  | { month: string; status: "error"; error: string };

/**
 * Regenera los asientos-resumen de un mes: el mismo paso que la ruta del
 * botón (rango con `monthRange`, candado de cierre, motor). No toma el lock
 * — lo toma quien llama — y no atrapa errores.
 */
export async function regenerateMonth(
  restaurantId: string,
  month: string,
  closedThrough: string | null,
): Promise<
  | { month: string; status: "ok"; results: GenResult[] }
  | { month: string; status: "closed" }
  | { month: string; status: "invalid" }
> {
  const range = monthRange(month);
  if (!range) return { month, status: "invalid" };
  // Candado de cierre: un mes cerrado tiene comprobantes numerados en firme.
  if (isMonthClosed(closedThrough, month)) return { month, status: "closed" };
  const results = await generateJournalForMonth(restaurantId, month, range);
  return { month, status: "ok", results };
}

// ── Qué meses ───────────────────────────────────────────────────────────────

/** "YYYY-MM" (UTC) de una fecha — la misma convención que el motor. */
export function monthOfDate(date: Date): string {
  return date.toISOString().slice(0, 7);
}

/** Primer mes que acepta `monthRange` (años < 2020 son inválidos). */
const MIN_MONTH = "2020-01";

/**
 * Meses a regenerar: desde el primer mes con actividad contable (o el mes
 * siguiente al último cerrado, si es posterior) hasta el mes en curso,
 * todos seguidos — un mes sin movimientos igual puede tener depreciación,
 * diferidos o nómina. Sin actividad, ninguno.
 *
 * El cierre de MESAPAY es un candado de prefijo (`closedThrough`: cerrado
 * todo mes <= ese), así que los cerrados siempre quedan al comienzo.
 */
export function openMonthsToRegenerate(input: {
  firstActivityMonth: string | null;
  closedThrough: string | null;
  currentMonth: string;
}): string[] {
  const { firstActivityMonth, closedThrough, currentMonth } = input;
  if (!isMonth(firstActivityMonth) || !isMonth(currentMonth)) return [];
  let start = firstActivityMonth < MIN_MONTH ? MIN_MONTH : firstActivityMonth;
  if (isMonth(closedThrough) && start <= closedThrough) start = nextMonthOf(closedThrough);
  const months: string[] = [];
  for (let m = start; m <= currentMonth; m = nextMonthOf(m)) months.push(m);
  return months;
}

/**
 * Primer mes con algo que el motor asienta: cobros, compras recibidas,
 * abonos a proveedores, gastos y sus pagos, abonos de clientes, consumo y
 * mermas de inventario, nóminas liquidadas, depreciación (mes siguiente a la
 * compra del activo) y diferidos. Las devoluciones y notas crédito cuelgan
 * de un cobro, que ya cuenta. `null` si el comercio no tiene nada.
 *
 * MESAPAY no guarda una "fecha de inicio contable": el piso lo pone el
 * cierre (`closedThrough`).
 */
export async function firstActivityMonth(restaurantId: string): Promise<string | null> {
  const where = { restaurantId };
  const [
    orders,
    purchases,
    purchasePays,
    expenses,
    expensePays,
    customerPays,
    stock,
    payroll,
    assets,
    deferred,
  ] = await Promise.all([
    db.order.aggregate({ where: { ...where, paidAt: { not: null } }, _min: { paidAt: true } }),
    db.purchaseOrder.aggregate({
      where: { ...where, receivedAt: { not: null } },
      _min: { receivedAt: true },
    }),
    db.purchasePayment.aggregate({ where, _min: { paidAt: true } }),
    // Las plantillas recurrentes no son gasto (igual que el motor).
    db.expense.aggregate({ where: { ...where, recurring: false }, _min: { date: true } }),
    db.expensePayment.aggregate({ where, _min: { paidAt: true } }),
    db.customerCreditPayment.aggregate({ where, _min: { paidAt: true } }),
    db.stockMovement.aggregate({
      where: { ...where, kind: { in: ["sale_consumption", "waste"] } },
      _min: { createdAt: true },
    }),
    db.payrollRun.aggregate({ where, _min: { month: true } }),
    db.fixedAsset.aggregate({ where, _min: { purchaseDate: true } }),
    db.deferredItem.aggregate({ where, _min: { startDate: true } }),
  ]);
  const dates: Array<Date | null | undefined> = [
    orders._min.paidAt,
    purchases._min.receivedAt,
    purchasePays._min.paidAt,
    expenses._min.date,
    expensePays._min.paidAt,
    customerPays._min.paidAt,
    stock._min.createdAt,
    deferred._min.startDate,
  ];
  const months = dates.filter((d): d is Date => d instanceof Date).map(monthOfDate);
  if (isMonth(payroll._min.month)) months.push(payroll._min.month);
  if (assets._min.purchaseDate) months.push(startMonth(assets._min.purchaseDate));
  if (months.length === 0) return null;
  return months.reduce((a, b) => (b < a ? b : a));
}

/**
 * Meses (de `months`) con asientos del motor ya numerados o anulados: un mes
 * que se cerró y después se reabrió. Regenerarlo borra esos comprobantes (y
 * resucita los anulados por reversa), así que la corrida automática no lo
 * hace — queda para el botón, que es una decisión de alguien.
 */
async function monthsWithNumberedEngineEntries(
  restaurantId: string,
  months: string[],
): Promise<Set<string>> {
  if (months.length === 0) return new Set();
  const rows = await db.journalEntry.findMany({
    where: {
      restaurantId,
      source: { in: [...ENGINE_SOURCES] },
      sourceRef: { in: months },
      OR: [{ voucherNumber: { not: null } }, { annulledAt: { not: null } }],
    },
    select: { sourceRef: true },
    distinct: ["sourceRef"],
  });
  return new Set(rows.map((r) => r.sourceRef).filter((m): m is string => m != null));
}

// ── Todos los meses abiertos de un comercio ─────────────────────────────────

export type OpenMonthsRun =
  | { restaurantId: string; status: "busy"; months: [] }
  | {
      restaurantId: string;
      status: "done";
      firstActivityMonth: string | null;
      closedThrough: string | null;
      months: MonthOutcome[];
    };

/**
 * Regenera los asientos-resumen de todos los meses abiertos con actividad
 * del comercio, con el lock contable tomado. Si un mes falla, se loguea y
 * sigue con el siguiente. Devuelve el resultado por mes.
 */
export async function regenerateOpenMonths(
  restaurantId: string,
  now: Date = new Date(),
  opts: { waitMs?: number } = {},
): Promise<OpenMonthsRun> {
  const locked = await withJournalLock(
    restaurantId,
    async () => {
      // Dentro del lock: el cierre también lo toma, así que `closedThrough`
      // no avanza mientras corremos (reabrir sólo lo retrocede, inofensivo).
      const [cfg, first] = await Promise.all([
        getAccountingConfig(restaurantId),
        firstActivityMonth(restaurantId),
      ]);
      const months = openMonthsToRegenerate({
        firstActivityMonth: first,
        closedThrough: cfg.closedThrough,
        currentMonth: monthOfDate(now),
      });
      const numbered = await monthsWithNumberedEngineEntries(restaurantId, months);
      const out: MonthOutcome[] = [];
      for (const month of months) {
        if (numbered.has(month)) {
          out.push({ month, status: "numbered" });
          continue;
        }
        try {
          out.push(await regenerateMonth(restaurantId, month, cfg.closedThrough));
        } catch (error) {
          const message = (error instanceof Error ? error.message : String(error)).slice(0, 300);
          console.error("[autoJournal] el mes falló", { restaurantId, month, error: message });
          out.push({ month, status: "error", error: message });
        }
      }
      return { firstActivityMonth: first, closedThrough: cfg.closedThrough, months: out };
    },
    { waitMs: opts.waitMs ?? 0, holdMs: DAILY_LOCK_HOLD_MS },
  );
  if (!locked.ok) return { restaurantId, status: "busy", months: [] };
  return { restaurantId, status: "done", ...locked.value };
}

// ── Para la pantalla ────────────────────────────────────────────────────────

/**
 * Cuándo se actualizaron por última vez los asientos del motor del mes: el
 * `createdAt` más reciente (el motor borra y recrea, así que es la última
 * corrida que dejó algo). `null` si el mes no tiene asientos del motor.
 */
export async function lastEngineUpdateAt(
  restaurantId: string,
  month: string,
): Promise<Date | null> {
  const agg = await db.journalEntry.aggregate({
    where: { restaurantId, sourceRef: month, source: { in: [...ENGINE_SOURCES] } },
    _max: { createdAt: true },
  });
  return agg._max.createdAt ?? null;
}
