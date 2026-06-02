import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { fmtCOP } from "@/lib/format";
import { fmtBogotaDateTime } from "@/lib/bogota";
import {
  buildShiftReport,
  PAYMENT_METHOD_LABEL,
} from "@/lib/shiftReport";
import { PrintButton } from "./PrintButton";

export const dynamic = "force-dynamic";

const METHOD_KEY: Record<string, string> = {
  demo_card: "methodDemoCard",
  demo_cash: "methodDemoCash",
  wompi_card: "methodWompiCard",
  wompi_pse: "methodWompiPse",
  wompi_nequi: "methodWompiNequi",
  kushki_apple_pay: "methodKushkiApplePay",
  kushki_google_pay: "methodKushkiGooglePay",
  kushki_card_terminal: "methodKushkiCardTerminal",
  kushki_card: "methodKushkiCard",
  external_terminal: "methodExternalTerminal",
  kushki_pse: "methodKushkiPse",
  reservation_deposit: "methodReservationDeposit",
};

/**
 * Reporte contable detallado de un turno cerrado. Pensado para el
 * cierre nocturno del operador — qué entró por cada método, qué se
 * llevó cada mesero, cuánto efectivo se entregó como vuelto, y el
 * arqueo (esperado vs declarado vs diferencia).
 *
 * Optimizado para imprimir: el CSS inline esconde nav/header al
 * `@media print` y deja sólo el reporte en B/N con tipografía
 * compacta. Botón "Imprimir" dispara window.print() (cliente).
 */
