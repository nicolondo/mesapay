/**
 * ÚNICA capa con base de datos de los reportes contables. Devuelve datos
 * crudos con la forma que esperan las funciones puras (`trialBalance.ts`,
 * `generalLedger.ts`, `dailyBook.ts`); no calcula nada.
 *
 * Solo LECTURA del libro: `JournalEntry` / `JournalLine` / `LedgerAccount`.
 *
 * ── Estado de los asientos: NO se filtra ─────────────────────────────────
 * La anulación es por REVERSA (como en zenith): el original pasa a
 * `status = "annulled"` pero SUS LÍNEAS SIGUEN VIGENTES en el libro, y se
 * crea un asiento `manual` con las líneas invertidas que las netea. Los
 * dos tienen que sumar en balance, mayor y diario: si se descartara el
 * anulado, la reversa quedaría sola y se restaría dos veces. El único
 * estado que podría excluirse sería un futuro «borrador», que hoy no
 * existe. Las vistas marcan los anulados con `status` (ver `isAnnulled`).
 *
 * Todas las fechas son límites UTC (`from` inclusivo, `to` EXCLUSIVO), ver
 * `period.ts`. Las consultas van parametrizadas (`Prisma.sql`), nunca por
 * interpolación de strings.
 */
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import type { BalanceInput } from "./balanceSheet";
import type { DailyBookEntryInput } from "./dailyBook";
import type { LedgerLineInput } from "./generalLedger";
import type { ResultMovement } from "./incomeStatement";
import { isoDateUtc } from "./period";
import type { TrialBalanceDbRow } from "./trialBalance";

export type ReportAccount = {
  code: string;
  name: string;
  type: string;
  nature: string;
  postable: boolean;
  active: boolean;
};

/**
 * Plan de cuentas completo (inactivas incluidas: una cuenta desactivada
 * puede conservar saldo histórico y necesita su nombre en el reporte).
 */
export async function loadReportAccounts(restaurantId: string): Promise<ReportAccount[]> {
  return db.ledgerAccount.findMany({
    where: { restaurantId },
    select: { code: true, name: true, type: true, nature: true, postable: true, active: true },
    orderBy: { code: "asc" },
  });
}

type RawTrialRow = {
  accountCode: string;
  initialCents: bigint | number;
  debitCents: bigint | number;
  creditCents: bigint | number;
  finalCents: bigint | number;
};

/**
 * Una consulta agrupada por cuenta con saldos FIRMADOS (débito − crédito):
 * saldo inicial (fecha < from), débitos y créditos del rango, saldo final
 * (fecha < to). Postgres devuelve `bigint` en los SUM: se convierte a
 * Number (los centavos de un comercio caben de sobra en 2^53).
 *
 * Sin filtro por `status`: un asiento anulado por reversa conserva sus
 * líneas y la reversa las netea, así que ambos deben sumar (ver cabecera).
 */
export async function loadTrialBalanceRows(
  restaurantId: string,
  from: Date,
  to: Date,
): Promise<TrialBalanceDbRow[]> {
  const rows = await db.$queryRaw<RawTrialRow[]>(Prisma.sql`
    SELECT
      l."accountCode" AS "accountCode",
      COALESCE(SUM(CASE WHEN e."date" < ${from} THEN l."debitCents" - l."creditCents" ELSE 0 END), 0) AS "initialCents",
      COALESCE(SUM(CASE WHEN e."date" >= ${from} THEN l."debitCents" ELSE 0 END), 0) AS "debitCents",
      COALESCE(SUM(CASE WHEN e."date" >= ${from} THEN l."creditCents" ELSE 0 END), 0) AS "creditCents",
      COALESCE(SUM(l."debitCents" - l."creditCents"), 0) AS "finalCents"
    FROM "JournalLine" l
    JOIN "JournalEntry" e ON e."id" = l."entryId"
    WHERE e."restaurantId" = ${restaurantId}
      AND e."date" < ${to}
    GROUP BY l."accountCode"
    ORDER BY l."accountCode"
  `);
  return rows.map((r) => ({
    accountCode: r.accountCode,
    initialCents: Number(r.initialCents),
    debitCents: Number(r.debitCents),
    creditCents: Number(r.creditCents),
    finalCents: Number(r.finalCents),
  }));
}

