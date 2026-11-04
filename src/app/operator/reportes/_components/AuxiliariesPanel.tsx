"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import { formatDate, formatMoney } from "@/lib/format";
import { docHref, entryHref, type AuxRow } from "@/lib/erp/reports/auxRows";
import { makeRateLabel } from "@/lib/erp/reports/taxesLabels";
import { makeSourceLabel } from "@/lib/erp/reports/labels";
import { fmtIsoDate } from "./fmt";
import { cx } from "./ReportCards";
import { StatusIcon } from "./StatusBadge";

/**
 * AUXILIARES de un renglón (nivel 3), cargados al abrirlo desde la API
 * (`endpoint?…query&nodo=<id>&page=`), paginados de a `pageSize` para que
 * un mes grande no congele la pantalla. Reutilizable: cualquier reporte
 * cuyo endpoint devuelva filas `AuxRow` (documentos, líneas del libro o
 * días) lo usa igual.
 *
 *  · ESCRITORIO: tabla con las columnas de la clase de fila (documentos:
 *    fecha · documento · tercero (nombre + NIT) · base · tarifa · valor ·
 *    asiento; libro: fecha · comprobante · origen · cuenta · tercero ·
 *    movimiento; días: día · origen · documentos · esperado · libro ·
 *    diferencia · asiento).
 *  · CELULAR: lista apilada (una tarjeta por fila) con los mismos datos.
 *  · Debajo, la SUMA de todas las filas (no sólo de la página) frente a la
 *    cifra del renglón padre: cuadra ✓ o no cuadra (no debería pasar).
 *  · Enlaces: el número del documento abre el documento fuente; el
 *    comprobante abre el asiento del libro.
 *  · Descarga CSV / Excel de las filas del renglón.
 */
type AuxResponse = {
  kind: "docs" | "ledger" | "check";
  page: number;
  pages: number;
  size: number;
  total: number;
  totals: { count: number; amountCents: number; baseCents: number };
  rows: AuxRow[];
};

const TH = "px-3 py-2 font-mono text-[9px] uppercase tracking-wider font-normal";
const TD = "px-3 py-1.5 align-top";
const NUM = "px-3 py-1.5 text-right font-mono tabular whitespace-nowrap align-top";

function qs(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") sp.set(k, String(v));
  return sp.toString();
}

