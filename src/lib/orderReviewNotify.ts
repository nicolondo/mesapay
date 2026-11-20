import { getTranslations } from "next-intl/server";
import { db } from "./db";
import { formatDate } from "./format";
import { defaultLocale } from "@/i18n/config";
import { sendPushToMeserosForTable } from "./push";
import { ORDER_REVIEW_SELECT, reviewFlagsOf } from "./orderReview";
import { orderReviewLines } from "./orderReviewText";

/**
 * El COMENSAL montó una ronda desde su QR y esa ronda disparó un aviso
 * «Revisar» (src/lib/orderReviewFlags.ts): él no puede decidir si sigue
 * siendo la misma cuenta, así que se avisa por push a los meseros de esa
 * mesa. La marca en la mesa (Mesas) sale sola: se calcula al pintarla.
 *
 * Sólo señales NACIDAS con esta ronda (su `since` es la ronda): una señal
 * vieja ya se avisó o el personal ya la vio. Best effort: nunca lanza.
 */
export async function notifyMeserosIfReviewNeeded(args: {
  restaurantId: string;
  orderId: string;
  roundPlacedAt: Date;
}): Promise<void> {
  try {
    const row = await db.order.findUnique({ where: { id: args.orderId }, select: ORDER_REVIEW_SELECT });
    if (!row) return;
    const flags = reviewFlagsOf(row);
    const fresh = flags.filter((f) => f.since.getTime() === args.roundPlacedAt.getTime());
    if (!fresh.length) return;
    // Los meseros no tienen idioma guardado: el push sale en el idioma por
    // defecto del producto, igual que los demás avisos al personal.
    const t = await getTranslations({ locale: defaultLocale, namespace: "orderReview" });
    const lines = orderReviewLines(
      {
        flags: fresh.map((f) => f.kind),
        customerName: row.discountBillingCustomer?.customerName ?? null,
        discountPct: row.discountPct,
        discountAppliedAt: row.discountAppliedAt?.toISOString() ?? null,
        openedAt: row.createdAt.toISOString(),
      },
      (key, values) => t(key, values),
      (iso) => formatDate(iso, { locale: defaultLocale, dateStyle: undefined, timeStyle: "short" }),
    );
    if (!lines.length) return;
    await sendPushToMeserosForTable(args.restaurantId, row.table.number, {
      title: t("pushTitle", { number: row.table.number }),
      body: lines.join(" "),
      tag: `review-${args.orderId}`,
      url: "/mesero/mesas",
    });
  } catch (err) {
    console.error("[push:order-review]", err);
  }
}