/** Tamaño de lote de las lecturas paginadas por cursor. */
const BATCH = 2000;

/**
 * Líneas del libro con fecha < `to` (el mayor necesita TODO lo anterior
 * para el saldo inicial), con los datos del asiento. Paginado por cursor
 * `id` para no traer un año entero de golpe; el orden lo pone la función
 * pura. Hoy el volumen es chico (asientos-resumen mensuales); si los
 * asientos manuales crecen, el saldo inicial debería pasar a un SUM en
 * SQL como en `loadTrialBalanceRows`.
 *
 * Sin filtro por `status`: el anulado por reversa y su reversa suman los
 * dos (ver cabecera); `status` viaja para que la vista lo marque.
 */
export async function loadLedgerLines(
  restaurantId: string,
  to: Date,
  accountCode?: string | null,
): Promise<LedgerLineInput[]> {
  const out: LedgerLineInput[] = [];
  let cursor: string | undefined;
  for (;;) {
    const batch = await db.journalLine.findMany({
      where: {
        ...(accountCode ? { accountCode } : {}),
        entry: { restaurantId, date: { lt: to } },
      },
      select: {
        id: true,
        entryId: true,
        accountCode: true,
        debitCents: true,
        creditCents: true,
        memo: true,
        entry: {
          select: {
            date: true,
            voucherNumber: true,
            source: true,
            memo: true,
            status: true,
            createdAt: true,
          },
        },
      },
      orderBy: { id: "asc" },
      take: BATCH,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    for (const l of batch) {
      out.push({
        id: l.id,
        entryId: l.entryId,
        date: l.entry.date,
        voucherNumber: l.entry.voucherNumber,
        source: l.entry.source,
        memo: l.entry.memo,
        status: l.entry.status,
        createdAt: l.entry.createdAt,
        accountCode: l.accountCode,
        debitCents: l.debitCents,
        creditCents: l.creditCents,
        lineMemo: l.memo,
      });
    }
    if (batch.length < BATCH) break;
    cursor = batch[batch.length - 1]!.id;
  }
  return out;
}

/**
 * Comprobantes del rango con sus líneas y el nombre de cada cuenta. Sin
 * filtro por `status` (ver cabecera): el diario lista el anulado marcado
 * y su reversa, y ambos entran en los totales.
 */
export async function loadEntriesWithLines(
  restaurantId: string,
  from: Date,
  to: Date,
): Promise<DailyBookEntryInput[]> {
  const out: DailyBookEntryInput[] = [];
  let cursor: string | undefined;
  for (;;) {
    const batch = await db.journalEntry.findMany({
      where: { restaurantId, date: { gte: from, lt: to } },
      select: {
        id: true,
        date: true,
        voucherNumber: true,
        source: true,
        memo: true,
        status: true,
        createdAt: true,
        lines: {
          select: {
            accountCode: true,
            debitCents: true,
            creditCents: true,
            memo: true,
            account: { select: { name: true } },
          },
        },
      },
      orderBy: { id: "asc" },
      take: BATCH,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    for (const e of batch) {
      out.push({
        id: e.id,
        date: e.date,
        voucherNumber: e.voucherNumber,
        source: e.source,
        memo: e.memo,
        status: e.status,
        createdAt: e.createdAt,
        lines: e.lines.map((l) => ({
          accountCode: l.accountCode,
          accountName: l.account.name,
          debitCents: l.debitCents,
          creditCents: l.creditCents,
          memo: l.memo,
        })),
      });
    }
    if (batch.length < BATCH) break;
    cursor = batch[batch.length - 1]!.id;
  }
  return out;
}

type RawBalanceRow = { accountCode: string; balanceCents: bigint | number };

/**
 * Saldo ACUMULADO firmado (Σ débito − crédito) por cuenta con fecha < `to`
 * (`to` = 00:00Z del día siguiente al corte, ver `period.ts`), para el
 * estado de situación financiera. Todos los estados y TODOS los orígenes,
 * cierre incluido: tras un cierre las 4/5/6 quedan en cero y la utilidad
 * vive en 3605/3610, que es lo que un balance a esa fecha debe mostrar.
 */
export async function loadBalancesThrough(
  restaurantId: string,
  to: Date,
): Promise<BalanceInput[]> {
  const rows = await db.$queryRaw<RawBalanceRow[]>(Prisma.sql`
    SELECT
      l."accountCode" AS "accountCode",
      COALESCE(SUM(l."debitCents" - l."creditCents"), 0) AS "balanceCents"
    FROM "JournalLine" l
    JOIN "JournalEntry" e ON e."id" = l."entryId"
    WHERE e."restaurantId" = ${restaurantId}
      AND e."date" < ${to}
    GROUP BY l."accountCode"
    ORDER BY l."accountCode"
  `);
  return rows.map((r) => ({ accountCode: r.accountCode, balanceCents: Number(r.balanceCents) }));
}

type RawMovementRow = { accountCode: string; month: string; movementCents: bigint | number };

/**
 * Movimiento firmado (Σ débito − crédito) por cuenta y MES (`yyyy-mm`,
 * UTC) de las cuentas de resultado (ingreso / costo / gasto) y del
 * patrimonio `38*` (otro resultado integral) en el rango, para el estado
 * de resultado. El resto del patrimonio no entra: no es resultado.
 *
 * Se EXCLUYEN los asientos de cierre (`source = 'closing'`) y sus reversas
 * (`reversalOfId` → un cierre): el cierre no es un hecho económico, es la
 * reclasificación al patrimonio, y con él dentro el estado daría cero. Los
 * demás anulados y sus reversas sí entran (se netean entre sí).
 */
export async function loadResultMovements(
  restaurantId: string,
  from: Date,
  to: Date,
): Promise<ResultMovement[]> {
  const rows = await db.$queryRaw<RawMovementRow[]>(Prisma.sql`
    SELECT
      l."accountCode" AS "accountCode",
      to_char(e."date", 'YYYY-MM') AS "month",
      COALESCE(SUM(l."debitCents" - l."creditCents"), 0) AS "movementCents"
    FROM "JournalLine" l
    JOIN "JournalEntry" e ON e."id" = l."entryId"
    JOIN "LedgerAccount" a ON a."id" = l."accountId"
    WHERE e."restaurantId" = ${restaurantId}
      AND e."date" >= ${from}
      AND e."date" < ${to}
      AND (
        a."type"::text IN ('ingreso', 'costo', 'gasto')
        OR (a."type"::text = 'patrimonio' AND l."accountCode" LIKE '38%')
      )
      AND e."source" <> 'closing'
      AND NOT EXISTS (
        SELECT 1 FROM "JournalEntry" c
        WHERE c."id" = e."reversalOfId" AND c."source" = 'closing'
      )
    GROUP BY l."accountCode", to_char(e."date", 'YYYY-MM')
    ORDER BY l."accountCode", 2
  `);
  return rows.map((r) => ({
    accountCode: r.accountCode,
    month: r.month,
    movementCents: Number(r.movementCents),
  }));
}

/**
 * Fechas (`yyyy-mm-dd`, UTC) de los asientos de cierre VIGENTES del
 * comercio, ascendentes. Un cierre anulado por reversa no cuenta: sus
 * líneas quedaron neteadas y la utilidad de ese año sigue «al vuelo».
 */
export async function loadClosingDates(restaurantId: string): Promise<string[]> {
  const rows = await db.journalEntry.findMany({
    where: { restaurantId, source: "closing", status: "posted" },
    select: { date: true },
    orderBy: { date: "asc" },
  });
  return rows.map((r) => isoDateUtc(r.date));
}

/** Años (UTC) con al menos un asiento, descendentes (selector de ejercicio). */
export async function loadEntryYears(restaurantId: string): Promise<number[]> {
  const rows = await db.$queryRaw<{ year: number }[]>(Prisma.sql`
    SELECT DISTINCT EXTRACT(YEAR FROM e."date")::int AS "year"
    FROM "JournalEntry" e
    WHERE e."restaurantId" = ${restaurantId}
    ORDER BY "year" DESC
  `);
  return rows.map((r) => Number(r.year));
}

/** Datos del comercio para el encabezado legal impreso. */
export async function loadReportBusiness(restaurantId: string): Promise<{
  name: string;
  legalName: string | null;
  taxId: string | null;
  country: string | null;
}> {
  const r = await db.restaurant.findUniqueOrThrow({
    where: { id: restaurantId },
    select: { name: true, legalName: true, taxId: true, country: true },
  });
  return r;
}
