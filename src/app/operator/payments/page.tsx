import { getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { fmtCOP } from "@/lib/format";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { getMeseroScope } from "@/lib/meseroScope";

export const dynamic = "force-dynamic";

export default async function PaymentsPage() {
  const t = await getTranslations("opPayments");
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) return <div className="p-6">{t("noRestaurant")}</div>;

  // Mesero-scoped users only see payments for orders on their tables.
  // Other roles see everything.
  const scope = await getMeseroScope();
  const tableFilter = scope.scoped
    ? { table: { number: { in: scope.tableNumbers ?? [] } } }
    : {};

  const [tenant, payments] = await Promise.all([
    db.restaurant.findUnique({
      where: { id: restaurantId },
      select: { serviceMode: true },
    }),
    db.payment.findMany({
      where: { order: { restaurantId, ...tableFilter } },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { order: { include: { table: true } } },
    }),
  ]);
  const counterMode = tenant?.serviceMode === "counter";

  return (
    <div className="p-4 lg:p-6 max-w-5xl mx-auto w-full">
      <div className="font-display text-2xl lg:text-3xl mb-4">{t("title")}</div>
      {/* Desktop: tabla. Las 6 columnas no caben en móvil. */}
      <div className="hidden lg:block bg-op-surface border border-op-border rounded-2xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-op-bg">
            <tr className="text-left">
              <Th>{t("colDate")}</Th>
              <Th>{t("colOrder")}</Th>
              <Th>{counterMode ? t("colChannel") : t("colTable")}</Th>
              <Th>{t("colMethod")}</Th>
              <Th>{t("colStatus")}</Th>
              <Th className="text-right">{t("colAmount")}</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-op-border">
            {payments.map((p) => (
              <tr key={p.id}>
                <Td>{p.createdAt.toLocaleString("es-CO")}</Td>
                <Td className="font-mono">{p.order.shortCode}</Td>
                <Td>
                  {counterMode
                    ? t("channelCounter")
                    : t("tableNumber", { number: p.order.table.number })}
                </Td>
                <Td>{methodLabel(p.method, t)}</Td>
                <Td>
                  <span className={statusTint(p.status)}>
                    {statusLabel(p.status, t)}
                  </span>
                </Td>
                <Td className="text-right font-mono tabular">
                  {fmtCOP(p.amountCents)}
                </Td>
              </tr>
            ))}
            {payments.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-op-muted text-center">
                  {t("empty")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Móvil: lista de tarjetas. */}
      <div className="lg:hidden space-y-2">
        {payments.map((p) => (
          <div
            key={p.id}
            className="bg-op-surface border border-op-border rounded-2xl p-4"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-sm font-medium">
                {p.order.shortCode}
              </span>
              <span className="font-mono tabular text-base font-semibold">
                {fmtCOP(p.amountCents)}
              </span>
            </div>
            <div className="mt-1.5 flex items-center justify-between gap-2 text-sm">
              <span className="truncate">{methodLabel(p.method, t)}</span>
              <span className={statusTint(p.status) + " shrink-0"}>
                {statusLabel(p.status, t)}
              </span>
            </div>
            <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-op-muted">
              <span className="truncate">
                {counterMode
                  ? t("channelCounter")
                  : t("tableNumber", { number: p.order.table.number })}
              </span>
              <span className="shrink-0">
                {fmtDate(p.createdAt)} · {fmtTime(p.createdAt)}
              </span>
            </div>
          </div>
        ))}
        {payments.length === 0 && (
          <div className="text-center py-10 text-sm text-op-muted">
            {t("empty")}
          </div>
        )}
      </div>
    </div>
  );
}
function fmtDate(d: Date) {
  return new Date(d).toLocaleDateString("es-CO", {
    day: "2-digit",
    month: "short",
  });
}
function fmtTime(d: Date) {
  return new Date(d).toLocaleTimeString("es-CO", {
    hour: "2-digit",
    minute: "2-digit",
  });
}
function Th({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      className={
        "px-4 py-2 font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted " +
        className
      }
    >
      {children}
    </th>
  );
}
function Td({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <td className={"px-4 py-2.5 " + className}>{children}</td>;
}
function methodLabel(m: string, t: (key: string) => string) {
  const map: Record<string, string> = {
    demo_card: t("mDemoCard"),
    demo_cash: t("mDemoCash"),
    wompi_card: t("mWompiCard"),
    wompi_pse: t("mWompiPse"),
    wompi_nequi: t("mWompiNequi"),
    // Kushki + datáfono externo del comercio. Abreviado para que
    // entre cómodo en la columna sin partir la fila.
    kushki_apple_pay: t("mApplePay"),
    kushki_google_pay: t("mGooglePay"),
    kushki_card: t("mKushkiCard"),
    kushki_card_terminal: t("mKushkiTerminal"),
    external_terminal: t("mExternalTerminal"),
    kushki_pse: t("mKushkiPse"),
  };
  return map[m] ?? m;
}
function statusLabel(s: string, t: (key: string) => string) {
  switch (s) {
    case "approved":
      return t("statusApproved");
    case "declined":
      return t("statusDeclined");
    case "refunded":
      return t("statusRefunded");
    case "failed":
      return t("statusFailed");
    default:
      return t("statusPending");
  }
}
function statusTint(s: string) {
  switch (s) {
    case "approved":
      return "text-ok";
    case "declined":
      return "text-danger";
    case "refunded":
      return "text-op-muted";
    default:
      return "text-[#C98A2E]";
  }
}
