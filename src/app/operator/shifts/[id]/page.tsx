import Link from "next/link";
import { notFound } from "next/navigation";
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
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) return <div className="p-6">Sin restaurante.</div>;

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
  const durationLabel = formatDuration(durationMs);

  const merchant =
    tenant?.legalName?.trim() || tenant?.name || "Comercio";

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
            ← Turnos
          </Link>
          <PrintButton />
        </div>

        {/* Header */}
        <header className="mb-6">
          <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-op-muted mb-1">
            Cierre de turno
          </div>
          <h1 className="font-display text-3xl tracking-[-0.015em] mb-1">
            {merchant}
          </h1>
          {tenant?.taxId && (
            <div className="font-mono text-xs text-op-muted">
              NIT {tenant.taxId}
            </div>
          )}
          <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
            <Field label="Abrió">
              {openLabel.date} · {openLabel.time}
            </Field>
            <Field label="Cerró">
              {closeLabel ? `${closeLabel.date} · ${closeLabel.time}` : "—"}
            </Field>
            <Field label="Duración">{durationLabel}</Field>
            <Field label="Turno de">
              {report.shift.userLabel ?? "Restaurante (global)"}
            </Field>
          </div>
        </header>

        {/* Totales */}
        <section className="shift-card rounded-2xl border border-op-border bg-op-surface p-5 mb-4">
          <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-3">
            Resumen
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Stat label="Ventas brutas" value={fmtCOP(report.totals.grossCents)} />
            <Stat label="Comida (sin propina)" value={fmtCOP(report.totals.foodCents)} />
            <Stat label="Propinas" value={fmtCOP(report.totals.tipCents)} />
            <Stat
              label="Pagos · órdenes"
              value={`${report.totals.paymentCount} · ${report.totals.ordersClosed}`}
            />
          </div>
        </section>

        {/* Por método */}
        <section className="shift-card rounded-2xl border border-op-border bg-op-surface p-5 mb-4">
          <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-3">
            Por método de pago
          </div>
          {report.byMethod.length === 0 ? (
            <div className="text-sm text-op-muted">Sin pagos.</div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-op-muted">
                  <Th>Método</Th>
                  <Th align="right">Pagos</Th>
                  <Th align="right">Bruto</Th>
                  <Th align="right">Propina</Th>
                  <Th align="right">Comida</Th>
                </tr>
              </thead>
              <tbody>
                {report.byMethod.map((m) => (
                  <tr
                    key={m.method}
                    className="shift-row border-t border-op-border"
                  >
                    <Td>{PAYMENT_METHOD_LABEL[m.method] ?? m.method}</Td>
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
                  <Td>Total</Td>
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
              Por mesero
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-op-muted">
                  <Th>Quien cobró</Th>
                  <Th align="right">Pagos</Th>
                  <Th align="right">Bruto</Th>
                  <Th align="right">Efectivo</Th>
                  <Th align="right">Propina</Th>
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
            Efectivo y arqueo
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-4">
            <Stat
              label="Base inicial"
              value={fmtCOP(report.shift.openingCashCents)}
            />
            <Stat
              label="Recibido en efectivo"
              value={fmtCOP(report.cash.receivedCents)}
            />
            <Stat
              label="Vuelto entregado"
              value={fmtCOP(report.cash.changeGivenCents)}
            />
            <Stat
              label="Esperado en caja"
              value={
                report.shift.expectedCashCents != null
                  ? fmtCOP(report.shift.expectedCashCents)
                  : "—"
              }
            />
            <Stat
              label="Declarado al cierre"
              value={
                report.shift.declaredCashCents != null
                  ? fmtCOP(report.shift.declaredCashCents)
                  : "—"
              }
            />
            <Stat
              label="Diferencia"
              value={
                report.shift.cashDiffCents != null
                  ? `${report.shift.cashDiffCents > 0 ? "+" : ""}${fmtCOP(report.shift.cashDiffCents)}`
                  : "—"
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
                Notas
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
            Pagos · {report.payments.length}
          </div>
          {report.payments.length === 0 ? (
            <div className="text-sm text-op-muted">Sin pagos.</div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-op-muted">
                  <Th>Hora</Th>
                  <Th>Orden</Th>
                  <Th>Mesa</Th>
                  <Th>Método</Th>
                  <Th>Cobró</Th>
                  <Th align="right">Bruto</Th>
                  <Th align="right">Propina</Th>
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
                        : "—"}
                    </Td>
                    <Td mono>{p.orderShortCode}</Td>
                    <Td>{p.tableLabel ?? "—"}</Td>
                    <Td>{PAYMENT_METHOD_LABEL[p.method] ?? p.method}</Td>
                    <Td>{p.collectedByLabel ?? "Cliente"}</Td>
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
          Reporte generado el {fmtBogotaDateTime(new Date()).date} ·{" "}
          {fmtBogotaDateTime(new Date()).time} desde MESAPAY
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

function formatDuration(ms: number): string {
  if (ms <= 0) return "—";
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}