export default async function ShiftDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const t = await getTranslations("opShifts");
  const methodLabel = (method: string) =>
    METHOD_KEY[method]
      ? t(METHOD_KEY[method])
      : PAYMENT_METHOD_LABEL[method as keyof typeof PAYMENT_METHOD_LABEL] ?? method;
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) return <div className="p-6">{t("noRestaurant")}</div>;

  const report = await buildShiftReport(id);
  if (!report) notFound();
  if (report.shift.restaurantId !== restaurantId) notFound();

  const tenant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: { name: true, legalName: true, taxId: true },
  });

  const openLabel = fmtBogotaDateTime(report.shift.openedAt);
  const closeLabel = report.shift.closedAt
    ? fmtBogotaDateTime(report.shift.closedAt)
    : null;
  const durationMs = report.shift.closedAt
    ? report.shift.closedAt.getTime() - report.shift.openedAt.getTime()
    : 0;
  const durationLabel = formatDuration(durationMs, t);

  const merchant =
    tenant?.legalName?.trim() || tenant?.name || t("merchantFallback");

  return (
    <>
      <style>{`
        @media print {
          /* Oculta nav, header del operador, cualquier cosa fija
             del shell. La página queda limpia para impresora. */
          .no-print, header, nav, footer, [role="navigation"] { display: none !important; }
          body { background: #ffffff !important; }
          .shift-report { background: #ffffff !important; padding: 0 !important; }
          .shift-card { border-color: #cfcfcf !important; box-shadow: none !important; break-inside: avoid; }
          .shift-row { border-color: #cfcfcf !important; }
          @page { margin: 14mm; }
        }
        .shift-report { color: #1A1613; }
      `}</style>

      <div className="shift-report flex-1 p-4 md:p-6 max-w-4xl mx-auto w-full">
        <div className="no-print flex items-center justify-between gap-3 mb-4 flex-wrap">
          <Link
            href="/operator/shifts"
            className="font-mono text-[10px] tracking-wider uppercase text-op-muted hover:text-op-text"
          >
            {t("detailBack")}
          </Link>
          <PrintButton />
        </div>

        {/* Header */}
        <header className="mb-6">
          <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-op-muted mb-1">
            {t("shiftClose")}
          </div>
          <h1 className="font-display text-3xl tracking-[-0.015em] mb-1">
            {merchant}
          </h1>
          {tenant?.taxId && (
            <div className="font-mono text-xs text-op-muted">
              {t("taxId", { taxId: tenant.taxId })}
            </div>
          )}
          <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
            <Field label={t("fieldOpened")}>
              {t("dateTime", { date: openLabel.date, time: openLabel.time })}
            </Field>
            <Field label={t("fieldClosed")}>
              {closeLabel
                ? t("dateTime", { date: closeLabel.date, time: closeLabel.time })
                : t("emptyDash")}
            </Field>
            <Field label={t("fieldDuration")}>{durationLabel}</Field>
            <Field label={t("fieldShiftOf")}>
              {report.shift.userLabel ?? t("shiftOfGlobal")}
            </Field>
          </div>
        </header>

        {/* Totales */}
        <section className="shift-card rounded-2xl border border-op-border bg-op-surface p-5 mb-4">
          <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-3">
            {t("summary")}
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Stat label={t("grossSales")} value={fmtCOP(report.totals.grossCents)} />
            <Stat label={t("foodNoTip")} value={fmtCOP(report.totals.foodCents)} />
            <Stat label={t("tips")} value={fmtCOP(report.totals.tipCents)} />
            <Stat
              label={t("paymentsOrders")}
              value={`${report.totals.paymentCount} · ${report.totals.ordersClosed}`}
            />
          </div>
        </section>

        {/* Por método */}
        <section className="shift-card rounded-2xl border border-op-border bg-op-surface p-5 mb-4">
          <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-3">
            {t("byMethodTitle")}
          </div>
          {report.byMethod.length === 0 ? (
            <div className="text-sm text-op-muted">{t("noPayments")}</div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-op-muted">
                  <Th>{t("thMethod")}</Th>
                  <Th align="right">{t("thPayments")}</Th>
                  <Th align="right">{t("thGross")}</Th>
                  <Th align="right">{t("thTip")}</Th>
                  <Th align="right">{t("thFood")}</Th>
                </tr>
              </thead>
              <tbody>
                {report.byMethod.map((m) => (
                  <tr
                    key={m.method}
                    className="shift-row border-t border-op-border"
                  >
                    <Td>{methodLabel(m.method)}</Td>
                    <Td align="right">{m.count}</Td>
                    <Td align="right" mono>
                      {fmtCOP(m.grossCents)}
                    </Td>
                    <Td align="right" mono>
                      {fmtCOP(m.tipCents)}
                    </Td>
                    <Td align="right" mono>
                      {fmtCOP(m.grossCents - m.tipCents)}
                    </Td>
                  </tr>
                ))}
                <tr className="shift-row border-t-2 border-ink/40 font-medium">
                  <Td>{t("total")}</Td>
                  <Td align="right">{report.totals.paymentCount}</Td>
                  <Td align="right" mono>
                    {fmtCOP(report.totals.grossCents)}
                  </Td>
                  <Td align="right" mono>
                    {fmtCOP(report.totals.tipCents)}
                  </Td>
                  <Td align="right" mono>
                    {fmtCOP(report.totals.foodCents)}
                  </Td>
                </tr>
              </tbody>
            </table>
          )}
        </section>

        {/* Por mesero */}
        {report.byWaiter.length > 0 && (
          <section className="shift-card rounded-2xl border border-op-border bg-op-surface p-5 mb-4">
            <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-3">
              {t("byWaiterTitle")}
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-op-muted">
                  <Th>{t("thWhoCollected")}</Th>
                  <Th align="right">{t("thPayments")}</Th>
                  <Th align="right">{t("thGross")}</Th>
                  <Th align="right">{t("thCash")}</Th>
                  <Th align="right">{t("thTip")}</Th>
                </tr>
              </thead>
              <tbody>
                {report.byWaiter.map((w) => (
                  <tr
                    key={w.userId ?? "guest"}
                    className="shift-row border-t border-op-border"
                  >
                    <Td>{w.userLabel}</Td>
                    <Td align="right">{w.count}</Td>
                    <Td align="right" mono>
                      {fmtCOP(w.grossCents)}
                    </Td>
                    <Td align="right" mono>
                      {fmtCOP(w.cashCents)}
                    </Td>
                    <Td align="right" mono>
                      {fmtCOP(w.tipCents)}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        {/* Efectivo + arqueo */}
        <section className="shift-card rounded-2xl border border-op-border bg-op-surface p-5 mb-4">
          <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-3">
            {t("cashAndCount")}
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-4">
            <Stat
              label={t("baseInitial")}
              value={fmtCOP(report.shift.openingCashCents)}
            />
            <Stat
              label={t("cashReceived")}
              value={fmtCOP(report.cash.receivedCents)}
            />
            <Stat
              label={t("changeGiven")}
              value={fmtCOP(report.cash.changeGivenCents)}
            />
            <Stat
              label={t("expectedInDrawer")}
              value={
                report.shift.expectedCashCents != null
                  ? fmtCOP(report.shift.expectedCashCents)
                  : t("emptyDash")
              }
            />
            <Stat
              label={t("declaredAtClose")}
              value={
                report.shift.declaredCashCents != null
                  ? fmtCOP(report.shift.declaredCashCents)
                  : t("emptyDash")
              }
            />
            <Stat
              label={t("difference")}
              value={
                report.shift.cashDiffCents != null
                  ? `${report.shift.cashDiffCents > 0 ? "+" : ""}${fmtCOP(report.shift.cashDiffCents)}`
                  : t("emptyDash")
              }
              accent={
                report.shift.cashDiffCents == null
                  ? undefined
                  : report.shift.cashDiffCents === 0
                    ? "ok"
                    : report.shift.cashDiffCents > 0
                      ? "warn"
                      : "danger"
              }
            />
          </div>
          {report.shift.notes && (
            <div className="pt-3 border-t border-op-border">
              <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted mb-1">
                {t("notes")}
              </div>
              <div className="text-sm whitespace-pre-wrap">
                {report.shift.notes}
              </div>
            </div>
          )}
        </section>

        {/* Pagos */}
        <section className="shift-card rounded-2xl border border-op-border bg-op-surface p-5 mb-4">
          <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-3">
            {t("paymentsTitle", { count: report.payments.length })}
          </div>
          {report.payments.length === 0 ? (
            <div className="text-sm text-op-muted">{t("noPayments")}</div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-op-muted">
                  <Th>{t("thTime")}</Th>
                  <Th>{t("thOrder")}</Th>
                  <Th>{t("thTable")}</Th>
                  <Th>{t("thMethod")}</Th>
                  <Th>{t("thCollectedBy")}</Th>
                  <Th align="right">{t("thGross")}</Th>
                  <Th align="right">{t("thTip")}</Th>
                </tr>
              </thead>
              <tbody>
                {report.payments.map((p) => (
                  <tr
                    key={p.id}
                    className="shift-row border-t border-op-border"
                  >
                    <Td mono>
                      {p.settledAt
                        ? fmtBogotaDateTime(p.settledAt).time
                        : t("emptyDash")}
                    </Td>
                    <Td mono>{p.orderShortCode}</Td>
                    <Td>{p.tableLabel ?? t("emptyDash")}</Td>
                    <Td>{methodLabel(p.method)}</Td>
                    <Td>{p.collectedByLabel ?? t("collectedByCustomer")}</Td>
                    <Td align="right" mono>
                      {fmtCOP(p.amountCents)}
                    </Td>
                    <Td align="right" mono>
                      {fmtCOP(p.tipCents)}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <div className="no-print text-[11px] text-op-muted text-center mt-6">
          {t("reportGenerated", {
            date: fmtBogotaDateTime(new Date()).date,
            time: fmtBogotaDateTime(new Date()).time,
          })}
        </div>
      </div>
    </>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: React.ReactNode;
  accent?: "ok" | "warn" | "danger";
}) {
  const tone =
    accent === "ok"
      ? "text-ok"
      : accent === "warn"
        ? "text-[#7F5A1F]"
        : accent === "danger"
          ? "text-danger"
          : "";
  return (
    <div>
      <div className="font-mono text-[9px] tracking-[0.14em] uppercase text-op-muted mb-1">
        {label}
      </div>
      <div className={"font-display text-xl tabular " + tone}>{value}</div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="font-mono text-[9px] tracking-[0.14em] uppercase text-op-muted mb-1">
        {label}
      </div>
      <div>{children}</div>
    </div>
  );
}

function Th({
  children,
  align,
}: {
  children: React.ReactNode;
  align?: "right";
}) {
  return (
    <th
      className={
        "font-mono text-[10px] tracking-wider uppercase pb-2 " +
        (align === "right" ? "text-right" : "")
      }
    >
      {children}
    </th>
  );
}

function Td({
  children,
  align,
  mono,
}: {
  children: React.ReactNode;
  align?: "right";
  mono?: boolean;
}) {
  return (
    <td
      className={
        "py-2 " +
        (align === "right" ? "text-right " : "") +
        (mono ? "font-mono tabular text-[12px] " : "")
      }
    >
      {children}
    </td>
  );
}

function formatDuration(
  ms: number,
  t: Awaited<ReturnType<typeof getTranslations<"opShifts">>>,
): string {
  if (ms <= 0) return t("emptyDash");
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return t("durationM", { m });
  return t("durationHm", { h, m });
}
