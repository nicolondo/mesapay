// Lecturas de activos fijos para la UI (lista, detalle con depreciaciones
// contabilizadas y proyección, opciones del formulario). La matemática y la
// validación viven en activos.ts.
import { db } from "@/lib/db";
import {
  ASSET_ACCOUNT_PREFIX,
  DEPRECIATION_SOURCE,
  EXPENSE_ACCOUNT_PREFIX,
  assetProgress,
  assetSchedule,
  postedMonthChecker,
  startMonth,
} from "./activos";
import { getAccountingConfig } from "./cierre";
import { loadChartOfAccounts } from "./ledger";

export type AssetDto = {
  id: string;
  name: string;
  code: string | null;
  /** "YYYY-MM-DD". */
  purchaseDate: string;
  /** "YYYY-MM" de la primera cuota (mes siguiente a la compra). */
  startMonth: string;
  purchaseCents: number;
  salvageCents: number;
  usefulLifeMonths: number;
  assetAccountCode: string;
  assetAccountName: string;
  depreciationAccountCode: string;
  depreciationAccountName: string;
  expenseAccountCode: string;
  expenseAccountName: string;
  notes: string | null;
  active: boolean;
  disposedAt: string | null;
  createdAt: string;
  monthlyCents: number;
  /** Suma de las cuotas contabilizadas (mes cerrado o con asiento). */
  depreciatedCents: number;
  bookValueCents: number;
  postedMonths: number;
};

export type AssetScheduleRow = {
  month: string;
  amountCents: number;
  /** Id del asiento `depreciation` del mes, si existe (para enlazar el comprobante). */
  entryId: string | null;
};

export type AssetDetail = {
  asset: AssetDto;
  /** Cuotas contabilizadas (mes cerrado o con asiento). */
  posted: AssetScheduleRow[];
  /** Cuotas pendientes (meses abiertos sin asiento y futuros). */
  projected: AssetScheduleRow[];
};

export type AccountOption = { code: string; name: string };

export type AssetFormOptions = {
  accounts: {
    /** Imputables activas 15xx: cuenta del activo y depreciación acumulada. */
    asset: AccountOption[];
    /** Imputables activas 5xxx: gasto de depreciación. */
    expense: AccountOption[];
  };
};

type AssetRecord = NonNullable<Awaited<ReturnType<typeof db.fixedAsset.findFirst>>>;

/** Asientos `depreciation` del comercio: mes → id del comprobante. */
async function depreciationEntries(restaurantId: string): Promise<Map<string, string>> {
  const rows = await db.journalEntry.findMany({
    where: { restaurantId, source: DEPRECIATION_SOURCE, sourceRef: { not: null } },
    select: { id: true, sourceRef: true },
  });
  return new Map(rows.filter((r) => r.sourceRef).map((r) => [r.sourceRef!, r.id]));
}

async function accountNames(restaurantId: string, codes: string[]): Promise<Map<string, string>> {
  if (codes.length === 0) return new Map();
  const rows = await db.ledgerAccount.findMany({
    where: { restaurantId, code: { in: [...new Set(codes)] } },
    select: { code: true, name: true },
  });
  return new Map(rows.map((a) => [a.code, a.name]));
}

function toDto(
  a: AssetRecord,
  names: Map<string, string>,
  isPosted: (month: string) => boolean,
): AssetDto {
  const p = assetProgress(a, isPosted);
  return {
    id: a.id,
    name: a.name,
    code: a.code,
    purchaseDate: a.purchaseDate.toISOString().slice(0, 10),
    startMonth: startMonth(a.purchaseDate),
    purchaseCents: a.purchaseCents,
    salvageCents: a.salvageCents,
    usefulLifeMonths: a.usefulLifeMonths,
    assetAccountCode: a.assetAccountCode,
    assetAccountName: names.get(a.assetAccountCode) ?? "—",
    depreciationAccountCode: a.depreciationAccountCode,
    depreciationAccountName: names.get(a.depreciationAccountCode) ?? "—",
    expenseAccountCode: a.expenseAccountCode,
    expenseAccountName: names.get(a.expenseAccountCode) ?? "—",
    notes: a.notes,
    active: a.active,
    disposedAt: a.disposedAt ? a.disposedAt.toISOString() : null,
    createdAt: a.createdAt.toISOString(),
    monthlyCents: p.monthlyCents,
    depreciatedCents: p.depreciatedCents,
    bookValueCents: p.bookValueCents,
    postedMonths: p.postedMonths,
  };
}

function codesOf(a: AssetRecord): string[] {
  return [a.assetAccountCode, a.depreciationAccountCode, a.expenseAccountCode];
}

/** Activos del comercio (activos primero, compras recientes arriba) con progreso contabilizado. */
export async function listAssets(restaurantId: string): Promise<AssetDto[]> {
  const [assets, cfg, entries] = await Promise.all([
    db.fixedAsset.findMany({
      where: { restaurantId },
      orderBy: [{ active: "desc" }, { purchaseDate: "desc" }],
    }),
    getAccountingConfig(restaurantId),
    depreciationEntries(restaurantId),
  ]);
  const names = await accountNames(restaurantId, assets.flatMap(codesOf));
  const isPosted = postedMonthChecker(cfg.closedThrough, new Set(entries.keys()));
  return assets.map((a) => toDto(a, names, isPosted));
}

/**
 * Detalle: activo + cronograma partido en contabilizado (mes ≤ closedThrough
 * o con asiento `depreciation`, con el id del comprobante si existe) y
 * proyección restante.
 */
export async function loadAssetDetail(restaurantId: string, id: string): Promise<AssetDetail | null> {
  const a = await db.fixedAsset.findFirst({ where: { id, restaurantId } });
  if (!a) return null;
  const [names, cfg, entries] = await Promise.all([
    accountNames(restaurantId, codesOf(a)),
    getAccountingConfig(restaurantId),
    depreciationEntries(restaurantId),
  ]);
  const isPosted = postedMonthChecker(cfg.closedThrough, new Set(entries.keys()));
  const posted: AssetScheduleRow[] = [];
  const projected: AssetScheduleRow[] = [];
  for (const row of assetSchedule(a)) {
    const r = { month: row.month, amountCents: row.amountCents, entryId: entries.get(row.month) ?? null };
    (isPosted(row.month) ? posted : projected).push(r);
  }
  return { asset: toDto(a, names, isPosted), posted, projected };
}

/** Cuentas imputables activas por rol (15xx activo/acumulada, 5xxx gasto). */
export async function loadAssetFormOptions(restaurantId: string): Promise<AssetFormOptions> {
  const chart = await loadChartOfAccounts(restaurantId);
  const postable = chart.filter((a) => a.postable);
  const withPrefix = (prefix: string): AccountOption[] =>
    postable.filter((a) => a.code.startsWith(prefix)).map((a) => ({ code: a.code, name: a.name }));
  return {
    accounts: {
      asset: withPrefix(ASSET_ACCOUNT_PREFIX),
      expense: withPrefix(EXPENSE_ACCOUNT_PREFIX),
    },
  };
}
