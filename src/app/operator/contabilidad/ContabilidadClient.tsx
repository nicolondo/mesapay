"use client";

import { useEffect, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import { formatDate, formatMoney, localeTag, pesosToCents } from "@/lib/format";

/* ───────────────────────────── Tipos ───────────────────────────────── */
// Espejo de GET /api/operator/expenses (gastos del mes + plantillas +
// categorías para el datalist) y de GET /api/operator/suppliers (picker).

type SupplierRef = { id: string; name: string };

type ExpenseDto = {
  id: string;
  category: string;
  description: string | null;
  amountCents: number;
  /** ISO — fecha contable del gasto (editable, no createdAt). */
  date: string;
  supplierId: string | null;
  supplier: SupplierRef | null;
  recurring: boolean;
  /** 1-28 solo en plantillas (recurring: true). */
  recurringDay: number | null;
  templateId: string | null;
};

type ExpensesPayload = {
  /** Gastos del mes (recurring: false), date desc. */
  expenses: ExpenseDto[];
  /** TODAS las plantillas recurrentes (no dependen del mes). */
  templates: ExpenseDto[];
  /** Categorías ya usadas — alimentan el datalist (categoría libre, D2). */
  categories: string[];
};

// Espejo de GET /api/operator/accounting/pnl (B2 · D3). Los % vienen con
// 1 decimal; null = sin ventas en el mes (no inventar 0%).
type PnlDto = {
  salesCents: number;
  tipsCents: number;
  taxesCents: number;
  consumptionCents: number;
  wasteCents: number;
  /** Orden desc por monto (lo garantiza el server). */
  expensesByCategory: Array<{ category: string; amountCents: number }>;
  purchasesReceivedCents: number;
  expensesCents: number;
  grossProfitCents: number;
  grossMarginPct: number | null;
  operatingProfitCents: number;
  operatingMarginPct: number | null;
  /**
   * C1 — costo laboral del mes: null = módulo staff apagado (el P&L se ve
   * exactamente como antes). Base salarial (Σ salarios de activos, fija) +
   * recargos festivo/dominical de los turnos. C2 — conteo de faltas (modo
   * estricto).
   */
  labor: {
    totalCents: number;
    baseSalaryCents: number;
    surchargeCents: number;
    salariedEmployees: number;
    missingSalaryEmployees: number;
    shifts: number;
    absentShifts: number;
  } | null;
  /** C1 — (CMV + mermas + laboral) / ingresos. null sin staff o sin ventas. */
  primeCostPct: number | null;
};

// Espejo de GET /api/operator/accounting/books (B2 · D5).
type Book = "sales" | "purchases";

type SalesBookOrder = {
  id: string;
  shortCode: string;
  paidAt: string;
  orderType: "dineIn" | "pickup";
  subtotalCents: number;
  tipCents: number;
  taxCents: number;
  totalCents: number;
  table: { number: number; label: string | null } | null;
  /** Solo pagos aprobados. */
  payments: Array<{ method: string; amountCents: number }>;
  simpleInvoice: { invoiceNumber: number } | null;
};

type SalesBookPayload = {
  book: "sales";
  orders: SalesBookOrder[];
  totals: {
    count: number;
    subtotalCents: number;
    tipCents: number;
    taxCents: number;
    totalCents: number;
    /** Desc por monto. */
    byMethod: Array<{ method: string; amountCents: number }>;
  };
};

type PurchasesBookRow = {
  id: string;
  number: number;
  receivedAt: string;
  supplierName: string;
  supplierInvoiceNumber: string | null;
  invoiceDueAt: string | null;
  paidAt: string | null;
  receivedCents: number;
};

type PurchasesBookPayload = {
  book: "purchases";
  rows: PurchasesBookRow[];
  totals: { count: number; receivedCents: number; unpaidCents: number };
};

type BookPayload = SalesBookPayload | PurchasesBookPayload;

/* ─────────────────────────── Helpers ───────────────────────────────── */

/** "2026-07" del mes actual (hora local del dispositivo). */
function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** "2026-07" ± n meses — aritmética UTC sobre el día 1 (sin DST). */
function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** "Julio de 2026" — label del selector de mes en el idioma del usuario. */
function monthLabel(month: string, locale: Locale): string {
  const [y, m] = month.split("-").map(Number);
  const label = new Intl.DateTimeFormat(localeTag(locale), {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(y, m - 1, 1)));
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** "2026-07-10" (input date) → ISO al mediodía local (sin corrimiento de día). */
function dateInputToIso(value: string): string {
  return new Date(`${value}T12:00:00`).toISOString();
}

function isoToDateInput(value: string): string {
  const d = new Date(value);
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Hoy en formato input date — default del formulario de gasto. */
function todayDateInput(): string {
  return isoToDateInput(new Date().toISOString());
}

// Errores del POST/PATCH/DELETE de gastos → clave i18n (fallback
// errSaveFailed). recurring_day_forbidden es defensivo: el formulario
// nunca manda día sin recurrente.
const API_ERROR_KEYS: Record<string, string> = {
  invalid: "errExpenseInvalid",
  recurring_day_required: "errRecurringDayRequired",
  recurring_day_forbidden: "errRecurringDayForbidden",
  supplier_not_found: "errSupplierNotFound",
  not_found: "errExpenseNotFound",
};

// PaymentMethod (prisma) → clave i18n del label (convención m* de
// opPayments/opOrders). Un método futuro sin clave cae al valor crudo:
// el libro nunca se rompe por un enum nuevo.
const PAY_METHOD_KEYS: Record<string, string> = {
  demo_cash: "mDemoCash",
  demo_card: "mDemoCard",
  wompi_card: "mWompiCard",
  wompi_pse: "mWompiPse",
  wompi_nequi: "mWompiNequi",
  kushki_apple_pay: "mKushkiApplePay",
  kushki_google_pay: "mKushkiGooglePay",
  kushki_card_terminal: "mKushkiCardTerminal",
  kushki_card: "mKushkiCard",
  kushki_pse: "mKushkiPse",
  external_terminal: "mExternalTerminal",
  reservation_deposit: "mReservationDeposit",
};

/** % (ya en escala 0-100, 1 decimal) → "66,5 %" localizado; null → "—". */
function fmtPct(pct: number | null, locale: Locale): string {
  if (pct === null) return "—";
  return new Intl.NumberFormat(localeTag(locale), {
    style: "percent",
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(pct / 100);
}

/** Verde/rojo según signo de la utilidad; 0 queda neutro. */
function profitCls(cents: number): string {
  return cents > 0 ? "text-ok" : cents < 0 ? "text-danger" : "";
}

// "Ahora" congelado al cargar el módulo — para el flag de factura vencida
// del libro de compras. Fuera del componente porque el render debe ser
// puro (regla react-hooks/purity); la precisión de horas no importa acá.
const NOW_MS = Date.now();

type Tab = "expenses" | "pnl" | "books";

/* ───────────────────────────── Shell ───────────────────────────────── */

export function ContabilidadClient({ currency }: { currency: string }) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;

  const [tab, setTab] = useState<Tab>("expenses");
  const [month, setMonth] = useState(currentMonth);
  // El payload viaja con SU mes: al cambiar de mes, `data` (derivado abajo)
  // vuelve a null (cargando) sin resetear estado dentro del efecto; al
  // recargar el MISMO mes (tras guardar) se muestra el dato viejo sin
  // parpadeo hasta que llega el nuevo — patrón caché de Recetas.
  const [loaded, setLoaded] = useState<{
    month: string;
    payload: ExpensesPayload;
  } | null>(null);
  const [loadErr, setLoadErr] = useState(false);
  const [suppliers, setSuppliers] = useState<SupplierRef[]>([]);
  // true cuando el endpoint de proveedores respondió 200 (módulo purchasing
  // activo) — habilita el campo/alta de proveedor aunque el catálogo esté vacío.
  const [suppliersEnabled, setSuppliersEnabled] = useState(false);
  // Se incrementa para re-fetchear el mes tras guardar/borrar: un gasto
  // editado puede salir del mes, y una plantilla nueva cambia ambas listas.
  const [reloadSeq, setReloadSeq] = useState(0);
  // null = cerrado · "new" = crear · dto = editar (gasto o plantilla).
  const [open, setOpen] = useState<ExpenseDto | "new" | null>(null);
  // Cachés por mes de los otros tabs (patrón engCache de Recetas): viven
  // acá y no en el tab para sobrevivir al cambio de tab. La del P&L se
  // invalida al guardar/borrar gastos (los gastos mueven el resultado);
  // los libros no dependen de los gastos, así que su caché queda.
  const [pnlCache, setPnlCache] = useState<Record<string, PnlDto>>({});
  const [book, setBook] = useState<Book>("sales");
  const [booksCache, setBooksCache] = useState<Record<string, BookPayload>>(
    {},
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/operator/expenses?month=${month}`);
        if (!r.ok) throw new Error("load_failed");
        const j = (await r.json()) as ExpensesPayload;
        if (cancelled) return;
        setLoaded({ month, payload: j });
        setLoadErr(false);
      } catch {
        if (!cancelled) setLoadErr(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [month, reloadSeq]);

  // null = cargando el mes seleccionado (aún no hay payload de ESE mes).
  const data = loaded !== null && loaded.month === month ? loaded.payload : null;

  // Proveedores para el select del formulario. El endpoint vive tras el
  // módulo `purchasing`: si está apagado responde 403 y el campo
  // simplemente no se ofrece (el gasto queda sin proveedor — opcional).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/operator/suppliers");
        if (!r.ok) return;
        const j = (await r.json()) as { suppliers?: SupplierRef[] };
        if (!cancelled) {
          // Módulo purchasing activo (endpoint 200) ⇒ ofrecer el campo
          // proveedor aunque el catálogo esté vacío, para crear el primero.
          setSuppliersEnabled(true);
          setSuppliers(
            (j.suppliers ?? []).map((s) => ({ id: s.id, name: s.name })),
          );
        }
      } catch {
        /* opcional — sin proveedores el formulario sigue funcionando */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const totalCents = useMemo(
    () => (data?.expenses ?? []).reduce((sum, e) => sum + e.amountCents, 0),
    [data],
  );

  function handleChanged() {
    setOpen(null);
    setReloadSeq((s) => s + 1);
    // Los gastos alimentan el P&L (línea "Gastos" y utilidad): tirar la
    // caché completa para que el tab lo re-derive al abrirse.
    setPnlCache({});
  }

  return (
    <div className="space-y-4">
      {/* Segmentos Gastos / P&L / Libros */}
      <div className="inline-flex rounded-full border border-op-border bg-op-surface overflow-hidden">
        {(
          [
            ["expenses", t("tabExpenses")],
            ["pnl", t("tabPnl")],
            ["books", t("tabBooks")],
          ] as [Tab, string][]
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setTab(value)}
            className={
              "min-h-[44px] px-5 text-xs font-medium transition-colors " +
              (tab === value ? "bg-ink text-bone" : "text-op-muted hover:text-ink")
            }
          >
            {label}
          </button>
        ))}
      </div>

      {/* Selector de mes: ◀ Julio de 2026 ▶ — compartido por los 3 tabs
          (mismo `month` para gastos, P&L y libros). */}
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setMonth((m) => shiftMonth(m, -1))}
          aria-label={t("monthPrev")}
          className="min-h-[44px] min-w-[44px] rounded-full border border-op-border bg-op-surface text-sm text-op-muted hover:text-ink hover:bg-op-bg"
        >
          {"◀"}
        </button>
        <div className="text-sm font-medium">
          {monthLabel(month, locale)}
        </div>
        <button
          type="button"
          onClick={() => setMonth((m) => shiftMonth(m, 1))}
          aria-label={t("monthNext")}
          className="min-h-[44px] min-w-[44px] rounded-full border border-op-border bg-op-surface text-sm text-op-muted hover:text-ink hover:bg-op-bg"
        >
          {"▶"}
        </button>
      </div>

      {tab === "pnl" ? (
        <PnlTab
          month={month}
          currency={currency}
          cache={pnlCache}
          setCache={setPnlCache}
        />
      ) : tab === "books" ? (
        <BooksTab
          month={month}
          currency={currency}
          book={book}
          setBook={setBook}
          cache={booksCache}
          setCache={setBooksCache}
        />
      ) : (
        <>
          <button
            type="button"
            onClick={() => setOpen("new")}
            className="w-full min-h-[44px] rounded-full bg-ink text-bone text-sm font-medium hover:bg-ink/90"
          >
            {t("newExpense")}
          </button>

          {loadErr ? (
            <div className="text-xs text-danger">{t("errLoadFailed")}</div>
          ) : data === null ? (
            <div className="py-6 text-center text-sm text-op-muted">
              {t("loading")}
            </div>
          ) : (
            <>
              {/* Total del mes (solo gastos materializados, no plantillas) */}
              <div className="rounded-2xl border border-op-border bg-op-surface px-4 py-3 flex items-center justify-between gap-3">
                <span className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted">
                  {t("expensesTotalLabel")}
                </span>
                <span className="text-sm font-medium tabular-nums">
                  {formatMoney(totalCents, { currency, locale })}
                </span>
              </div>

              {data.expenses.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-op-border bg-op-surface/50 p-8 text-center">
                  <div className="font-display text-lg mb-1">
                    {t("expensesEmptyTitle")}
                  </div>
                  <p className="text-sm text-op-muted">
                    {t("expensesEmptyBody")}
                  </p>
                </div>
              ) : (
                <div className="bg-op-surface border border-op-border rounded-2xl overflow-hidden">
                  {data.expenses.map((e) => (
                    <button
                      key={e.id}
                      type="button"
                      onClick={() => setOpen(e)}
                      className="w-full text-left px-4 py-2.5 border-b border-op-border last:border-b-0 hover:bg-op-bg"
                    >
                      <div className="flex items-center gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium truncate">
                            {e.category}
                          </div>
                          {e.description && (
                            <div className="text-[11px] text-op-muted mt-0.5 truncate">
                              {e.description}
                            </div>
                          )}
                        </div>
                        <div className="text-right shrink-0">
                          <div className="text-sm font-medium tabular-nums">
                            {formatMoney(e.amountCents, { currency, locale })}
                          </div>
                          <div className="text-[11px] text-op-muted mt-0.5">
                            {formatDate(e.date, {
                              locale,
                              timeStyle: undefined,
                            }) + (e.supplier ? ` · ${e.supplier.name}` : "")}
                          </div>
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              )}

              {/* Plantillas recurrentes (arriendo, nómina…) — el cron las
                  materializa como gasto del mes cuando llega su día. */}
              {data.templates.length > 0 && (
                <TemplatesSection
                  templates={data.templates}
                  currency={currency}
                  onOpen={setOpen}
                />
              )}
            </>
          )}
        </>
      )}

      {open !== null && (
        <ExpenseSheet
          expense={open === "new" ? null : open}
          suppliers={suppliers}
          suppliersEnabled={suppliersEnabled}
          categories={data?.categories ?? []}
          onClose={() => setOpen(null)}
          onChanged={handleChanged}
          onSupplierCreated={(s) =>
            setSuppliers((prev) =>
              [s, ...prev.filter((p) => p.id !== s.id)].sort((a, b) =>
                a.name.localeCompare(b.name),
              ),
            )
          }
        />
      )}
    </div>
  );
}

/* ───────────────────────── Tab P&L (D3) ────────────────────────────── */

/**
 * Estado de cuenta vertical del mes: ingresos − CMV − mermas = margen
 * bruto; − gastos = utilidad operativa. Derivado en vivo por el server;
 * acá solo se cachea por mes — el shell invalida al tocar gastos.
 */
function PnlTab({
  month,
  currency,
  cache,
  setCache,
}: {
  month: string;
  currency: string;
  cache: Record<string, PnlDto>;
  setCache: React.Dispatch<React.SetStateAction<Record<string, PnlDto>>>;
}) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;
  const [loadErr, setLoadErr] = useState(false);
  const pnl: PnlDto | undefined = cache[month];

  useEffect(() => {
    if (cache[month]) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/operator/accounting/pnl?month=${month}`);
        if (!r.ok) throw new Error("load_failed");
        const j = (await r.json()) as { pnl: PnlDto };
        if (cancelled) return;
        setCache((c) => ({ ...c, [month]: j.pnl }));
        setLoadErr(false);
      } catch {
        if (!cancelled) setLoadErr(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [month, cache, setCache]);

  if (pnl === undefined) {
    return loadErr ? (
      <div className="text-xs text-danger">{t("errLoadFailed")}</div>
    ) : (
      <div className="py-6 text-center text-sm text-op-muted">
        {t("loading")}
      </div>
    );
  }

  const money = (cents: number) => formatMoney(cents, { currency, locale });

  return (
    <div className="space-y-4">
      <div className="bg-op-surface border border-op-border rounded-2xl overflow-hidden">
        {/* Ingresos por ventas + líneas informativas (no son ingreso) */}
        <div className="px-4 py-3 border-b border-op-border">
          <div className="flex items-center justify-between gap-3">
            <span className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted">
              {t("pnlSales")}
            </span>
            <span className="font-display text-2xl tabular-nums">
              {money(pnl.salesCents)}
            </span>
          </div>
          <div className="mt-1.5 space-y-0.5">
            <div className="flex items-center justify-between gap-3 text-[11px] text-op-muted">
              <span>{t("pnlTips")}</span>
              <span className="tabular-nums">{money(pnl.tipsCents)}</span>
            </div>
            <div className="flex items-center justify-between gap-3 text-[11px] text-op-muted">
              <span>{t("pnlTaxes")}</span>
              <span className="tabular-nums">{money(pnl.taxesCents)}</span>
            </div>
          </div>
        </div>

        <PnlLine
          label={t("pnlConsumption")}
          value={"− " + money(pnl.consumptionCents)}
        />
        <PnlLine label={t("pnlWaste")} value={"− " + money(pnl.wasteCents)} />
        <PnlSubtotal
          label={t("pnlGrossProfit")}
          value={money(pnl.grossProfitCents)}
          pct={fmtPct(pnl.grossMarginPct, locale)}
        />

        {/* C1 — costo laboral (solo con módulo staff activo): después del
            margen bruto y antes de gastos. La utilidad operativa ya lo
            descuenta server-side. */}
        {pnl.labor !== null && (
          <PnlLabor labor={pnl.labor} currency={currency} />
        )}

        <PnlExpenses pnl={pnl} currency={currency} />

        <PnlSubtotal
          label={t("pnlOperatingProfit")}
          value={money(pnl.operatingProfitCents)}
          pct={fmtPct(pnl.operatingMarginPct, locale)}
          valueCls={profitCls(pnl.operatingProfitCents)}
        />
      </div>

      {/* Prime cost (C1) — CMV + mermas + laboral sobre ingresos. Solo
          con módulo staff activo y ventas en el mes. */}
      {pnl.primeCostPct !== null && (
        <div className="rounded-2xl border border-op-border bg-op-surface px-4 py-3 flex items-center justify-between gap-3">
          <span className="text-[11px] text-op-muted">
            {t("laborPrimeCost")}
          </span>
          <span className="text-sm tabular-nums text-op-muted shrink-0">
            {fmtPct(pnl.primeCostPct, locale)}
          </span>
        </div>
      )}

      {/* Compras recibidas — contexto de caja: NO entra al resultado (el
          costo de lo vendido entra vía CMV). */}
      <div className="rounded-2xl border border-op-border bg-op-surface px-4 py-3 flex items-center justify-between gap-3">
        <span className="text-[11px] text-op-muted">
          {t("pnlPurchasesInfo")}
        </span>
        <span className="text-sm tabular-nums text-op-muted shrink-0">
          {money(pnl.purchasesReceivedCents)}
        </span>
      </div>

      {/* Compró pero no registró consumo: el CMV en 0 mentiría — nunca
          usar compras como CMV disfrazado (regla D3). */}
      {pnl.consumptionCents === 0 && pnl.purchasesReceivedCents > 0 && (
        <div className="rounded-2xl border border-[#C98A2E]/40 bg-[#C98A2E]/10 px-4 py-3 text-sm text-[#7F5A1F]">
          {t("pnlCmvHint")}
        </div>
      )}
    </div>
  );
}

/** Línea de deducción del estado de cuenta (− CMV, − Mermas). */
function PnlLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-4 py-2.5 border-b border-op-border flex items-center justify-between gap-3">
      <span className="text-sm text-op-muted">{label}</span>
      <span className="text-sm tabular-nums shrink-0">{value}</span>
    </div>
  );
}

/**
 * Línea "− Costo laboral" (C1): base salarial mensual (Σ salarios de
 * activos, fija) + recargos festivo/dominical en el caption. Badge
 * discreto cuando hay empleados activos sin salario (no entran a la base
 * — el total está subestimado y el operador debe saberlo).
 */
function PnlLabor({
  labor,
  currency,
}: {
  labor: NonNullable<PnlDto["labor"]>;
  currency: string;
}) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;
  const money = (cents: number) => formatMoney(cents, { currency, locale });

  return (
    <div className="px-4 py-2.5 border-b border-op-border">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-op-muted">{t("laborPnlLine")}</span>
        <span className="text-sm tabular-nums shrink-0">
          {"− " + money(labor.totalCents)}
        </span>
      </div>
      <div className="mt-0.5 flex items-center justify-between gap-3 flex-wrap">
        <span className="text-[11px] text-op-muted tabular-nums">
          {/* Base salarial + recargos; faltas se anexan solo si existen. */}
          {[
            t("laborPnlBreakdown", {
              base: money(labor.baseSalaryCents),
              surcharge: money(labor.surchargeCents),
            }),
            labor.absentShifts > 0
              ? t("absentCount", { count: labor.absentShifts })
              : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
        {labor.missingSalaryEmployees > 0 && (
          <span className="px-2 h-5 inline-flex items-center rounded-full bg-[#C98A2E]/10 text-[#7F5A1F] text-[10px] font-medium shrink-0">
            {t("laborMissingSalaryEmployees", {
              count: labor.missingSalaryEmployees,
            })}
          </span>
        )}
      </div>
    </div>
  );
}

/** Subtotal con % (margen bruto / utilidad operativa). */
function PnlSubtotal({
  label,
  value,
  pct,
  valueCls,
}: {
  label: string;
  value: string;
  pct: string;
  valueCls?: string;
}) {
  return (
    <div className="px-4 py-3 border-b border-op-border last:border-b-0 bg-op-bg/50 flex items-center justify-between gap-3">
      <span className="text-sm font-medium">{label}</span>
      <div className="text-right shrink-0">
        <div
          className={
            "text-sm font-medium tabular-nums" +
            (valueCls ? " " + valueCls : "")
          }
        >
          {value}
        </div>
        <div className="text-[11px] text-op-muted tabular-nums">{pct}</div>
      </div>
    </div>
  );
}

/**
 * Línea de gastos con desglose por categoría (orden desc del server).
 * Con más de 4 categorías el desglose se colapsa (cerrado por defecto,
 * mismo criterio que TemplatesSection) para no ahogar el estado.
 */
function PnlExpenses({ pnl, currency }: { pnl: PnlDto; currency: string }) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;
  const [open, setOpen] = useState(false);
  const collapsible = pnl.expensesByCategory.length > 4;
  const showBreakdown =
    pnl.expensesByCategory.length > 0 && (!collapsible || open);

  const header = (
    <>
      <span className="text-sm text-op-muted">
        {t("pnlExpenses")}
        {collapsible && (
          <span className="ml-2 text-[11px]">
            {(open ? "▾ " : "▸ ") +
              t("pnlExpenseCategories", {
                count: pnl.expensesByCategory.length,
              })}
          </span>
        )}
      </span>
      <span className="text-sm tabular-nums shrink-0">
        {"− " + formatMoney(pnl.expensesCents, { currency, locale })}
      </span>
    </>
  );

  return (
    <div className="border-b border-op-border">
      {collapsible ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="w-full min-h-[44px] px-4 py-2.5 flex items-center justify-between gap-3 text-left hover:bg-op-bg"
        >
          {header}
        </button>
      ) : (
        <div className="px-4 py-2.5 flex items-center justify-between gap-3">
          {header}
        </div>
      )}
      {showBreakdown && (
        <div className="px-4 pb-2.5 space-y-1">
          {pnl.expensesByCategory.map((e) => (
            <div
              key={e.category}
              className="flex items-center justify-between gap-3 text-[11px] text-op-muted"
            >
              <span className="truncate pl-3">{e.category}</span>
              <span className="tabular-nums shrink-0">
                {formatMoney(e.amountCents, { currency, locale })}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─────────────────────── Tab Libros (D5) ───────────────────────────── */

/**
 * Libros de ventas y compras del mes con export CSV. Sub-toggle
 * Ventas/Compras (el estado vive en el shell para sobrevivir al cambio
 * de tab) + caché por book+mes. El export es un link directo: el server
 * pone Content-Disposition y el browser descarga solo.
 */
function BooksTab({
  month,
  currency,
  book,
  setBook,
  cache,
  setCache,
}: {
  month: string;
  currency: string;
  book: Book;
  setBook: (b: Book) => void;
  cache: Record<string, BookPayload>;
  setCache: React.Dispatch<React.SetStateAction<Record<string, BookPayload>>>;
}) {
  const t = useTranslations("opErp");
  const [loadErr, setLoadErr] = useState(false);
  const cacheKey = `${book}:${month}`;
  const data = cache[cacheKey];

  useEffect(() => {
    if (cache[cacheKey]) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(
          `/api/operator/accounting/books?book=${book}&month=${month}`,
        );
        if (!r.ok) throw new Error("load_failed");
        const j = (await r.json()) as BookPayload;
        if (cancelled) return;
        setCache((c) => ({ ...c, [cacheKey]: j }));
        setLoadErr(false);
      } catch {
        if (!cancelled) setLoadErr(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cacheKey, book, month, cache, setCache]);

  return (
    <div className="space-y-4">
      {/* Sub-toggle Ventas / Compras + export CSV del libro activo */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="inline-flex rounded-full border border-op-border bg-op-surface overflow-hidden">
          {(
            [
              ["sales", t("bookSales")],
              ["purchases", t("bookPurchases")],
            ] as [Book, string][]
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setBook(value)}
              className={
                "min-h-[36px] px-4 text-xs font-medium transition-colors " +
                (book === value
                  ? "bg-ink text-bone"
                  : "text-op-muted hover:text-ink")
              }
            >
              {label}
            </button>
          ))}
        </div>
        <a
          href={`/api/operator/accounting/export?book=${book}&month=${month}`}
          className="min-h-[36px] px-4 inline-flex items-center rounded-full border border-op-border bg-op-surface text-xs font-medium hover:bg-op-bg"
        >
          {t("exportCsv")}
        </a>
      </div>

      {data === undefined ? (
        loadErr ? (
          <div className="text-xs text-danger">{t("errLoadFailed")}</div>
        ) : (
          <div className="py-6 text-center text-sm text-op-muted">
            {t("loading")}
          </div>
        )
      ) : data.book === "sales" ? (
        <SalesBookView data={data} currency={currency} />
      ) : (
        <PurchasesBookView data={data} currency={currency} />
      )}

      {/* Gastos: tercer libro exportable — link discreto (la vista ya
          vive en el tab Gastos; acá solo el CSV para el contador). */}
      <div className="text-center">
        <a
          href={`/api/operator/accounting/export?book=expenses&month=${month}`}
          className="text-[11px] text-op-muted underline hover:text-ink"
        >
          {t("exportExpensesCsv")}
        </a>
      </div>
    </div>
  );
}

/** Fila label/valor de los resúmenes de libro. */
function SummaryLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 text-[11px]">
      <span className="text-op-muted truncate">{label}</span>
      <span className="tabular-nums shrink-0">{value}</span>
    </div>
  );
}

/** Libro de ventas: resumen del mes + órdenes pagadas. */
function SalesBookView({
  data,
  currency,
}: {
  data: SalesBookPayload;
  currency: string;
}) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;
  const money = (cents: number) => formatMoney(cents, { currency, locale });
  const methodLabel = (method: string) => {
    const key = PAY_METHOD_KEYS[method];
    return key ? t(key) : method;
  };

  return (
    <>
      <div className="bg-op-surface border border-op-border rounded-2xl overflow-hidden">
        <div className="px-4 py-3 border-b border-op-border flex items-center justify-between gap-3">
          <span className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted">
            {t("bookOrdersCount", { count: data.totals.count })}
          </span>
          <span className="font-display text-2xl tabular-nums">
            {money(data.totals.totalCents)}
          </span>
        </div>
        <div className="px-4 py-2.5 space-y-1">
          <SummaryLine
            label={t("csvSubtotal")}
            value={money(data.totals.subtotalCents)}
          />
          <SummaryLine
            label={t("csvTip")}
            value={money(data.totals.tipCents)}
          />
          <SummaryLine
            label={t("csvTax")}
            value={money(data.totals.taxCents)}
          />
        </div>
        {data.totals.byMethod.length > 0 && (
          <div className="px-4 py-2.5 border-t border-op-border space-y-1">
            <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted mb-1.5">
              {t("bookByMethod")}
            </div>
            {data.totals.byMethod.map((m) => (
              <SummaryLine
                key={m.method}
                label={methodLabel(m.method)}
                value={money(m.amountCents)}
              />
            ))}
          </div>
        )}
      </div>

      {data.orders.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-op-border bg-op-surface/50 p-8 text-center text-sm text-op-muted">
          {t("bookSalesEmpty")}
        </div>
      ) : (
        <div className="bg-op-surface border border-op-border rounded-2xl overflow-hidden">
          {data.orders.map((o) => (
            <div
              key={o.id}
              className="px-4 py-2.5 border-b border-op-border last:border-b-0"
            >
              <div className="flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-sm font-medium shrink-0">
                      {o.shortCode}
                    </span>
                    <span className="text-sm text-op-muted truncate">
                      {o.orderType === "pickup"
                        ? t("bookPickup")
                        : o.table
                          ? (o.table.label ??
                            t("bookTable", {
                              // String: ICU agruparía miles en un number.
                              number: String(o.table.number),
                            }))
                          : "—"}
                    </span>
                  </div>
                  <div className="text-[11px] text-op-muted mt-0.5 truncate">
                    {formatDate(o.paidAt, { locale, dateStyle: "short" })}
                    {o.simpleInvoice &&
                      ` · ${t("invoiceLabel", {
                        // String: ICU agruparía miles (Factura 1.234).
                        number: String(o.simpleInvoice.invoiceNumber),
                      })}`}
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-sm font-medium tabular-nums">
                    {money(o.totalCents)}
                  </div>
                  {o.tipCents > 0 && (
                    <div className="text-[11px] text-op-muted mt-0.5 tabular-nums">
                      {t("bookTipLine", { amount: money(o.tipCents) })}
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/** Libro de compras: recibido / por pagar + OCs recibidas en el mes. */
function PurchasesBookView({
  data,
  currency,
}: {
  data: PurchasesBookPayload;
  currency: string;
}) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;
  const money = (cents: number) => formatMoney(cents, { currency, locale });

  return (
    <>
      <div className="bg-op-surface border border-op-border rounded-2xl overflow-hidden">
        <div className="px-4 py-3 border-b border-op-border flex items-center justify-between gap-3">
          <span className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted">
            {t("bookReceivedTotal")}
          </span>
          <span className="font-display text-2xl tabular-nums">
            {money(data.totals.receivedCents)}
          </span>
        </div>
        <div className="px-4 py-2.5 space-y-1">
          <SummaryLine
            label={t("unpaidTotalLabel")}
            value={money(data.totals.unpaidCents)}
          />
          <div className="text-[11px] text-op-muted">
            {t("bookPurchasesCount", { count: data.totals.count })}
          </div>
        </div>
      </div>

      {data.rows.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-op-border bg-op-surface/50 p-8 text-center text-sm text-op-muted">
          {t("bookPurchasesEmpty")}
        </div>
      ) : (
        <div className="bg-op-surface border border-op-border rounded-2xl overflow-hidden">
          {data.rows.map((r) => {
            const overdue =
              !r.paidAt &&
              r.invoiceDueAt !== null &&
              new Date(r.invoiceDueAt).getTime() < NOW_MS;
            return (
              <div
                key={r.id}
                className="px-4 py-2.5 border-b border-op-border last:border-b-0"
              >
                <div className="flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-sm font-medium shrink-0">
                        {t("poNumber", {
                          number: String(r.number).padStart(4, "0"),
                        })}
                      </span>
                      <span className="text-sm text-op-muted truncate">
                        {r.supplierName}
                      </span>
                    </div>
                    <div className="text-[11px] mt-0.5 truncate">
                      <span className="text-op-muted">
                        {formatDate(r.receivedAt, {
                          locale,
                          timeStyle: undefined,
                        })}
                        {" · "}
                        {r.supplierInvoiceNumber
                          ? t("invoiceLabel", {
                              number: r.supplierInvoiceNumber,
                            })
                          : t("noInvoiceNumber")}
                      </span>
                      {r.invoiceDueAt !== null && (
                        <span
                          className={
                            overdue
                              ? "text-danger font-medium"
                              : "text-op-muted"
                          }
                        >
                          {" · "}
                          {t("dueLabel", {
                            date: formatDate(r.invoiceDueAt, {
                              locale,
                              timeStyle: undefined,
                            }),
                          })}
                          {overdue && ` · ${t("overdueLabel")}`}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-sm font-medium tabular-nums">
                      {money(r.receivedCents)}
                    </div>
                    <span
                      className={
                        "px-2 h-5 inline-flex items-center rounded-full text-[10px] font-medium mt-0.5 " +
                        (r.paidAt
                          ? "bg-ok/10 text-[#1E5339]"
                          : "bg-[#C98A2E]/10 text-[#7F5A1F]")
                      }
                    >
                      {r.paidAt ? t("bookPaidBadge") : t("bookUnpaidBadge")}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

/* ─────────────────── Plantillas recurrentes (D2) ───────────────────── */

/**
 * Sección colapsable con las plantillas de gasto recurrente. Cerrada por
 * defecto (mismo criterio que las alzas de precio en Recetas): son
 * configuración, no el movimiento del mes.
 */
function TemplatesSection({
  templates,
  currency,
  onOpen,
}: {
  templates: ExpenseDto[];
  currency: string;
  onOpen: (e: ExpenseDto) => void;
}) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;
  const [open, setOpen] = useState(false);

  return (
    <section className="bg-op-surface border border-op-border rounded-2xl overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full min-h-[44px] px-4 py-2.5 flex items-center justify-between gap-3 text-left hover:bg-op-bg"
      >
        <span className="text-sm font-medium">
          {t("expenseTemplatesTitle", { count: templates.length })}
        </span>
        <span className="text-xs text-op-muted shrink-0" aria-hidden>
          {open ? "▾" : "▸"}
        </span>
      </button>

      {open &&
        templates.map((e) => (
          <button
            key={e.id}
            type="button"
            onClick={() => onOpen(e)}
            className="w-full text-left px-4 py-2.5 border-t border-op-border hover:bg-op-bg"
          >
            <div className="flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-sm font-medium truncate">
                    {e.category}
                  </span>
                  <span className="px-2 h-5 inline-flex items-center rounded-full bg-paper text-op-muted text-[10px] font-medium shrink-0">
                    {t("recurringBadge")}
                  </span>
                </div>
                <div className="text-[11px] text-op-muted mt-0.5 truncate">
                  {[e.description, e.supplier?.name]
                    .filter(Boolean)
                    .join(" · ")}
                </div>
              </div>
              <div className="text-right shrink-0">
                <div className="text-sm font-medium tabular-nums">
                  {formatMoney(e.amountCents, { currency, locale })}
                </div>
                <div className="text-[11px] text-op-muted mt-0.5">
                  {t("recurringEveryMonth", { day: e.recurringDay ?? 1 })}
                </div>
              </div>
            </div>
          </button>
        ))}
    </section>
  );
}

/* ──────────────── Crear/editar gasto (sheet) ───────────────────────── */

function ExpenseSheet({
  expense,
  suppliers,
  suppliersEnabled,
  categories,
  onClose,
  onChanged,
  onSupplierCreated,
}: {
  /** null = crear. */
  expense: ExpenseDto | null;
  suppliers: SupplierRef[];
  /** Módulo purchasing activo: ofrecer el campo/alta aunque no haya proveedores. */
  suppliersEnabled?: boolean;
  categories: string[];
  onClose: () => void;
  onChanged: () => void;
  /** Un proveedor creado inline sube al padre para persistir en la lista. */
  onSupplierCreated?: (s: SupplierRef) => void;
}) {
  const t = useTranslations("opErp");

  // Proveedores creados inline en esta sesión del sheet: se muestran en el
  // select de inmediato (el prop `suppliers` solo se refresca en el padre).
  const [localSuppliers, setLocalSuppliers] = useState<SupplierRef[]>([]);
  const [creatingSupplier, setCreatingSupplier] = useState(false);

  const [category, setCategory] = useState(expense?.category ?? "");
  const [description, setDescription] = useState(expense?.description ?? "");
  // Monto en unidades de moneda (pesos) — el API habla en centavos (×100).
  const [amountRaw, setAmountRaw] = useState(
    expense ? String(expense.amountCents / 100) : "",
  );
  const [date, setDate] = useState(
    expense ? isoToDateInput(expense.date) : todayDateInput(),
  );
  const [supplierId, setSupplierId] = useState(expense?.supplierId ?? "");
  const [recurring, setRecurring] = useState(expense?.recurring ?? false);
  const [dayRaw, setDayRaw] = useState(
    expense?.recurringDay != null ? String(expense.recurringDay) : "",
  );
  const [busy, setBusy] = useState(false);
  const [deletingBusy, setDeletingBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // El gasto puede referenciar un proveedor que ya no está en el catálogo
  // (o purchasing apagado → lista vacía): se agrega como opción para no
  // perder la referencia al editar. Los creados inline se anteponen.
  const supplierOptions = useMemo(() => {
    const seen = new Set<string>();
    const out: SupplierRef[] = [];
    const push = (s: SupplierRef) => {
      if (seen.has(s.id)) return;
      seen.add(s.id);
      out.push(s);
    };
    localSuppliers.forEach(push);
    if (expense?.supplier) push(expense.supplier);
    suppliers.forEach(push);
    return out;
  }, [expense, suppliers, localSuppliers]);

  // Proveedor creado inline: queda elegido, visible en el select y sube al
  // padre para persistir fuera del sheet.
  function handleSupplierCreated(s: SupplierRef) {
    setLocalSuppliers((prev) => [s, ...prev.filter((p) => p.id !== s.id)]);
    setSupplierId(s.id);
    setCreatingSupplier(false);
    onSupplierCreated?.(s);
  }

  async function save() {
    setErr(null);
    const cat = category.trim();
    if (!cat) {
      setErr(t("errExpenseInvalid"));
      return;
    }
    const pesos = Number(amountRaw.replace(",", "."));
    const amountCents = isFinite(pesos) ? pesosToCents(pesos) : 0;
    if (amountCents < 1) {
      setErr(t("errAmountInvalid"));
      return;
    }
    if (!date) {
      setErr(t("errExpenseInvalid"));
      return;
    }
    const day = Number(dayRaw);
    if (recurring && (!Number.isInteger(day) || day < 1 || day > 28)) {
      setErr(t("errRecurringDayRequired"));
      return;
    }
    // recurringDay: null explícito al apagar recurrente — el PATCH valida
    // el estado resultante (existente + parche) y un día huérfano es 400.
    const body = {
      category: cat,
      description: description.trim() || null,
      amountCents,
      date: dateInputToIso(date),
      supplierId: supplierId || null,
      recurring,
      recurringDay: recurring ? day : null,
    };
    setBusy(true);
    const r = await fetch(
      expense ? `/api/operator/expenses/${expense.id}` : "/api/operator/expenses",
      {
        method: expense ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    setBusy(false);
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      const key = API_ERROR_KEYS[(j as { error?: string }).error ?? ""];
      setErr(key ? t(key) : t("errSaveFailed"));
      return;
    }
    onChanged();
  }

  // Borrar plantilla: las copias ya materializadas quedan (contrato del
  // API) — el confirm lo aclara. Confirm nativo, patrón compras/recetas.
  async function remove() {
    if (!expense) return;
    const msg = expense.recurring
      ? t("confirmDeleteExpenseTemplate")
      : t("confirmDeleteExpense");
    if (!window.confirm(msg)) return;
    setErr(null);
    setDeletingBusy(true);
    const r = await fetch(`/api/operator/expenses/${expense.id}`, {
      method: "DELETE",
    });
    setDeletingBusy(false);
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      const key = API_ERROR_KEYS[(j as { error?: string }).error ?? ""];
      setErr(key ? t(key) : t("errSaveFailed"));
      return;
    }
    onChanged();
  }

  const anyBusy = busy || deletingBusy;

  return (
    <div
      className="fixed inset-0 z-50 bg-ink/40 flex items-end md:items-center justify-center p-0 md:p-6"
      onClick={onClose}
    >
      <div
        className="w-full md:max-w-xl bg-op-surface rounded-t-3xl md:rounded-3xl border border-op-border p-5 max-h-[92dvh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 mb-4">
          <h2 className="font-display text-2xl">
            {expense ? t("editExpense") : t("newExpense")}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-op-muted text-sm shrink-0 min-h-[44px] min-w-[44px] -mt-2 -mr-2"
            aria-label={t("cancel")}
          >
            {"✕"}
          </button>
        </div>

        <div className="space-y-3">
          <Field label={t("fieldCategory")} required>
            <input
              type="text"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder={t("expenseCategoryPlaceholder")}
              maxLength={60}
              list="expense-categories"
              className={inputCls}
            />
            <datalist id="expense-categories">
              {categories.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </Field>

          <Field label={t("fieldDescription")}>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={300}
              className={inputCls}
            />
          </Field>

          <Field label={t("fieldAmount")} required>
            <input
              type="number"
              min={0}
              step="any"
              inputMode="decimal"
              value={amountRaw}
              onChange={(e) => setAmountRaw(e.target.value)}
              className={inputCls}
            />
          </Field>

          <Field label={t("fieldDate")} required>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className={inputCls}
            />
          </Field>

          {(suppliersEnabled || supplierOptions.length > 0) && (
            <Field label={t("fieldSupplier")}>
              <select
                value={supplierId}
                onChange={(e) => setSupplierId(e.target.value)}
                className={inputCls}
              >
                <option value="">{t("supplierNone")}</option>
                {supplierOptions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              {creatingSupplier ? (
                <SupplierInlineForm
                  onCreated={handleSupplierCreated}
                  onCancel={() => setCreatingSupplier(false)}
                />
              ) : (
                <button
                  type="button"
                  onClick={() => setCreatingSupplier(true)}
                  className="mt-1.5 text-[11px] font-medium text-op-muted hover:text-ink"
                >
                  {t("createSupplierInline")}
                </button>
              )}
            </Field>
          )}

          <label className="flex items-center gap-2 min-h-[44px] cursor-pointer">
            <input
              type="checkbox"
              checked={recurring}
              onChange={(e) => setRecurring(e.target.checked)}
              className="w-4 h-4 accent-ink"
            />
            <span className="text-sm">{t("recurringToggle")}</span>
          </label>

          {recurring && (
            <Field
              label={t("fieldRecurringDay")}
              required
              hint={t("recurringDayHint")}
            >
              <input
                type="number"
                min={1}
                max={28}
                step={1}
                inputMode="numeric"
                value={dayRaw}
                onChange={(e) => setDayRaw(e.target.value)}
                className={inputCls}
              />
            </Field>
          )}

          {err && <div className="text-xs text-danger">{err}</div>}

          <div className="flex items-center gap-3 pt-1">
            {expense && (
              <button
                type="button"
                onClick={remove}
                disabled={anyBusy}
                className="min-h-[44px] px-3 rounded-full text-[11px] font-medium text-danger hover:bg-danger/10 disabled:opacity-40"
              >
                {deletingBusy ? t("deleting") : t("deleteItem")}
              </button>
            )}
            <div className="flex-1" />
            <button
              type="button"
              onClick={onClose}
              className="min-h-[44px] px-4 rounded-full bg-op-bg border border-op-border text-sm font-medium hover:bg-op-surface"
            >
              {t("cancel")}
            </button>
            <button
              type="button"
              onClick={save}
              disabled={anyBusy || category.trim() === "" || amountRaw.trim() === ""}
              className="min-h-[44px] px-5 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-40"
            >
              {busy ? t("saving") : t("save")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─────────────── Crear proveedor inline (mini-form) ────────────────── */

/**
 * Mini-form colapsable para dar de alta un proveedor sin salir del sheet
 * de gasto: Nombre (req.), NIT (opc.) y plazo de pago en días (opc.). Al
 * crear, entrega el proveedor devuelto por el API al `onCreated` del padre.
 */
function SupplierInlineForm({
  onCreated,
  onCancel,
}: {
  onCreated: (s: SupplierRef) => void;
  onCancel: () => void;
}) {
  const t = useTranslations("opErp");
  const [name, setName] = useState("");
  const [taxId, setTaxId] = useState("");
  const [termsRaw, setTermsRaw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function create() {
    const trimmed = name.trim();
    if (!trimmed) {
      setErr(t("errExpenseInvalid"));
      return;
    }
    const terms = termsRaw.trim();
    const paymentTermsDays = terms === "" ? undefined : Number(terms);
    if (
      paymentTermsDays !== undefined &&
      (!Number.isInteger(paymentTermsDays) ||
        paymentTermsDays < 0 ||
        paymentTermsDays > 365)
    ) {
      setErr(t("errExpenseInvalid"));
      return;
    }
    setErr(null);
    setBusy(true);
    const r = await fetch("/api/operator/suppliers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: trimmed,
        taxId: taxId.trim() || undefined,
        paymentTermsDays,
      }),
    });
    setBusy(false);
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      setErr(
        (j as { error?: string }).error === "name_taken"
          ? t("errSupplierNameTaken")
          : t("errSaveFailed"),
      );
      return;
    }
    const j = (await r.json()) as { supplier: SupplierRef };
    onCreated({ id: j.supplier.id, name: j.supplier.name });
  }

  return (
    <div className="mt-2 rounded-xl border border-op-border bg-op-bg/50 p-3 space-y-2">
      <Field label={t("fieldName")} required>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("supplierNamePlaceholder")}
          maxLength={120}
          className={inputCls}
        />
      </Field>
      <Field label={t("fieldTaxId")}>
        <input
          type="text"
          value={taxId}
          onChange={(e) => setTaxId(e.target.value)}
          placeholder={t("taxIdPlaceholder")}
          className={inputCls}
        />
      </Field>
      <Field label={t("fieldPaymentTerms")} hint={t("paymentTermsHint")}>
        <input
          type="number"
          min={0}
          max={365}
          step={1}
          inputMode="numeric"
          value={termsRaw}
          onChange={(e) => setTermsRaw(e.target.value)}
          className={inputCls}
        />
      </Field>
      {err && <div className="text-xs text-danger">{err}</div>}
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="min-h-[40px] px-3 rounded-full bg-op-bg border border-op-border text-[11px] font-medium hover:bg-op-surface"
        >
          {t("cancel")}
        </button>
        <button
          type="button"
          onClick={create}
          disabled={busy || name.trim() === ""}
          className="min-h-[40px] px-4 rounded-full bg-ink text-bone text-[11px] font-medium disabled:opacity-40"
        >
          {busy ? t("saving") : t("inlineCreate")}
        </button>
      </div>
    </div>
  );
}

/* ────────────────────────────── UI compartida ──────────────────────── */

function Field({
  label,
  required,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted mb-1">
        {label}
        {required && <span className="text-danger ml-1">{"*"}</span>}
      </div>
      {children}
      {hint && <div className="text-[10px] text-op-muted mt-1">{hint}</div>}
    </label>
  );
}

const inputCls =
  "w-full min-h-[44px] px-3 rounded-lg border border-op-border bg-op-bg text-sm focus:outline-none focus:border-op-text/40";
