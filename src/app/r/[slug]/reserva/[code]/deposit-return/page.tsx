import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { fmtCOP } from "@/lib/format";
import { db } from "@/lib/db";
import { getRestaurantPrivateKey } from "@/lib/payments";
import { getRestaurantKushkiMode } from "@/lib/platformConfig";
import { publishOrderEvent } from "@/lib/events";
import { sendReservationConfirmation } from "@/lib/reservationEmail";

export const dynamic = "force-dynamic";

/**
 * Página de retorno del depósito por PSE. El banco redirige acá cuando
 * el cliente termina. No dependemos del webhook: si el depósito sigue
 * pendiente y tenemos el token, consultamos /transfer/v1/status del
 * token y confirmamos. Igual patrón que /pay/[orderId]/pse-return pero
 * sobre la Reserva.
 */
async function reconcile(args: {
  token: string;
  reservationId: string;
  restaurantId: string;
}): Promise<"approved" | "declined" | "pending"> {
  const rest = await db.restaurant.findUnique({
    where: { id: args.restaurantId },
    select: { kushkiMode: true },
  });
  const mode = await getRestaurantKushkiMode(rest);
  if (mode === "mock") return "pending";
  const privateKey = await getRestaurantPrivateKey(args.restaurantId);
  if (!privateKey) return "pending";
  const baseUrl =
    mode === "production"
      ? "https://api.kushkipagos.com"
      : "https://api-uat.kushkipagos.com";
  try {
    const res = await fetch(
      `${baseUrl}/transfer/v1/status/${encodeURIComponent(args.token)}`,
      { method: "GET", headers: { "Private-Merchant-Id": privateKey }, cache: "no-store" },
    );
    if (!res.ok) return "pending";
    const json = (await res.json()) as { status?: string };
    if (json.status === "approvedTransaction") return "approved";
    if (json.status === "declinedTransaction") return "declined";
    return "pending";
  } catch (err) {
    console.error("[deposit-return] status check failed", err);
    return "pending";
  }
}

export default async function DepositReturnPage({
  params,
}: {
  params: Promise<{ slug: string; code: string }>;
}) {
  const { slug, code } = await params;
  const t = await getTranslations("reservar");

  const reservation = await db.reservation.findUnique({
    where: { confirmationCode: code },
    include: {
      table: { select: { number: true, label: true } },
      restaurant: { select: { id: true, name: true, legalCity: true } },
    },
  });
  if (!reservation || reservation.restaurant == null) return notFound();

  let state: "approved" | "declined" | "pending" =
    reservation.depositStatus === "paid" ||
    reservation.depositStatus === "applied"
      ? "approved"
      : "pending";

  // Si sigue pendiente y tenemos el token PSE, reconciliamos contra Kushki.
  if (
    state === "pending" &&
    reservation.depositStatus === "pending" &&
    reservation.depositTxId
  ) {
    const result = await reconcile({
      token: reservation.depositTxId,
      reservationId: reservation.id,
      restaurantId: reservation.restaurantId,
    });
    if (result === "approved") {
      await db.reservation.update({
        where: { id: reservation.id },
        data: {
          depositStatus: "paid",
          status: "confirmed",
          holdExpiresAt: null,
        },
      });
      publishOrderEvent(reservation.restaurantId, {
        type: "order.updated",
        orderId: `reservation:${reservation.id}`,
      });
      const origin = (() => {
        try {
          return new URL(
            process.env.APP_PUBLIC_BASE_URL ?? "https://mesapay.co",
          ).origin;
        } catch {
          return "https://mesapay.co";
        }
      })();
      sendReservationConfirmation({
        to: reservation.customerEmail,
        customerName: reservation.customerName,
        restaurantName: reservation.restaurant.name,
        restaurantCity: reservation.restaurant.legalCity,
        tableLabel:
          reservation.table.label ?? `Mesa ${reservation.table.number}`,
        partySize: reservation.partySize,
        startsAt: reservation.startsAt,
        confirmationCode: reservation.confirmationCode,
        autoConfirmed: true,
        locale: reservation.locale,
        manageUrl: `${origin}/r/${slug}/reserva/${reservation.confirmationCode}`,
        depositPaidCents: reservation.depositCents ?? undefined,
      }).catch((e) => console.error("[deposit-return] email", e));
      state = "approved";
    } else {
      state = result;
    }
  }

  return (
    <main className="min-h-dvh bg-bone text-ink flex flex-col items-center justify-center px-6 py-12">
      <div className="max-w-sm w-full text-center">
        <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-muted mb-2">
          {`${t("methodPse")} · ${reservation.restaurant.name}`}
        </div>

        {state === "approved" && (
          <>
            <div className="mx-auto w-14 h-14 rounded-full bg-[#2E6B4C]/15 text-[#1E5339] flex items-center justify-center text-2xl mb-4">
              {"✓"}
            </div>
            <h1 className="font-display text-3xl mb-2">
              {t("depositApprovedTitle")}
            </h1>
            <p className="text-sm text-muted mb-1">
              {reservation.depositCents
                ? t("depositReceivedWithAmount", {
                    amount: fmtCOP(reservation.depositCents),
                  })
                : t("depositReceivedNoAmount")}
            </p>
            <div className="rounded-2xl border border-hairline bg-paper p-4 my-6">
              <div className="font-mono text-[10px] tracking-wider uppercase text-muted">
                {t("reservationCode")}
              </div>
              <div className="font-display text-2xl tracking-wide mt-1">
                {reservation.confirmationCode}
              </div>
            </div>
            <Link
              href={`/r/${slug}/reserva/${reservation.confirmationCode}`}
              className="text-sm text-terracotta hover:underline"
            >
              {t("viewOrCancel")}
            </Link>
          </>
        )}

        {state === "declined" && (
          <>
            <div className="text-5xl mb-3">{"✕"}</div>
            <h1 className="font-display text-2xl mb-2">
              {t("depositDeclinedTitle")}
            </h1>
            <p className="text-sm text-muted mb-6">
              {t("depositDeclinedBody")}
            </p>
            <Link
              href={`/r/${slug}`}
              className="inline-flex items-center justify-center h-10 px-5 rounded-full bg-ink text-bone text-sm font-medium"
            >
              {t("backToReserve")}
            </Link>
          </>
        )}

        {state === "pending" && (
          <>
            <div className="text-5xl mb-3 animate-pulse">{"⏳"}</div>
            <h1 className="font-display text-2xl mb-2">{t("processing")}</h1>
            <p className="text-sm text-muted mb-1">
              {t("processingBody")}
            </p>
            <p className="text-xs text-muted mb-2">
              {t("pageAutoRefresh")}
            </p>
            <meta httpEquiv="refresh" content="3" />
          </>
        )}
      </div>
    </main>
  );
}
