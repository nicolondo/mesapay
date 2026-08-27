"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { formatMoney } from "@/lib/format";
import { MoneyInput } from "@/components/MoneyInput";
import type { Locale } from "@/i18n/config";

type Tax = {
  salesKind: string;
  salesPct: number;
  salesBaseCents: number;
  ivaGeneradoCents: number;
  incGeneradoCents: number;
  ivaDescontableCents: number;
  ivaAPagarCents: number;
  incAPagarCents: number;
  purchaseIncCents: number;
  retefuenteCents: number;
  reteIvaCents: number;
  reteIcaCents: number;
};
type Closing = {
  year: string;
  exists: boolean;
  dateISO: string | null;
  resultCents: number;
  kind: string;
};

/**
 * Impuestos del mes (IVA/INC a pagar, retenciones) + cierre del ejercicio
 * (asiento que cancela resultado a patrimonio). Fase 4.
 */
export function ImpuestosTab({
  month,
  currency,
}: {
  month: string;
  currency: string;
}) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;
  const [data, setData] = useState<{
    tax: Tax;
    closing: Closing;
    year: string;
  } | null>(null);
  const [err, setErr] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch(`/api/operator/accounting/fiscal?month=${month}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("load"))))
      .then((j) => {
        if (alive) setData({ tax: j.tax, closing: j.closing, year: j.year });
      })
      .catch(() => {
        if (alive) setErr(true);
      });
    return () => {
      alive = false;
    };
  }, [month]);

  const money = (c: number) => formatMoney(c, { currency, locale });

  async function closeYear() {
    if (!data) return;
    setBusy(true);
    setErr(false);
    try {
      const r = await fetch(
        `/api/operator/accounting/fiscal?year=${data.year}`,
        { method: "POST" },
      );
      if (!r.ok) throw new Error("gen");
      const j = await r.json();
      setData((d) => (d ? { ...d, closing: j.closing } : d));
    } catch {
      setErr(true);
    }
    setBusy(false);
  }

  if (err) return <div className="text-sm text-danger">{t("fiscalError")}</div>;
  if (!data) return <div className="text-sm text-op-muted">{t("loadingEllipsis")}</div>;

  const { tax, closing } = data;

  return (
    <div className="space-y-4">
      <Section title={t("fiscalTaxTitle")}>
        {tax.salesKind === "iva" ? (
          <>
            <Row label={t("fiscalIvaGen")} value={money(tax.ivaGeneradoCents)} />
            <Row
              label={t("fiscalIvaDesc")}
              value={money(-tax.ivaDescontableCents)}
            />
            <Row
              label={t("fiscalIvaPagar")}
              value={money(tax.ivaAPagarCents)}
              strong
            />
          </>
        ) : tax.salesKind === "inc" ? (
          <Row
            label={t("fiscalIncPagar")}
            value={money(tax.incAPagarCents)}
            strong
          />
        ) : (
          <div className="px-4 py-2 text-sm text-op-muted">
            {t("fiscalNoTax")}
          </div>
        )}
        <div className="px-4 pb-1 pt-3 font-mono text-[10px] uppercase tracking-[0.14em] text-op-muted">
          {t("fiscalRet")}
        </div>
        <Row label={t("fiscalRetefuente")} value={money(tax.retefuenteCents)} />
        <Row label={t("fiscalReteIva")} value={money(tax.reteIvaCents)} />
        <Row label={t("fiscalReteIca")} value={money(tax.reteIcaCents)} />
      </Section>

      <Section title={t("fiscalClosingTitle", { year: data.year })}>
        {closing.exists ? (
          <div className="px-4 py-2 text-sm">
            <div className="text-op-muted">{t("fiscalClosingDone")}</div>
            <div className="mt-1 font-medium">
              {(closing.kind === "perdida"
                ? t("fiscalLoss")
                : t("fiscalProfit")) +
                ": " +
                money(Math.abs(closing.resultCents))}
            </div>
          </div>
        ) : (
          <p className="px-4 py-2 text-sm text-op-muted">
            {t("fiscalClosingIntro")}
          </p>
        )}
        <div className="px-4 pb-3 pt-1">
          <button
            type="button"
            onClick={closeYear}
            disabled={busy}
            className="mp-btn mp-btn--secondary mp-btn--block"
          >
            {busy
              ? t("fiscalClosingBusy")
              : closing.exists
                ? t("fiscalClosingRegen")
                : t("fiscalClosingGen")}
          </button>
        </div>
      </Section>

      <DeclaracionesCard month={month} currency={currency} />

      <ExogenaCard month={month} currency={currency} />

      <RetencionesConfigCard currency={currency} />

      <p className="text-[11px] text-op-muted">{t("fiscalDisclaimer")}</p>
    </div>
  );
}

type Filing = {
  id: string;
  form: string;
  period: string;
  declaredCents: number;
  paidAt: string;
};

const FORM_KEYS: Record<string, string> = {
  iva: "filingFormIva",
  inc: "filingFormInc",
  retefuente: "filingFormRetefuente",
  ica: "filingFormIca",
};

/**
 * Declaraciones y pagos de impuestos del año: registrar el pago crea el
 * asiento (D cuenta del impuesto · C banco, fuente taxpay).
 */
function DeclaracionesCard({
  month,
  currency,
}: {
  month: string;
  currency: string;
}) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;
  const year = month.slice(0, 4);
  const [filings, setFilings] = useState<Filing[] | null>(null);
  const [form, setForm] = useState("iva");
  const [amountPesos, setAmountPesos] = useState("");
  const [paidDate, setPaidDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/operator/accounting/declaraciones?year=${year}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("load"))))
      .then((j) => {
        if (alive) setFilings(j.filings as Filing[]);
      })
      .catch(() => {
        if (alive) setFilings([]);
      });
    return () => {
      alive = false;
    };
  }, [year]);

  const money = (c: number) => formatMoney(c, { currency, locale });

  async function register() {
    const declaredCents = Number(amountPesos.replace(/\D/g, "")) * 100;
    if (!paidDate || declaredCents <= 0) return;
    setBusy(true);
    setMsg(null);
    const r = await fetch("/api/operator/accounting/declaraciones", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ form, period: month, declaredCents, paidDate }),
    });
    setBusy(false);
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      setMsg(
        j.error === "already_filed"
          ? t("filingAlready")
          : j.error === "month_closed"
            ? t("bankMonthClosed")
            : t("errSaveFailed"),
      );
      return;
    }
    setMsg(t("filingRegistered"));
    setAmountPesos("");
    const lr = await fetch(`/api/operator/accounting/declaraciones?year=${year}`);
    if (lr.ok) setFilings((await lr.json()).filings as Filing[]);
  }

  return (
    <Section title={t("filingsTitle")}>
      <div className="p-4 space-y-3">
        <p className="text-xs text-op-muted">{t("filingsIntro")}</p>
        <div className="grid grid-cols-3 gap-2">
          <select
            value={form}
            onChange={(e) => setForm(e.target.value)}
            aria-label={t("filingForm")}
            className="min-h-[40px] px-2 rounded-lg border border-op-border bg-op-bg text-sm"
          >
            {Object.entries(FORM_KEYS).map(([v, k]) => (
              <option key={v} value={v}>
                {t(k)}
              </option>
            ))}
          </select>
          <MoneyInput
            value={amountPesos}
            onChange={setAmountPesos}
            ariaLabel={t("filingAmount")}
            placeholder={t("filingAmount")}
            className="min-h-[40px] px-2 rounded-lg border border-op-border bg-op-bg text-sm text-right"
          />
          <input
            type="date"
            value={paidDate}
            onChange={(e) => setPaidDate(e.target.value)}
            aria-label={t("filingPaidDate")}
            className="min-h-[40px] px-2 rounded-lg border border-op-border bg-op-bg text-sm"
          />
        </div>
        <button
          type="button"
          onClick={register}
          disabled={busy || !paidDate || amountPesos.trim() === ""}
          className="mp-btn mp-btn--secondary mp-btn--block"
        >
          {busy ? t("saving") : t("filingRegister", { month })}
        </button>
        {msg && <p className="text-xs text-op-muted">{msg}</p>}
        {filings && filings.length > 0 && (
          <div className="divide-y divide-op-border/60 border-t border-op-border/60">
            {filings.map((f) => (
              <div
                key={f.id}
                className="flex items-center justify-between gap-3 py-1.5 text-sm"
              >
                <span className="min-w-0 truncate">
                  {t(FORM_KEYS[f.form] ?? "filingFormIva")}{" "}
                  <span className="font-mono text-xs text-op-muted">
                    {f.period}
                  </span>
                </span>
                <span className="font-mono tabular shrink-0">
                  {money(f.declaredCents)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </Section>
  );
}

type ExoIssue = { name: string; reason: string; pagoPesos: number };

/** Exógena (formato 1001): resumen del año + descarga TXT + issues de NIT. */
function ExogenaCard({
  month,
  currency,
}: {
  month: string;
  currency: string;
}) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;
  const year = month.slice(0, 4);
  const [data, setData] = useState<{
    rowCount: number;
    totalPagoPesos: number;
    issues: ExoIssue[];
  } | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/operator/accounting/exogena?year=${year}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("load"))))
      .then((j) => {
        if (alive)
          setData({
            rowCount: (j.rows as unknown[]).length,
            totalPagoPesos: j.totalPagoPesos as number,
            issues: j.issues as ExoIssue[],
          });
      })
      .catch(() => {
        if (alive) setData({ rowCount: 0, totalPagoPesos: 0, issues: [] });
      });
    return () => {
      alive = false;
    };
  }, [year]);

  const money = (pesos: number) =>
    formatMoney(pesos * 100, { currency, locale });

  return (
    <Section title={t("exogenaTitle", { year })}>
      <div className="p-4 space-y-3">
        <p className="text-xs text-op-muted">{t("exogenaIntro")}</p>
        {data === null ? (
          <div className="text-sm text-op-muted">{t("loadingEllipsis")}</div>
        ) : (
          <>
            <div className="flex items-baseline justify-between text-sm">
              <span>
                {t("exogenaSummary", { count: data.rowCount })}
              </span>
              <span className="font-mono tabular">
                {money(data.totalPagoPesos)}
              </span>
            </div>
            {data.issues.length > 0 && (
              <div className="rounded-lg bg-danger/10 border border-danger/25 p-2.5 space-y-1">
                <div className="text-xs font-medium text-danger">
                  {t("exogenaIssues", { count: data.issues.length })}
                </div>
                {data.issues.slice(0, 6).map((i, idx) => (
                  <div key={idx} className="text-[11px] text-op-muted truncate">
                    {i.name}
                    {" — "}
                    {i.reason === "missing_nit"
                      ? t("exogenaMissingNit")
                      : t("exogenaInvalidNit")}
                  </div>
                ))}
              </div>
            )}
            <a
              href={`/api/operator/accounting/exogena?year=${year}&format=txt`}
              download
              className="mp-btn mp-btn--secondary mp-btn--block"
            >
              {t("exogenaDownload")}
            </a>
          </>
        )}
      </div>
    </Section>
  );
}

type RetConcept = {
  id: string;
  kind: string;
  name: string;
  rateBps: number;
  base: string;
  thresholdUvt: number;
  accountCode: string;
  active: boolean;
};

/**
 * Conceptos de retención (retefuente/reteIVA/reteICA) del comercio + valor
 * UVT. El contador activa los que apliquen; los activos alimentan la
 * sugerencia automática en el formulario de compras.
 */
function RetencionesConfigCard({ currency }: { currency: string }) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;
  const [concepts, setConcepts] = useState<RetConcept[] | null>(null);
  const [uvtCents, setUvtCents] = useState<number | null>(null);
  const [uvtRaw, setUvtRaw] = useState("");
  const [err, setErr] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/operator/accounting/retenciones")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("load"))))
      .then((j) => {
        if (!alive) return;
        setConcepts(j.concepts as RetConcept[]);
        setUvtCents(j.uvtCents as number);
      })
      .catch(() => {
        if (alive) setErr(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  async function patch(body: Record<string, unknown>, busyKey: string) {
    setBusyId(busyKey);
    const r = await fetch("/api/operator/accounting/retenciones", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusyId(null);
    if (!r.ok) {
      setErr(true);
      return;
    }
    const j = await r.json();
    setConcepts(j.concepts as RetConcept[]);
    setUvtCents(j.uvtCents as number);
  }

  async function saveUvt() {
    const pesos = Number(uvtRaw.replace(/\D/g, ""));
    if (!pesos) return;
    await patch({ uvtCents: pesos * 100 }, "uvt");
    setUvtRaw("");
  }

  const fmtRate = (c: RetConcept) =>
    c.kind === "reteica"
      ? t("retRatePerMil", { rate: (c.rateBps / 10).toLocaleString(locale) })
      : t("retRatePct", { rate: (c.rateBps / 100).toLocaleString(locale) });

  return (
    <Section title={t("retTitle")}>
      <div className="p-4 space-y-3">
        <p className="text-xs text-op-muted">{t("retIntro")}</p>
        {err ? (
          <div className="text-sm text-danger">{t("errLoadFailed")}</div>
        ) : concepts === null ? (
          <div className="text-sm text-op-muted">{t("loadingEllipsis")}</div>
        ) : (
          <>
            <div className="divide-y divide-op-border/60 border-y border-op-border/60">
              {concepts.map((c) => (
                <div
                  key={c.id}
                  className="flex items-center justify-between gap-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="text-sm truncate">{c.name}</div>
                    <div className="text-[11px] text-op-muted">
                      {[
                        fmtRate(c),
                        c.base === "tax" ? t("retBaseTax") : t("retBaseSubtotal"),
                        c.thresholdUvt > 0
                          ? t("retThreshold", { uvt: c.thresholdUvt })
                          : t("retNoThreshold"),
                        c.accountCode,
                      ].join(" · ")}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      patch({ conceptId: c.id, active: !c.active }, c.id)
                    }
                    disabled={busyId === c.id}
                    aria-pressed={c.active}
                    className={
                      "px-3 h-8 rounded-full text-xs font-medium shrink-0 border " +
                      (c.active
                        ? "bg-ok/15 text-ok border-ok/30"
                        : "bg-op-bg text-op-muted border-op-border")
                    }
                  >
                    {c.active ? t("retActive") : t("retInactive")}
                  </button>
                </div>
              ))}
            </div>
            <div className="flex items-end gap-2">
              <label className="block flex-1">
                <span className="font-mono text-[10px] tracking-wider uppercase text-op-muted">
                  {t("retUvtLabel", {
                    current:
                      uvtCents != null
                        ? formatMoney(uvtCents, { currency, locale })
                        : "…",
                  })}
                </span>
                <input
                  inputMode="numeric"
                  value={uvtRaw}
                  onChange={(e) => setUvtRaw(e.target.value)}
                  placeholder={t("retUvtPlaceholder")}
                  className="mt-1 w-full min-h-[40px] px-3 rounded-lg border border-op-border bg-op-bg text-sm tabular"
                />
              </label>
              <button
                type="button"
                onClick={saveUvt}
                disabled={busyId === "uvt" || uvtRaw.trim() === ""}
                className="mp-btn mp-btn--secondary mp-btn--sm px-4"
              >
                {t("save")}
              </button>
            </div>
          </>
        )}
      </div>
    </Section>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-op-border bg-op-surface overflow-hidden">
      <div className="border-b border-op-border bg-op-bg px-4 py-2">
        <span className="font-display text-lg">{title}</span>
      </div>
      <div className="py-1">{children}</div>
    </div>
  );
}

function Row({
  label,
  value,
  strong = false,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <div
      className={
        "flex items-baseline justify-between gap-3 px-4 py-1.5 text-sm " +
        (strong ? "border-t border-op-border/60 font-medium" : "")
      }
    >
      <span>{label}</span>
      <span className="font-mono tabular">{value}</span>
    </div>
  );
}
