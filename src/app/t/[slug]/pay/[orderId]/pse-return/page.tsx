import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { getRestaurantPrivateKey } from "@/lib/payments";
import { getRestaurantKushkiMode } from "@/lib/platformConfig";
import { recomputeOrderTotalsInTx } from "@/lib/orderTotals";
import { activateOpenRounds } from "@/lib/prepaidRounds";
import { publishOrderEvent } from "@/lib/events";

/**
 * Si todavía estamos en pending y tenemos un token en la URL (lo
 * agrega Kushki al redirigir), consultamos /transfer/v1/status/<token>
 * directamente para resolver el estado sin depender del webhook.
 * Útil en sandbox (webhook poco confiable) y como fallback en prod.
 *
 * Devuelve true si actualizó el Payment (caller debe re-leerlo).
 */
async function reconcileViaStatusApi(args: {
  token: string;
  paymentId: string;
  restaurantId: string;
  orderId: string;
}): Promise<boolean> {
  const privateKey = await getRestaurantPrivateKey(args.restaurantId);
  if (!privateKey) return false;
  const rest = await db.restaurant.findUnique({
    where: { id: args.restaurantId },
    select: { kushkiMode: true },
  });
  const mode = await getRestaurantKushkiMode(rest);
  if (mode === "mock") return false;
  const baseUrl =
    mode === "production"
      ? "https://api.kushkipagos.com"
      : "https://api-uat.kushkipagos.com";
  try {
    const res = await fetch(
      `${baseUrl}/transfer/v1/status/${encodeURIComponent(args.token)}`,
      {
        method: "GET",
        headers: { "Private-Merchant-Id": privateKey },
        cache: "no-store",
      },
    );
    if (!res.ok) return false;
    const json = (await res.json()) as {
      status?: string;
      responseCode?: string;
      transactionReference?: string;
      responseText?: string;
    };
    const status = json.status;
    if (status !== "approvedTransaction" && status !== "declinedTransaction") {
      return false;
    }
    const isApproved = status === "approvedTransaction";
    const result = await db.$transaction(async (tx) => {
      const updated = await tx.payment.update({
        where: { id: args.paymentId },
        data: {
          status: isApproved ? "approved" : "declined",
          providerRef: json.transactionReference ?? args.token,
          settledAt: isApproved ? new Date() : undefined,
        },
      });
      if (!isApproved) return { payment: updated, fullyPaid: false };
      const totals = await recomputeOrderTotalsInTx(tx, args.orderId);
      if (totals.fullyPaid) {
        await activateOpenRounds(tx, args.orderId);
      }
      return { payment: updated, fullyPaid: totals.fullyPaid };
    });
    publishOrderEvent(args.restaurantId, {
      type: isApproved && result.fullyPaid ? "order.paid" : "order.updated",
      orderId: args.orderId,
    });
    return true;
  } catch (err) {
    console.error("[pse-return] status check failed", err);
    return false;
  }
}

/**
 * Página a la que el banco (o la página mock) redirige al cliente
 * cuando termina el flujo PSE. No es la fuente de verdad del estado
 * del Payment — ese viene por webhook. Acá leemos el estado actual
 * del Payment desde la DB y mostramos un mensaje coherente.
 *
 * Si el webhook ya llegó:
 *   - approved → mensaje OK + link a la cuenta
 *   - declined → mensaje error + reintentar
 *
 * Si todavía no llegó (caso normal: PSE puede demorar segundos):
 *   - mostramos "Procesando..." con auto-refresh cada 3s
 */
export const dynamic = "force-dynamic";

export default async function PseReturnPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; orderId: string }>;
  searchParams: Promise<{ pid?: string; status?: string; token?: string }>;
}) {
  const { slug, orderId } = await params;
  const { pid, status: statusHint, token } = await searchParams;

  // En el flujo live el callbackUrl se setea en el browser durante la
  // tokenización (cuando todavía no existe el Payment en DB), así que
  // no podemos incluir ?pid=. Fallback: si no viene pid, buscamos el
  // Payment kushki_pse más reciente de esta orden — debería haber
  // exactamente uno en estado pending/approved/declined creado por
  // el último click a PSE.
  const payment = pid
    ? await db.payment.findUnique({
        where: { id: pid },
        select: {
          id: true,
          status: true,
          method: true,
          amountCents: true,
          tipCents: true,
          orderId: true,
        },
      })
    : await db.payment.findFirst({
        where: { orderId, method: "kushki_pse" },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          status: true,
          method: true,
          amountCents: true,
          tipCents: true,
          orderId: true,
        },
      });

  if (!payment || payment.orderId !== orderId) {
    redirect(`/t/${slug}/pay/${orderId}`);
  }

  // Si el Payment sigue pending y Kushki nos dejó un token en la URL
  // (lo agrega al hacer el redirect post-banco), consultamos su API
  // de status directamente. Útil en sandbox (donde el webhook no
  // siempre llega) y como fallback en prod si el webhook se atrasa.
  let currentStatus: typeof payment.status = payment.status;
  if (currentStatus === "pending" && token) {
    const order = await db.order.findUnique({
      where: { id: orderId },
      select: { restaurantId: true },
    });
    if (order) {
      const updated = await reconcileViaStatusApi({
        token,
        paymentId: payment.id,
        restaurantId: order.restaurantId,
        orderId,
      });
      if (updated) {
        const refreshed = await db.payment.findUnique({
          where: { id: payment.id },
          select: { status: true },
        });
        if (refreshed) currentStatus = refreshed.status;
      }
    }
  }

  // Approved → mandamos al diner directo al /done. Esa es la página
  // canónica post-pago con los botones de factura electrónica /
  // tirilla por email. Renderear nuestro propio "Pago aprobado" sería
  // un paso extra inútil que el diner cierra antes de ver las
  // opciones de comprobante.
  if (currentStatus === "approved") {
    redirect(`/t/${slug}/pay/${orderId}/done?pid=${payment.id}`);
  }

  // Acá sólo llegamos en pending o declined.
  const isDeclined = currentStatus === "declined";
  const isPending = currentStatus === "pending";
  const t = await getTranslations("wait");

  return (
    <div className="min-h-screen bg-paper flex flex-col items-center justify-center p-6">
      <div className="max-w-sm w-full text-center">
        <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted mb-2">
          {t("pseLabel")}
        </div>
        {isDeclined && (
          <>
            <div className="text-5xl mb-3">{"✕"}</div>
            <h1 className="font-display text-2xl mb-2">{t("declinedTitle")}</h1>
            <p className="text-sm text-op-muted mb-6">
              {statusHint === "declined"
                ? t("pseDeclinedBankBody")
                : t("pseDeclinedBody")}
            </p>
            <Link
              href={`/t/${slug}/pay/${orderId}`}
              className="inline-flex items-center justify-center h-10 px-5 rounded-full bg-ink text-bone text-sm font-medium"
            >
              {t("retry")}
            </Link>
          </>
        )}
        {isPending && (
          <>
            <div className="text-5xl mb-3 animate-pulse">{"⏳"}</div>
            <h1 className="font-display text-2xl mb-2">{t("processing")}</h1>
            <p className="text-sm text-op-muted mb-1">{t("pseProcessingBody")}</p>
            <p className="text-xs text-op-muted mb-6">{t("autoRefresh")}</p>
            {/* Auto-refresh cada 3s sin JS. */}
            <meta httpEquiv="refresh" content="3" />
            <Link
              href={`/t/${slug}/pay/${orderId}`}
              className="text-xs text-op-muted underline"
            >
              {t("backToCheckout")}
            </Link>
          </>
        )}
      </div>
    </div>
  );
}
