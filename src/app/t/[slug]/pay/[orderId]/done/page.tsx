import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { fmtCOP } from "@/lib/format";
import { DoneLive } from "./DoneLive";
import { InvoiceRequestPanel } from "./InvoiceRequestPanel";

export const dynamic = "force-dynamic";

type DoneT = Awaited<ReturnType<typeof getTranslations>>;

// Slugs de PaymentMethod → clave del catálogo `done`. Si agregás un
// método nuevo, sumalo acá o se muestra el slug crudo.
const METHOD_LABEL: Record<string, string> = {
  demo_card: "methodCard",
  demo_cash: "methodCash",
  demo_nequi: "methodNequi",
  wompi_card: "methodCard",
  wompi_nequi: "methodNequi",
  wompi_pse: "methodPse",
  kushki_apple_pay: "methodApplePay",
  kushki_card: "methodCard",
  kushki_card_terminal: "methodCardTerminal",
  external_terminal: "methodCardTerminal",
  kushki_pse: "methodPse",
};

function methodLabel(m: string, t: DoneT) {
  const key = METHOD_LABEL[m];
  return key ? t(key) : m;
}

function fmtRelative(d: Date, t: DoneT) {
  const diff = Date.now() - d.getTime();
  const s = Math.round(diff / 1000);
  if (s < 45) return t("relMoment");
  const mins = Math.round(s / 60);
  if (mins < 60) return t("relMin", { min: mins });
  const hours = Math.round(mins / 60);
  if (hours < 24) return t("relHours", { hours });
  return d.toLocaleTimeString("es-CO", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default async function PayDone({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; orderId: string }>;
  searchParams: Promise<{ pid?: string; op?: string }>;
}) {
  const { slug, orderId } = await params;
  const { pid, op } = await searchParams;
  // op=1 → llegó acá el MESERO tras cobrar: copia en tercera persona +
  // enlace de vuelta a mesas (según el rol de la sesión).
  const operator = op === "1";
  const session = operator ? await auth() : null;
  const backHref =
    session?.user?.role === "mesero" ? "/mesero/mesas" : "/operator/tables";
  const tenant = await db.restaurant.findUnique({ where: { slug } });
  if (!tenant) return notFound();

  const order = await db.order.findUnique({
    where: { id: orderId },
    include: {
      table: true,
      rounds: { orderBy: { seq: "asc" } },
      items: { orderBy: { id: "asc" } },
      payments: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!order || order.restaurantId !== tenant.id) return notFound();

  // If the diner already submitted billing info we surface its status
  // instead of the request button. Only show the most recent — they may
  // have updated it once.
  const existingInvoice = await db.invoiceRequest.findFirst({
    where: { orderId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      status: true,
      customerName: true,
      docType: true,
      docNumber: true,
      email: true,
      address: true,
      city: true,
      department: true,
    },
  });
  const invoiceSummary = existingInvoice
    ? {
        status: existingInvoice.status,
        customerName: existingInvoice.customerName,
        docType: existingInvoice.docType,
        docNumber: existingInvoice.docNumber,
        email: existingInvoice.email,
        address: existingInvoice.address,
        city: existingInvoice.city,
        department: existingInvoice.department,
      }
    : null;

  const t = await getTranslations("done");

  // Banner de mesero (solo op=1): confirma el cobro y da salida a mesas.
  const operatorBanner = operator ? (
    <div className="mb-6 flex items-center justify-between gap-3 rounded-2xl bg-ink text-bone px-4 py-3">
      <span className="text-sm font-medium">{t("opChargeDone")}</span>
      <Link
        href={backHref}
        className="font-mono text-[10px] tracking-wider uppercase underline opacity-90 shrink-0"
      >
        {t("opBackToTables")}
      </Link>
    </div>
  ) : null;

  // Counter-mode keeps its status tracker: big code + live cook status.
  if (tenant.serviceMode === "counter") {
    const round = order.rounds[0] ?? null;
    const roundStatus = round?.status ?? "placed";
    const isReady = roundStatus === "ready" || roundStatus === "served";
    const isServed = roundStatus === "served";

    return (
      <main className="flex-1 bg-bone">
        <div className="max-w-md mx-auto px-5 py-10">
          <DoneLive orderId={order.id} tenantSlug={tenant.slug} />
          {operatorBanner}

          <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-terracotta">
            {t("orderPaid")}
          </div>
          <div className="font-display text-3xl tracking-[-0.015em] mt-1">
            {tenant.name}
          </div>

          <div className="mt-6 rounded-2xl border border-hairline bg-paper p-6 text-center">
            <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-muted">
              {t("yourCode")}
            </div>
            <div className="font-display text-6xl leading-none mt-2 tabular">
              {order.shortCode}
            </div>
            <div className="text-sm text-muted mt-3">{t("showCashier")}</div>
          </div>

          {isServed ? (
            <div className="mt-6 rounded-2xl bg-ink text-bone p-6 text-center">
              <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-bone/70">
                {t("delivered")}
              </div>
              <div className="font-display text-3xl mt-2">
                {t("thanksDining")}
              </div>
            </div>
          ) : isReady ? (
            <div className="mt-6 rounded-2xl bg-ok text-bone p-8 text-center">
              <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-bone/80">
                {t("readyTitle")}
              </div>
              <div className="font-display text-4xl mt-2 leading-[1.05]">
                {t("goToCounter")}
              </div>
            </div>
          ) : (
            <div className="mt-6 rounded-2xl bg-paper border border-hairline p-6 text-center">
              <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-muted">
                {t("preparing")}
              </div>
              <div className="font-display text-3xl mt-2">
                {t("preparingTitle")}
              </div>
              <div className="text-sm text-muted mt-3">{t("preparingHint")}</div>
            </div>
          )}

          {/* Invoice CTA — directly under the status card so it's the
              second thing the diner sees, not buried at the bottom. */}
          <div className="mt-6">
            <InvoiceRequestPanel
              tenantSlug={slug}
              orderId={order.id}
              existing={invoiceSummary}
              operatorMode={operator}
            />
          </div>

          <div className="mt-8 rounded-2xl border border-hairline bg-paper p-5">
            <div className="font-mono text-[10px] tracking-wider uppercase text-muted mb-3">
              {t("yourOrder")}
            </div>
            <ul className="divide-y divide-hairline">
              {order.items.map((i) => (
                <li
                  key={i.id}
                  className="py-2 flex items-center justify-between text-sm"
                >
                  <span>
                    {i.qty}× {i.nameSnapshot}
                  </span>
                  <span className="font-mono tabular">
                    {fmtCOP(i.priceCentsSnapshot * i.qty)}
                  </span>
                </li>
              ))}
            </ul>
            <div className="mt-3 pt-3 border-t border-hairline flex items-baseline justify-between">
              <span className="font-mono text-[10px] tracking-wider uppercase text-muted">
                {t("paid")}
              </span>
              <span className="font-display text-2xl tabular">
                {fmtCOP(order.totalCents)}
              </span>
            </div>
          </div>
        </div>
      </main>
    );
  }

  // Table-mode shared-bill ledger: show every approved payment on this
  // order, highlight the current diner's contribution, and render progress
  // so diners still at the table can see how much remains.
  const approvedPayments = order.payments.filter(
    (p) => p.status === "approved",
  );
  const pendingPayments = order.payments.filter(
    (p) => p.status === "pending",
  );
  const paidCents = approvedPayments.reduce((s, p) => s + p.amountCents, 0);
  // totalCents is only set once the first tip is applied; fall back to
  // subtotal so the progress bar has a sensible denominator before anyone
  // has picked a tip.
  const expectedCents = Math.max(order.totalCents, order.subtotalCents);
  const outstandingCents = Math.max(0, expectedCents - paidCents);
  const fullyPaid = order.status === "paid" || outstandingCents === 0;
  const progressPct = expectedCents > 0
    ? Math.min(100, Math.round((paidCents / expectedCents) * 100))
    : 0;

  const myPayment = pid
    ? order.payments.find((p) => p.id === pid) ?? null
    : null;

  return (
    <main className="flex-1 bg-bone">
      <div className="max-w-xl mx-auto px-5 py-10">
        <DoneLive orderId={order.id} tenantSlug={tenant.slug} />
        {operatorBanner}

        <div className="font-mono text-[10px] tracking-[0.16em] uppercase text-muted">
          {t("headerTable", {
            number: order.table.number,
            name: tenant.name,
            code: order.shortCode,
          })}
        </div>
        <h1 className="font-display text-4xl tracking-[-0.015em] mt-1">
          {fullyPaid ? t("billPaid") : t("paymentReceived")}
        </h1>

        {/* Current diner's receipt */}
        {myPayment && (
          <div className="mt-6 rounded-2xl border border-ok/30 bg-ok/10 p-5 flex items-center gap-4">
            <div className="w-11 h-11 rounded-full bg-ok/25 text-ok inline-flex items-center justify-center font-display text-2xl check-pop shrink-0">
              {"✓"}
            </div>
            <div className="flex-1 min-w-0">
              <div className="font-mono text-[10px] tracking-wider uppercase text-muted">
                {t("yourContribution")}
              </div>
              <div className="font-display text-2xl tabular">
                {fmtCOP(myPayment.amountCents)}
              </div>
              <div className="text-xs text-muted mt-0.5">
                {methodLabel(myPayment.method, t)} ·{" "}
                {fmtRelative(myPayment.createdAt, t)}
              </div>
            </div>
          </div>
        )}

        {/* Invoice CTA — placed here (right after the diner sees their
            payment was received) because that's the peak-attention moment.
            Hidden until fully paid: there's no bill to invoice mid-split. */}
        {fullyPaid && (
          <div className="mt-6">
            <InvoiceRequestPanel
              tenantSlug={slug}
              orderId={order.id}
              existing={invoiceSummary}
              operatorMode={operator}
            />
          </div>
        )}

        {/* Bill progress */}
        <div className="mt-6 rounded-2xl border border-hairline bg-paper p-5">
          <div className="flex items-baseline justify-between">
            <div className="font-mono text-[10px] tracking-wider uppercase text-muted">
              {t("billProgress")}
            </div>
            <div className="font-mono text-[11px] tabular text-ink">
              {progressPct}%
            </div>
          </div>
          <div className="mt-3 h-2.5 rounded-full bg-hairline overflow-hidden">
            <div
              className={
                "h-full transition-all duration-500 " +
                (fullyPaid ? "bg-ok" : "bg-terracotta")
              }
              style={{ width: `${Math.max(4, progressPct)}%` }}
            />
          </div>
          <div className="mt-4 grid grid-cols-3 gap-3 text-center">
            <div>
              <div className="font-mono text-[10px] tracking-wider uppercase text-muted">
                {t("paid")}
              </div>
              <div className="font-display text-xl tabular">
                {fmtCOP(paidCents)}
              </div>
            </div>
            <div>
              <div className="font-mono text-[10px] tracking-wider uppercase text-muted">
                {t("total")}
              </div>
              <div className="font-display text-xl tabular">
                {fmtCOP(expectedCents)}
              </div>
            </div>
            <div>
              <div
                className={
                  "font-mono text-[10px] tracking-wider uppercase " +
                  (fullyPaid ? "text-ok" : "text-terracotta")
                }
              >
                {fullyPaid ? t("settled") : t("owed")}
              </div>
              <div
                className={
                  "font-display text-xl tabular " +
                  (fullyPaid ? "text-ok" : "text-terracotta")
                }
              >
                {fmtCOP(outstandingCents)}
              </div>
            </div>
          </div>
          {!fullyPaid && (
            <div className="mt-4 pt-4 border-t border-hairline flex items-center justify-between gap-3">
              <p className="text-xs text-muted">{t("keepPayingHint")}</p>
              <Link
                href={`/t/${slug}/pay/${order.id}`}
                className="shrink-0 h-9 px-4 rounded-full bg-ink text-bone text-xs font-medium inline-flex items-center"
              >
                {t("payMore")}
              </Link>
            </div>
          )}
        </div>

        {/* Payments ledger */}
        <div className="mt-6 rounded-2xl border border-hairline bg-paper p-5">
          <div className="font-mono text-[10px] tracking-wider uppercase text-muted mb-3">
            {t("paymentsAtTable")}
          </div>
          {approvedPayments.length === 0 && pendingPayments.length === 0 ? (
            <p className="text-sm text-muted">{t("noPayments")}</p>
          ) : (
            <ul className="divide-y divide-hairline">
              {order.payments.map((p, idx) => {
                const isMine = myPayment?.id === p.id;
                const isPending = p.status === "pending";
                return (
                  <li key={p.id} className="py-3 flex items-center gap-3">
                    <div
                      className={
                        "w-8 h-8 rounded-full inline-flex items-center justify-center font-mono text-xs shrink-0 " +
                        (isMine
                          ? "bg-ok text-bone"
                          : isPending
                            ? "bg-[#C98A2E]/20 text-[#8F6828]"
                            : "bg-ink/8 text-ink")
                      }
                    >
                      {idx + 1}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">
                        {methodLabel(p.method, t)}
                        {isMine && (
                          <span className="ml-2 font-mono text-[10px] tracking-wider uppercase text-ok">
                            {t("you")}
                          </span>
                        )}
                        {isPending && (
                          <span className="ml-2 font-mono text-[10px] tracking-wider uppercase text-[#8F6828]">
                            {t("pending")}
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-muted">
                        {fmtRelative(p.createdAt, t)}
                      </div>
                    </div>
                    <div className="font-mono tabular text-sm">
                      {fmtCOP(p.amountCents)}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Order summary */}
        <div className="mt-6 rounded-2xl border border-hairline bg-paper p-5">
          <div className="font-mono text-[10px] tracking-wider uppercase text-muted mb-3">
            {t("orderSummary")}
          </div>
          <ul className="divide-y divide-hairline">
            {order.items.map((i) => (
              <li
                key={i.id}
                className="py-2 flex items-center justify-between text-sm gap-3"
              >
                <div className="flex-1 min-w-0">
                  <div className="truncate">
                    {i.qty}× {i.nameSnapshot}
                  </div>
                  {i.guestName && (
                    <div className="text-[11px] text-terracotta mt-0.5">
                      {t("by")} {i.guestName}
                    </div>
                  )}
                </div>
                <span className="font-mono tabular">
                  {fmtCOP(i.priceCentsSnapshot * i.qty)}
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-3 pt-3 border-t border-hairline flex items-baseline justify-between">
            <span className="font-mono text-[10px] tracking-wider uppercase text-muted">
              {t("subtotal")}
            </span>
            <span className="font-display text-xl tabular">
              {fmtCOP(order.subtotalCents)}
            </span>
          </div>
          {order.tipCents > 0 && (
            <div className="mt-1 flex items-baseline justify-between">
              <span className="font-mono text-[10px] tracking-wider uppercase text-muted">
                {t("tip")}
              </span>
              <span className="font-mono tabular text-sm">
                {fmtCOP(order.tipCents)}
              </span>
            </div>
          )}
        </div>

        <div className="mt-8 flex justify-center">
          <Link
            href={`/t/${slug}/order/${order.id}`}
            className="font-mono text-[11px] tracking-wider uppercase text-muted hover:text-terracotta"
          >
            {t("viewFullOrder")}
          </Link>
        </div>
      </div>
    </main>
  );
}
