"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { formatMoney } from "@/lib/format";
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

      <p className="text-[11px] text-op-muted">{t("fiscalDisclaimer")}</p>
    </div>
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
