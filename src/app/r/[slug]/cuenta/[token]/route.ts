import { secureApi } from "@/lib/secureApi";
import { db } from "@/lib/db";
import { grantGuestAccess } from "@/lib/guestAccess";
import { redirectTo } from "@/lib/http/redirect";
import { manualInvoicePayLinkStatusPath, payLinkState } from "@/lib/manualInvoicePayLink";

export const dynamic = "force-dynamic";

/**
 * Puerta de entrada del LINK DE PAGO de una factura manual:
 * /r/[slug]/cuenta/[token].
 *
 * El token identifica un `PaymentLink` de `kind = order` del comercio. Si la
 * cuenta sigue abierta, se le da al navegador la cookie de invitado SÓLO de
 * esa orden (nunca de una mesa) y se lo manda al checkout del comensal,
 * que es el cobro de siempre: tarjeta, PSE o Apple Pay por Kushki, 3DS,
 * webhook y la pantalla de "listo" con la factura. Pagada, se lo manda a
 * esa pantalla para que vea el comprobante. Anulada o vencido el link, a la
 * página de estado, que lo dice sin cobrar.
 *
 * El id de la orden jamás viaja en la URL y un token ajeno (de otro
 * comercio, de un link de bonos, de una mesa real) no abre nada: todo lo
 * que no sea un link de factura manual de ESTE comercio termina en la
 * página de estado, que devuelve 404.
 */
async function GETHandler(_req: Request, { params }: { params: Promise<{ slug: string; token: string }> }) {
  const { slug, token } = await params;
  const statusPath = manualInvoicePayLinkStatusPath(slug, token);
  const link = await db.paymentLink.findUnique({
    where: { token },
    select: {
      kind: true,
      status: true,
      expiresAt: true,
      restaurant: { select: { id: true, slug: true } },
      order: { select: { id: true, status: true, table: { select: { kind: true } } } },
    },
  });
  if (!link || link.kind !== "order" || !link.order || link.restaurant.slug !== slug || link.order.table.kind !== "manual") {
    return redirectTo(statusPath);
  }
  const state = payLinkState(link, link.order);
  if (state === "cancelled" || state === "expired") return redirectTo(statusPath);

  // Alcance mínimo: esta orden y nada más. 12 h, como el QR de una mesa.
  await grantGuestAccess({ restaurantId: link.restaurant.id, orderId: link.order.id });
  const payPath = `/t/${encodeURIComponent(slug)}/pay/${encodeURIComponent(link.order.id)}`;
  return redirectTo(state === "paid" ? `${payPath}/done` : payPath);
}

export const GET = secureApi(GETHandler);