export function AuxiliariesPanel({
  endpoint,
  query,
  nodeId,
  currency,
  expectedCents,
  amountLabel,
  pageSize = 50,
}: {
  endpoint: string;
  /** Filtros de la página (desde, hasta…): los MISMOS del renglón. */
  query: Record<string, string>;
  nodeId: string;
  currency: string;
  /** Cifra del renglón padre: la suma de las filas debe ser exactamente esta. */
  expectedCents?: number | null;
  /** Rótulo de la columna de la cifra (Impuesto, Movimiento, Diferencia…). */
  amountLabel?: string;
  pageSize?: number;
}) {
  const t = useTranslations("opReportDrill");
  const tTax = useTranslations("opImpuestosRep");
  const tErp = useTranslations("opErp");
  const locale = useLocale() as Locale;
  const [page, setPage] = useState(1);
  const [attempt, setAttempt] = useState(0);
  // El resultado se guarda con la URL que lo pidió: al cambiar de página
  // (o reintentar) lo viejo deja de valer solo, sin limpiar estado en el efecto.
  const url = `${endpoint}?${qs({ ...query, nodo: nodeId, page, size: pageSize })}`;
  const reqKey = `${url}#${attempt}`;
  const [result, setResult] = useState<{ key: string; data?: AuxResponse; error?: boolean } | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    fetch(url, { signal: ctrl.signal })
      .then((r) => (r.ok ? (r.json() as Promise<AuxResponse>) : Promise.reject(new Error(String(r.status)))))
      .then((data) => setResult({ key: reqKey, data }))
      .catch((e: unknown) => {
        if ((e as { name?: string }).name !== "AbortError") setResult({ key: reqKey, error: true });
      });
    return () => ctrl.abort();
  }, [url, reqKey]);
  const current = result?.key === reqKey ? result : null;
  const data = current?.data ?? null;
  const error = current?.error ?? false;

  const money = useCallback((c: number) => formatMoney(c, { currency, locale }), [currency, locale]);
  const rate = makeRateLabel(tTax, locale);
  const sourceLabel = makeSourceLabel(tErp);
  const amountHead = amountLabel ?? t("colValue");

  if (error) {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm text-danger md:pl-10">
        <StatusIcon tone="critical" />
        <span>{t("loadError")}</span>
        <button type="button" className="mp-btn mp-btn--ghost mp-btn--sm" onClick={() => setAttempt((a) => a + 1)}>
          {t("retry")}
        </button>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="space-y-2 px-4 py-3 md:pl-10" aria-busy="true" aria-live="polite">
        <span className="sr-only">{t("loading")}</span>
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-5 animate-pulse rounded bg-op-border/60 motion-reduce:animate-none" />
        ))}
      </div>
    );
  }
  if (data.total === 0) {
    return <p className="px-4 py-3 text-sm text-op-muted md:pl-10">{t("empty")}</p>;
  }

  const kind = data.rows[0]?.kind ?? "doc";
  const from = (data.page - 1) * data.size + 1;
  const to = from + data.rows.length - 1;
  const matches = expectedCents == null || expectedCents === data.totals.amountCents;

  const dateOf = (r: AuxRow) => {
    if (!r.dateIso) return "—";
    // Instantes (factura, pedido, compra): fecha y hora de Bogotá. Días
    // (asientos, notas por fecha fiscal, gastos): el día tal cual.
    if (r.kind === "doc" && (r.docKind === "invoice" || r.docKind === "order" || r.docKind === "purchase")) {
      return formatDate(r.dateIso, { locale, dateStyle: "medium", timeStyle: "short" });
    }
    return fmtIsoDate(r.dateIso.length === 10 ? r.dateIso : r.dateIso.slice(0, 10), locale);
  };
  const flags = (r: AuxRow) =>
    r.flags?.length ? (
      <span className="mt-0.5 flex flex-wrap gap-1">
        {r.flags.map((f) => (
          <span key={f} className="rounded-full bg-op-bg px-1.5 py-px font-sans text-[10px] text-op-muted ring-1 ring-op-border">
            {t(`flag_${f}`)}
          </span>
        ))}
      </span>
    ) : null;
  const docCell = (r: AuxRow) => {
    const href = docHref(r.docKind, r.docId);
    const label = r.document || t(`docKind_${r.docKind ?? "refund"}`);
    return (
      <span className="block min-w-0">
        {href ? (
          <Link href={href} prefetch={false} className="font-mono text-xs underline decoration-op-border underline-offset-2 hover:text-op-accent">
            {label}
          </Link>
        ) : (
          <span className="font-mono text-xs">{label}</span>
        )}
        {r.reference && <span className="block text-[10px] text-op-muted">{tTax("creditNoteOf", { invoice: r.reference })}</span>}
        {r.memo && <span className="block max-w-[16rem] truncate text-[10px] text-op-muted" title={r.memo}>{r.memo}</span>}
        {flags(r)}
      </span>
    );
  };
  const partyCell = (r: AuxRow) => (
    <span className="block min-w-0">
      <span className="block max-w-[16rem] truncate" title={r.party ?? undefined}>
        {r.party ?? (r.docKind === "invoice" || r.docKind === "credit_note" ? tTax("finalConsumer") : "—")}
      </span>
      {r.nit && <span className="block font-mono text-[10px] text-op-muted">{t("nitLabel", { nit: r.nit })}</span>}
    </span>
  );
  const entryCell = (r: AuxRow) => {
    const href = entryHref(r.entryId);
    if (!href) return <span className="text-xs text-op-muted">{r.kind === "doc" && r.docKind === "refund" ? "—" : t("noEntry")}</span>;
    return (
      <Link href={href} prefetch={false} className="font-mono text-xs underline decoration-op-border underline-offset-2 hover:text-op-accent">
        {r.voucher ?? t("openEntry")}
      </Link>
    );
  };
  const voucherCell = (r: AuxRow) => (
    <span className="block">
      {entryCell({ ...r, voucher: r.voucher ?? t("unnumbered") })}
      {flags(r)}
    </span>
  );
  /** Origen de un día, con su impuesto si la fila lo trae («Compras · IVA»). */
  const dayOrigin = (r: AuxRow) => {
    const src = r.source ? sourceLabel(r.source) : "—";
    const taxKey = r.tax ? `tile_${r.tax}` : null;
    return taxKey && tTax.has(taxKey) ? t("dayOrigin", { source: src, tax: tTax(taxKey) }) : src;
  };
  const rateOf = (r: AuxRow) => rate({ pct: r.pct ?? null, conceptName: r.conceptName ?? null, rateKey: r.rateKey ?? undefined });

  return (
    <div className="min-w-0 border-t border-op-border/60 bg-op-bg/40 md:pl-6">
      {/* Escritorio e impresión: la tabla. */}
      <div className="report-table">
        <table className="aux-table w-full min-w-[720px] text-sm">
          <thead>
            <tr className="border-b border-op-border text-op-muted">
              {kind === "doc" && (
                <>
                  <th className={`${TH} text-left`}>{t("colDate")}</th>
                  <th className={`${TH} text-left`}>{t("colDocument")}</th>
                  <th className={`${TH} text-left`}>{t("colParty")}</th>
                  <th className={`${TH} text-right`}>{t("colBase")}</th>
                  <th className={`${TH} text-right`}>{t("colRate")}</th>
                  <th className={`${TH} text-right`}>{amountHead}</th>
                  <th className={`${TH} text-left`}>{t("colEntry")}</th>
                </>
              )}
              {kind === "ledger" && (
                <>
                  <th className={`${TH} text-left`}>{t("colDate")}</th>
                  <th className={`${TH} text-left`}>{t("colVoucher")}</th>
                  <th className={`${TH} text-left`}>{t("colSource")}</th>
                  <th className={`${TH} text-left`}>{t("colAccount")}</th>
                  <th className={`${TH} text-left`}>{t("colParty")}</th>
                  <th className={`${TH} text-right`}>{amountHead}</th>
                </>
              )}
              {kind === "day" && (
                <>
                  <th className={`${TH} text-left`}>{t("colDay")}</th>
                  <th className={`${TH} text-left`}>{t("colSource")}</th>
                  <th className={`${TH} text-right`}>{t("colDocs")}</th>
                  <th className={`${TH} text-right`}>{t("colExpected")}</th>
                  <th className={`${TH} text-right`}>{t("colBook")}</th>
                  <th className={`${TH} text-right`}>{t("colDifference")}</th>
                  <th className={`${TH} text-left`}>{t("colEntry")}</th>
                </>
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-op-border/50">
            {data.rows.map((r) => (
              <tr key={r.key}>
                {r.kind === "doc" && (
                  <>
                    <td className={`${TD} aux-date whitespace-nowrap font-mono text-xs text-op-muted`}>{dateOf(r)}</td>
                    <td className={TD}>{docCell(r)}</td>
                    <td className={TD}>{partyCell(r)}</td>
                    <td className={NUM}>{r.baseCents == null ? "—" : money(r.baseCents)}</td>
                    <td className={`${NUM} font-sans text-xs`}>{rateOf(r)}</td>
                    <td className={`${NUM} font-medium`}>{money(r.amountCents)}</td>
                    <td className={TD}>{entryCell(r)}</td>
                  </>
                )}
                {r.kind === "ledger" && (
                  <>
                    <td className={`${TD} aux-date whitespace-nowrap font-mono text-xs text-op-muted`}>{dateOf(r)}</td>
                    <td className={TD}>{voucherCell(r)}</td>
                    <td className={`${TD} text-xs text-op-muted`}>{r.source ? sourceLabel(r.source) : "—"}</td>
                    <td className={TD}>
                      <span className="font-mono text-xs text-op-muted">{r.accountCode}</span>{" "}
                      <span className="text-xs">{r.accountName}</span>
                    </td>
                    <td className={TD}>{partyCell(r)}</td>
                    <td className={cx(NUM, "font-medium", r.flags?.includes("voided") && "text-op-muted line-through")}>
                      {money(r.amountCents)}
                    </td>
                  </>
                )}
                {r.kind === "day" && (
                  <>
                    <td className={`${TD} whitespace-nowrap font-mono text-xs`}>{r.dateIso ? fmtIsoDate(r.dateIso, locale) : t("wholePeriod")}</td>
                    <td className={`${TD} text-xs text-op-muted`}>{dayOrigin(r)}</td>
                    <td className={NUM}>{r.docCount ?? 0}</td>
                    <td className={NUM}>{money(r.expectedCents ?? 0)}</td>
                    <td className={NUM}>{money(r.bookCents ?? 0)}</td>
                    <td className={`${NUM} font-medium`}>{money(r.amountCents)}</td>
                    <td className={TD}>{entryCell(r)}</td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Celular: una tarjeta por fila. */}
      <ul className="report-cards divide-y divide-op-border/50 text-sm">
        {data.rows.map((r) => (
          <li key={r.key} className="px-3 py-2.5">
            <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <span className="font-mono text-[11px] text-op-muted">
                {r.kind === "day" ? (r.dateIso ? fmtIsoDate(r.dateIso, locale) : t("wholePeriod")) : dateOf(r)}
              </span>
              <span className="font-mono tabular text-[13px] font-semibold">{money(r.amountCents)}</span>
            </div>
            <div className="mt-1 min-w-0">
              {r.kind === "doc" && (
                <>
                  {docCell(r)}
                  <div className="mt-1 text-[13px]">{partyCell(r)}</div>
                </>
              )}
              {r.kind === "ledger" && (
                <>
                  {voucherCell(r)}
                  <div className="mt-1 text-xs text-op-muted">
                    {r.source ? sourceLabel(r.source) : ""} · <span className="font-mono">{r.accountCode}</span> {r.accountName}
                  </div>
                  {(r.party || r.nit) && <div className="mt-1 text-[13px]">{partyCell(r)}</div>}
                </>
              )}
              {r.kind === "day" && <div className="text-xs text-op-muted">{dayOrigin(r)}</div>}
            </div>
            <dl className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1">
              {r.kind === "doc" && (
                <>
                  <Fact label={t("colBase")} value={r.baseCents == null ? "—" : money(r.baseCents)} />
                  <Fact label={t("colRate")} value={rateOf(r)} />
                  <Fact label={t("colEntry")} value={entryCell(r)} />
                </>
              )}
              {r.kind === "day" && (
                <>
                  <Fact label={t("colExpected")} value={money(r.expectedCents ?? 0)} />
                  <Fact label={t("colBook")} value={money(r.bookCents ?? 0)} />
                  <Fact label={t("colDocs")} value={String(r.docCount ?? 0)} />
                  <Fact label={t("colEntry")} value={entryCell(r)} />
                </>
              )}
            </dl>
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-op-border/60 px-3 py-2 text-xs md:px-4">
        <span className={cx("inline-flex items-center gap-1.5", matches ? "text-op-muted" : "font-semibold text-danger")}>
          <StatusIcon tone={matches ? "ok" : "critical"} />
          {matches
            ? t("sumMatches", { count: data.total, amount: money(data.totals.amountCents) })
            : t("sumMismatch", { count: data.total, amount: money(data.totals.amountCents), expected: money(expectedCents ?? 0) })}
        </span>
        <span className="no-print flex flex-wrap items-center gap-2">
          {data.pages > 1 && (
            <>
              <button
                type="button"
                className="mp-btn mp-btn--ghost mp-btn--sm"
                disabled={data.page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                {t("prev")}
              </button>
              <span className="tabular text-op-muted">{t("showing", { from, to, total: data.total })}</span>
              <button
                type="button"
                className="mp-btn mp-btn--ghost mp-btn--sm"
                disabled={data.page >= data.pages}
                onClick={() => setPage((p) => p + 1)}
              >
                {t("next")}
              </button>
            </>
          )}
          <a className="mp-btn mp-btn--ghost mp-btn--sm" href={`${endpoint}?${qs({ ...query, nodo: nodeId, format: "xlsx" })}`} download>
            {t("exportXlsx")}
          </a>
          <a className="mp-btn mp-btn--ghost mp-btn--sm" href={`${endpoint}?${qs({ ...query, nodo: nodeId, format: "csv" })}`} download>
            {t("exportCsv")}
          </a>
        </span>
      </div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="font-mono text-[9px] uppercase tracking-wider text-op-muted">{label}</dt>
      <dd className="font-mono tabular text-[13px]">{value}</dd>
    </div>
  );
}
