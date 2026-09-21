// Activos fijos — depreciación en línea recta mensual (port de
// zenith-erp/contabilidad/activos/schedule.ts + depreciate_asset_core).
//
// Reglas del cronograma (`assetSchedule`, puro):
//   · primer mes depreciable = el MES SIGUIENTE al de la compra;
//     último = primero + (vida útil − 1);
//   · cuota = round((compra − rescate) / vida); cada mes lleva
//     min(cuota, restante) y la ÚLTIMA cuota absorbe el residuo, así la suma
//     cierra exacta en centavos;
//   · dado de baja (`disposedAt`): sólo deprecia los meses ≤ mes de la baja
//     (misma convención que los diferidos); nada después. Inactivo sin fecha
//     de baja: no deprecia.
//
// Cada activo tiene SUS cuentas (gasto de depreciación 5xxx y depreciación
// acumulada 15xx). El motor (posting.ts, bloque 6b) arma un solo asiento
// `depreciation` por mes con las cuotas de todos los activos agregadas por
// cuenta: Debe gasto / Haber acumulada. La cuota se calcula al vuelo por
// mes: regenerar un mes abierto ya refleja altas, ediciones y bajas; los
// meses cerrados (closedThrough) son inmutables.
//
// "Contabilizado" para la UI = mes ≤ closedThrough o con asiento
// `depreciation` existente (sourceRef = "YYYY-MM"). Editar un activo NO
// recalcula los meses cerrados: las cuotas de los meses abiertos y futuros
// usan la nueva base.
import { db } from "@/lib/db";
import { ENGINE } from "./engineCodes";

export const DEPRECIATION_SOURCE = "depreciation";

/** Defaults de las cuentas por activo (los mismos que usaba el par fijo). */
export const DEFAULT_ASSET_ACCOUNT = "152405";
export const DEFAULT_DEPRECIATION_ACCOUNT: string = ENGINE.DEPRECIACION_ACUMULADA;
export const DEFAULT_EXPENSE_ACCOUNT: string = ENGINE.DEPRECIACION_GASTO;

/** Prefijos del PUC que admite cada cuenta del activo. */
export const ASSET_ACCOUNT_PREFIX = "15";
export const EXPENSE_ACCOUNT_PREFIX = "5";

export const ASSET_NAME_MIN = 2;
export const ASSET_NAME_MAX = 160;
export const ASSET_CODE_MAX = 20;
export const ASSET_NOTES_MAX = 1000;
export const ASSET_LIFE_MAX = 600;
export const ASSET_PURCHASE_MAX = 50_000_000_000;

export type ScheduleAsset = {
  purchaseCents: number;
  salvageCents: number;
  /** ISO date (o Date) de compra. */
  purchaseDate: string | Date;
  usefulLifeMonths: number;
};

/** El cronograma + el estado de baja. */
export type DepreciableAsset = ScheduleAsset & {
  active?: boolean;
  disposedAt?: Date | string | null;
};

export type ScheduleRow = { month: string; amountCents: number };

/** "YYYY-MM" (UTC) de una fecha — misma convención que el motor. */
function monthOf(date: string | Date): string {
  return new Date(date).toISOString().slice(0, 7);
}

/** "YYYY-MM" del mes SIGUIENTE al de la fecha dada (primer mes depreciable). */
export function startMonth(purchaseDate: string | Date): string {
  const d = new Date(purchaseDate);
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  return next.toISOString().slice(0, 7);
}

