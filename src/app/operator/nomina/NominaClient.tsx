"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { formatMoney, localeTag } from "@/lib/format";
import type { Locale } from "@/i18n/config";

type Item = {
  conceptKey: string;
  conceptLabel: string;
  kind: string;
  amountCents: number;
};
type EmployeeLiq = {
  employeeId: string;
  employeeName: string;
  items: Item[];
  totalDevengadoCents: number;
  totalDeduccionesCents: number;
  netoCents: number;
  totalEmpleadorCents: number;
};
type RunDto = {
  exists: boolean;
  employees: EmployeeLiq[];
  totals: {
    devengadoCents: number;
    deduccionesCents: number;
    netoCents: number;
    empleadorCents: number;
    costoTotalCents: number;
  };
};
type CatalogRow = {
  key: string;
  label: string;
  value: number;
  kind: "valor" | "porcentaje";
};

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}
function shiftMonth(m: string, delta: number): string {
  const [y, mo] = m.split("-").map(Number);
  const d = new Date(Date.UTC(y, mo - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

/** Traducción de conceptos conocidos; los desconocidos usan su label guardado. */
const CONCEPT_KEY: Record<string, string> = {
  salario: "pcSalario",
  recargos: "pcRecargos",
  aux_transporte: "pcAux",
  salud_empleado: "pcSaludEmp",
  pension_empleado: "pcPensionEmp",
  salud_empleador: "pcSaludPat",
  pension_empleador: "pcPensionPat",
  arl: "pcArl",
  caja_compensacion: "pcCaja",
  icbf: "pcIcbf",
  sena: "pcSena",
  cesantias: "pcCesantias",
  intereses_cesantias: "pcInteresesCes",
  prima: "pcPrima",
  vacaciones: "pcVacaciones",
};

export function NominaClient({ currency }: { currency: string }) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;
  const [month, setMonth] = useState(currentMonth);
  const [data, setData] = useState<{
    run: RunDto;
    params: Record<string, number>;
    catalog: CatalogRow[];
  } | null>(null);
  const [err, setErr] = useState(false);
  const [busy, setBusy] = useState(false);
  const [paramsOpen, setParamsOpen] = useState(false);
  const [openEmp, setOpenEmp] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/operator/payroll?month=${month}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("load"))))
      .then((j) => {
        if (alive) setData({ run: j.run, params: j.params, catalog: j.catalog });
      })
      .catch(() => {
        if (alive) setErr(true);
      });
    return () => {
      alive = false;
    };
  }, [month]);

  const money = (c: number) => formatMoney(c, { currency, locale });
  const cLabel = (it: Item) => {
    const key = CONCEPT_KEY[it.conceptKey];
    return key ? t(key) : it.conceptLabel;
  };

  async function generate() {
    setBusy(true);
    setErr(false);
    try {
      const r = await fetch(`/api/operator/payroll?month=${month}`, {
        method: "POST",
      });
      if (!r.ok) throw new Error("gen");
      const j = await r.json();
      setData((d) => (d ? { ...d, run: j.run } : d));
    } catch {
      setErr(true);
    }
    setBusy(false);
  }

  const monthLabel = new Date(`${month}-15T00:00:00Z`).toLocaleDateString(
    localeTag(locale),
    { month: "long", year: "numeric", timeZone: "UTC" },
  );

  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-display text-2xl lg:text-3xl">{t("payrollTitle")}</h1>
        <p className="mt-1 text-sm text-op-muted">{t("payrollIntro")}</p>
      </div>

      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setMonth((m) => shiftMonth(m, -1))}
          aria-label={t("monthPrev")}
          className="mp-icobtn text-sm"
        >
          {"◀"}
        </button>
        <div className="text-sm font-medium">{monthLabel}</div>
        <button
          type="button"
          onClick={() => setMonth((m) => shiftMonth(m, 1))}
          aria-label={t("monthNext")}
          className="mp-icobtn text-sm"
        >
          {"▶"}
        </button>
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={generate}
          disabled={busy}
          className="mp-btn mp-btn--primary flex-1"
        >
          {busy ? t("payrollGenerating") : t("payrollGenerate")}
        </button>
        <button
          type="button"
          onClick={() => setParamsOpen(true)}
          className="mp-btn mp-btn--secondary"
        >
          {t("payrollParams")}
        </button>
      </div>

      {err ? (
        <div className="text-sm text-danger">{t("payrollError")}</div>
      ) : data === null ? (
        <div className="text-sm text-op-muted">{t("loadingEllipsis")}</div>
      ) : !data.run.exists ? (
        <div className="rounded-2xl border border-dashed border-op-border bg-op-surface/50 p-8 text-center">
          <p className="text-sm text-op-muted">{t("payrollEmpty")}</p>
        </div>
      ) : (
        <>
          {/* Totales */}
          <div className="grid grid-cols-2 gap-2">
            <Stat label={t("payrollNeto")} value={money(data.run.totals.netoCents)} />
            <Stat
              label={t("payrollCostoTotal")}
              value={money(data.run.totals.costoTotalCents)}
            />
            <Stat
              label={t("payrollDevengado")}
              value={money(data.run.totals.devengadoCents)}
            />
            <Stat
              label={t("payrollEmpleador")}
              value={money(data.run.totals.empleadorCents)}
            />
          </div>

          {/* Empleados */}
          <div className="space-y-2">
            {data.run.employees.map((e) => {
              const open = openEmp === e.employeeId;
              return (
                <div
                  key={e.employeeId}
                  className="rounded-2xl border border-op-border bg-op-surface overflow-hidden"
                >
                  <button
                    type="button"
                    onClick={() => setOpenEmp(open ? null : e.employeeId)}
                    className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
                    aria-expanded={open}
                  >
                    <span className="min-w-0 truncate text-sm font-medium">
                      {e.employeeName}
                    </span>
                    <span className="shrink-0 font-mono tabular text-sm">
                      {money(e.netoCents)}
                    </span>
                  </button>
                  {open && (
                    <div className="border-t border-op-border px-4 py-2">
                      {(
                        [
                          ["devengado", t("payrollKDevengados")],
                          ["deduccion", t("payrollKDeducciones")],
                          ["aporte_empleador", t("payrollKAportes")],
                          ["provision", t("payrollKProvisiones")],
                        ] as const
                      ).map(([kind, label]) => {
                        const items = e.items.filter((i) => i.kind === kind);
                        if (items.length === 0) return null;
                        return (
                          <div key={kind} className="py-1.5">
                            <div className="font-mono text-[9px] uppercase tracking-[0.14em] text-op-muted">
                              {label}
                            </div>
                            {items.map((it) => (
                              <div
                                key={it.conceptKey}
                                className="flex items-baseline justify-between gap-3 py-0.5 text-sm"
                              >
                                <span className="min-w-0 truncate text-op-muted">
                                  {cLabel(it)}
                                </span>
                                <span className="shrink-0 font-mono tabular">
                                  {money(it.amountCents)}
                                </span>
                              </div>
                            ))}
                          </div>
                        );
                      })}
                      <div className="flex items-baseline justify-between gap-3 border-t border-op-border/60 py-2 text-sm font-medium">
                        <span>{t("payrollNetoEmp")}</span>
                        <span className="font-mono tabular">{money(e.netoCents)}</span>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      <p className="text-[11px] text-op-muted">{t("payrollDisclaimer")}</p>

      {paramsOpen && data && (
        <ParamsSheet
          params={data.params}
          catalog={data.catalog}
          onClose={() => setParamsOpen(false)}
          onSaved={(p) => {
            setData((d) => (d ? { ...d, params: p } : d));
            setParamsOpen(false);
          }}
        />
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-op-border bg-op-surface p-3">
      <div className="font-mono text-[9px] uppercase tracking-[0.14em] text-op-muted">
        {label}
      </div>
      <div className="mt-0.5 font-display text-lg tabular">{value}</div>
    </div>
  );
}

/** Sheet de parámetros: catálogo CO 2026 con valores editables. */
function ParamsSheet({
  params,
  catalog,
  onClose,
  onSaved,
}: {
  params: Record<string, number>;
  catalog: CatalogRow[];
  onClose: () => void;
  onSaved: (p: Record<string, number>) => void;
}) {
  const t = useTranslations("opErp");
  const [values, setValues] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const c of catalog) out[c.key] = String(params[c.key] ?? c.value);
    return out;
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(false);

  async function save() {
    const parsedEntries: Record<string, number> = {};
    for (const [k, v] of Object.entries(values)) {
      const n = Number(v);
      if (!Number.isFinite(n)) continue;
      parsedEntries[k] = n;
    }
    setBusy(true);
    setErr(false);
    try {
      const r = await fetch("/api/operator/payroll", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ params: parsedEntries }),
      });
      if (!r.ok) throw new Error("save");
      onSaved(parsedEntries);
    } catch {
      setErr(true);
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-ink/40 p-0 md:items-center md:p-6"
      onClick={() => !busy && onClose()}
    >
      <div
        className="max-h-[90dvh] w-full overflow-y-auto rounded-t-3xl border border-op-border bg-op-surface p-5 md:max-w-md md:rounded-3xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="font-display text-2xl">{t("payrollParams")}</h2>
        <p className="mt-1 text-xs text-op-muted">{t("payrollParamsIntro")}</p>
        <div className="mt-3 space-y-2">
          {catalog.map((c) => (
            <label key={c.key} className="flex items-center gap-3">
              <span className="min-w-0 flex-1 truncate text-sm">{c.label}</span>
              <span className="relative shrink-0">
                <input
                  inputMode="decimal"
                  value={values[c.key] ?? ""}
                  onChange={(e) =>
                    setValues((v) => ({ ...v, [c.key]: e.target.value }))
                  }
                  aria-label={c.label}
                  className="h-10 w-32 rounded-lg border border-op-border bg-op-bg px-3 pr-7 text-right text-sm tabular focus:outline-none focus:border-op-text/40"
                />
                <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs text-op-muted">
                  {c.kind === "porcentaje" ? "%" : "$"}
                </span>
              </span>
            </label>
          ))}
        </div>
        {err && <div className="mt-2 text-sm text-danger">{t("payrollError")}</div>}
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="mp-btn mp-btn--secondary flex-1"
          >
            {t("payrollCancel")}
          </button>
          <button
            type="button"
            onClick={save}
            disabled={busy}
            className="mp-btn mp-btn--primary flex-1"
          >
            {busy ? t("payrollSaving") : t("payrollSave")}
          </button>
        </div>
      </div>
    </div>
  );
}
