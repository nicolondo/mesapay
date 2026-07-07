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
  // Se incrementa para re-fetchear el mes tras guardar/borrar: un gasto
  // editado puede salir del mes, y una plantilla nueva cambia ambas listas.
  const [reloadSeq, setReloadSeq] = useState(0);
  // null = cerrado · "new" = crear · dto = editar (gasto o plantilla).
  const [open, setOpen] = useState<ExpenseDto | "new" | null>(null);

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
  }

  return (
    <div className="space-y-4">
      {/* Segmentos Gastos / P&L / Libros (P&L y Libros llegan en B2.4) */}
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

      {tab !== "expenses" ? (
        // Placeholder neutro — el PR B2.4 lo reemplaza por P&L y Libros.
        <div className="rounded-2xl border border-dashed border-op-border bg-op-surface/50 p-8 text-center text-sm text-op-muted">
          {t("accountingTabEmpty")}
        </div>
      ) : (
        <>
          {/* Selector de mes: ◀ Julio de 2026 ▶ — alimenta el GET */}
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
          categories={data?.categories ?? []}
          onClose={() => setOpen(null)}
          onChanged={handleChanged}
        />
      )}
    </div>
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
  categories,
  onClose,
  onChanged,
}: {
  /** null = crear. */
  expense: ExpenseDto | null;
  suppliers: SupplierRef[];
  categories: string[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const t = useTranslations("opErp");

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
  // perder la referencia al editar.
  const supplierOptions = useMemo(() => {
    if (
      expense?.supplier &&
      !suppliers.some((s) => s.id === expense.supplier!.id)
    ) {
      return [expense.supplier, ...suppliers];
    }
    return suppliers;
  }, [expense, suppliers]);

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

          {supplierOptions.length > 0 && (
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