/** Suma n meses a un "YYYY-MM". */
export function addMonths(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y!, (m ?? 1) - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

/** Base depreciable en centavos (compra − rescate, nunca negativa). */
export function depreciableBase(a: ScheduleAsset): number {
  return Math.max(0, a.purchaseCents - a.salvageCents);
}

/** Cuota mensual en centavos: round(base / vida útil). */
export function monthlyQuotaCents(a: ScheduleAsset): number {
  if (a.usefulLifeMonths <= 0) return 0;
  const base = depreciableBase(a);
  if (base <= 0) return 0;
  return Math.round(base / a.usefulLifeMonths);
}

/** Mes (UTC) de la baja; null si el activo sigue activo. */
export function disposalMonth(a: Pick<DepreciableAsset, "disposedAt">): string | null {
  return a.disposedAt ? monthOf(a.disposedAt) : null;
}

/**
 * Cronograma completo del activo, PURO: un renglón por mes desde el mes
 * siguiente a la compra hasta agotar la vida útil, con min(cuota, restante)
 * y la última cuota absorbiendo el residuo. Dado de baja: sólo los meses
 * ≤ mes de la baja. Inactivo sin fecha de baja: vacío.
 */
export function assetSchedule(a: DepreciableAsset): ScheduleRow[] {
  if (a.usefulLifeMonths <= 0) return [];
  const base = depreciableBase(a);
  if (base <= 0) return [];
  if (a.active === false && !a.disposedAt) return [];
  const start = startMonth(a.purchaseDate);
  const quota = monthlyQuotaCents(a);
  const until = disposalMonth(a);
  const rows: ScheduleRow[] = [];
  let remaining = base;
  for (let i = 0; i < a.usefulLifeMonths; i++) {
    const month = addMonths(start, i);
    if (until && month > until) break;
    const last = i === a.usefulLifeMonths - 1;
    const amountCents = last ? remaining : Math.min(quota, remaining);
    rows.push({ month, amountCents });
    remaining -= amountCents;
  }
  return rows;
}

/** Cuota del activo para un mes "YYYY-MM" (0 fuera de su vida o tras la baja). */
export function depreciationForAssetMonth(a: DepreciableAsset, month: string): number {
  return assetSchedule(a).find((r) => r.month === month)?.amountCents ?? 0;
}

export type AssetProgress = {
  monthlyCents: number;
  /** Suma de las cuotas ya contabilizadas. */
  depreciatedCents: number;
  /** compra − depreciado. */
  bookValueCents: number;
  /** Meses contabilizados / vida útil. */
  postedMonths: number;
  totalMonths: number;
};

/**
 * Progreso del activo según qué meses están contabilizados (mes cerrado o
 * con asiento `depreciation`); ver `postedMonthChecker`.
 */
export function assetProgress(
  a: DepreciableAsset,
  isPosted: (month: string) => boolean,
): AssetProgress {
  let depreciatedCents = 0;
  let postedMonths = 0;
  for (const row of assetSchedule(a)) {
    if (!isPosted(row.month)) continue;
    depreciatedCents += row.amountCents;
    postedMonths += 1;
  }
  return {
    monthlyCents: monthlyQuotaCents(a),
    depreciatedCents,
    bookValueCents: a.purchaseCents - depreciatedCents,
    postedMonths,
    totalMonths: a.usefulLifeMonths,
  };
}

/** "Contabilizado" = mes ≤ closedThrough o con asiento `depreciation` de ese mes. */
export function postedMonthChecker(
  closedThrough: string | null,
  monthsWithEntry: ReadonlySet<string>,
): (month: string) => boolean {
  return (month) =>
    (closedThrough != null && month <= closedThrough) || monthsWithEntry.has(month);
}

// ── Asiento del mes ─────────────────────────────────────────────────────────

/** Cuota del mes agregada por par de cuentas (gasto, depreciación acumulada). */
export type DepreciationPair = {
  expenseAccountCode: string;
  depreciationAccountCode: string;
  amountCents: number;
};

/** Línea del asiento-resumen `depreciation` (el motor la resuelve a su imputable). */
export type DepreciationLine = { code: string; debit?: number; credit?: number };

type DepreciableRow = DepreciableAsset & {
  expenseAccountCode: string;
  depreciationAccountCode: string;
};

/** Cuotas del mes de un conjunto de activos, agregadas por par de cuentas. Puro. */
export function depreciationPairsFor(
  assets: readonly DepreciableRow[],
  month: string,
): DepreciationPair[] {
  const byPair = new Map<string, DepreciationPair>();
  for (const a of assets) {
    const amount = depreciationForAssetMonth(a, month);
    if (amount <= 0) continue;
    const key = `${a.expenseAccountCode}|${a.depreciationAccountCode}`;
    const cur = byPair.get(key) ?? {
      expenseAccountCode: a.expenseAccountCode,
      depreciationAccountCode: a.depreciationAccountCode,
      amountCents: 0,
    };
    cur.amountCents += amount;
    byPair.set(key, cur);
  }
  return [...byPair.values()];
}

/**
 * Pares → líneas del asiento: Debe cada cuenta de gasto / Haber cada cuenta
 * de depreciación acumulada, sumadas por cuenta. Débitos primero. Puro.
 */
export function depreciationLinesFromPairs(pairs: readonly DepreciationPair[]): DepreciationLine[] {
  const debits = new Map<string, number>();
  const credits = new Map<string, number>();
  for (const p of pairs) {
    debits.set(p.expenseAccountCode, (debits.get(p.expenseAccountCode) ?? 0) + p.amountCents);
    credits.set(
      p.depreciationAccountCode,
      (credits.get(p.depreciationAccountCode) ?? 0) + p.amountCents,
    );
  }
  return [
    ...[...debits].map(([code, debit]) => ({ code, debit })),
    ...[...credits].map(([code, credit]) => ({ code, credit })),
  ];
}

const DEPRECIABLE_SELECT = {
  purchaseCents: true,
  salvageCents: true,
  purchaseDate: true,
  usefulLifeMonths: true,
  active: true,
  disposedAt: true,
  expenseAccountCode: true,
  depreciationAccountCode: true,
} as const;

/** Cuotas del mes de TODOS los activos del comercio, por par de cuentas. */
export async function depreciationPairsForMonth(
  restaurantId: string,
  month: string,
): Promise<DepreciationPair[]> {
  const assets = await db.fixedAsset.findMany({
    where: { restaurantId },
    select: DEPRECIABLE_SELECT,
    orderBy: { createdAt: "asc" },
  });
  return depreciationPairsFor(assets, month);
}

/** Líneas del asiento `depreciation` del mes (vacío si nada deprecia). */
export async function depreciationLinesForMonth(
  restaurantId: string,
  month: string,
): Promise<DepreciationLine[]> {
  return depreciationLinesFromPairs(await depreciationPairsForMonth(restaurantId, month));
}

/** Depreciación total del comercio para un mes (suma de todas las cuotas). */
export async function depreciationForMonth(restaurantId: string, month: string): Promise<number> {
  const pairs = await depreciationPairsForMonth(restaurantId, month);
  return pairs.reduce((s, p) => s + p.amountCents, 0);
}

// ── Validación del alta y la edición (pura) ────────────────────────────────

export type AssetInput = {
  name: string;
  code?: string | null;
  /** "YYYY-MM-DD". */
  purchaseDate: string;
  purchaseCents: number;
  salvageCents: number;
  usefulLifeMonths: number;
  assetAccountCode: string;
  depreciationAccountCode: string;
  expenseAccountCode: string;
  notes?: string | null;
};

export type AssetValidationError =
  | "invalid_name"
  | "invalid_code"
  | "invalid_date"
  | "invalid_purchase"
  | "invalid_salvage"
  | "salvage_too_high"
  | "invalid_life"
  | "invalid_notes"
  | "asset_account_invalid"
  | "depreciation_account_invalid"
  | "expense_account_invalid";

/** Cuentas del plan ya cargadas (código → estado). */
export type AssetAccountIndex = ReadonlyMap<string, { active: boolean; postable: boolean }>;

export type NormalizedAsset = {
  name: string;
  code: string | null;
  purchaseDate: Date;
  purchaseCents: number;
  salvageCents: number;
  usefulLifeMonths: number;
  assetAccountCode: string;
  depreciationAccountCode: string;
  expenseAccountCode: string;
  notes: string | null;
};

export type AssetValidation =
  | { ok: true; normalized: NormalizedAsset }
  | { ok: false; error: AssetValidationError };

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** "YYYY-MM-DD" → Date a las 00:00 UTC (como se guardaban las compras); null si es inválida. */
export function parsePurchaseDate(ymd: string): Date | null {
  if (!YMD.test(ymd)) return null;
  const d = new Date(`${ymd}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== ymd) return null;
  const year = d.getUTCFullYear();
  if (year < 1990 || year > 2100) return null;
  return d;
}

function postableWithPrefix(
  accounts: AssetAccountIndex,
  rawCode: unknown,
  prefix: string,
): string | null {
  const code = typeof rawCode === "string" ? rawCode.trim() : "";
  if (!code || !code.startsWith(prefix)) return null;
  const account = accounts.get(code);
  if (!account || !account.active || !account.postable) return null;
  return code;
}

/**
 * Valida y normaliza el alta o la edición completa de un activo. Cuentas:
 * existentes, activas e imputables — activo y depreciación acumulada con
 * prefijo 15, gasto con prefijo 5. `salvage < purchase`.
 */
export function validateAssetInput(input: AssetInput, accounts: AssetAccountIndex): AssetValidation {
  const name = (input.name ?? "").trim();
  if (name.length < ASSET_NAME_MIN || name.length > ASSET_NAME_MAX) {
    return { ok: false, error: "invalid_name" };
  }
  const code = (input.code ?? "").trim() || null;
  if (code && code.length > ASSET_CODE_MAX) return { ok: false, error: "invalid_code" };
  const purchaseDate = parsePurchaseDate(input.purchaseDate ?? "");
  if (!purchaseDate) return { ok: false, error: "invalid_date" };
  const purchaseCents = input.purchaseCents;
  if (!Number.isInteger(purchaseCents) || purchaseCents <= 0 || purchaseCents > ASSET_PURCHASE_MAX) {
    return { ok: false, error: "invalid_purchase" };
  }
  const salvageCents = input.salvageCents;
  if (!Number.isInteger(salvageCents) || salvageCents < 0) {
    return { ok: false, error: "invalid_salvage" };
  }
  if (salvageCents >= purchaseCents) return { ok: false, error: "salvage_too_high" };
  const usefulLifeMonths = input.usefulLifeMonths;
  if (!Number.isInteger(usefulLifeMonths) || usefulLifeMonths < 1 || usefulLifeMonths > ASSET_LIFE_MAX) {
    return { ok: false, error: "invalid_life" };
  }
  const notes = (input.notes ?? "").trim() || null;
  if (notes && notes.length > ASSET_NOTES_MAX) return { ok: false, error: "invalid_notes" };
  const assetAccountCode = postableWithPrefix(accounts, input.assetAccountCode, ASSET_ACCOUNT_PREFIX);
  if (!assetAccountCode) return { ok: false, error: "asset_account_invalid" };
  const depreciationAccountCode = postableWithPrefix(
    accounts,
    input.depreciationAccountCode,
    ASSET_ACCOUNT_PREFIX,
  );
  if (!depreciationAccountCode) return { ok: false, error: "depreciation_account_invalid" };
  const expenseAccountCode = postableWithPrefix(
    accounts,
    input.expenseAccountCode,
    EXPENSE_ACCOUNT_PREFIX,
  );
  if (!expenseAccountCode) return { ok: false, error: "expense_account_invalid" };
  return {
    ok: true,
    normalized: {
      name,
      code,
      purchaseDate,
      purchaseCents,
      salvageCents,
      usefulLifeMonths,
      assetAccountCode,
      depreciationAccountCode,
      expenseAccountCode,
      notes,
    },
  };
}

/** Plan del comercio como índice para `validateAssetInput`. */
export async function loadAssetAccountIndex(restaurantId: string): Promise<AssetAccountIndex> {
  const rows = await db.ledgerAccount.findMany({
    where: { restaurantId },
    select: { code: true, active: true, postable: true },
  });
  return new Map(rows.map((r) => [r.code, { active: r.active, postable: r.postable }]));
}
