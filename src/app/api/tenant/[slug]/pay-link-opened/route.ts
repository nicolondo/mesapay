import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { guestScopes } from "@/lib/guestAccess";
import { staffForRestaurant } from "@/lib/staffAccess";
import { markPayLinkOpened } from "@/lib/manualInvoiceReceivable";

export const dynamic = "force-dynamic";

/**
 * POST /api/tenant/[slug]/pay-link-opened — el cliente ABRIÓ el link de
 * pago de una factura manual. Lo llama la página de cobro al cargar en el
 * navegador (no el redirect del link, que también lo recorren los
 * antivirus de los correos), y queda como "Abierto" en la ficha.
 *
 *   · `{ orderId }` desde el checkout de la orden (cuenta abierta): sólo
 *     con la cookie de invitado de ESA orden, la que deja el link.
 *   · `{ token }` desde la página de monto fijo (factura por cobrar): el
 *     token es el del link.
 *
 * El staff probando su propio link no cuenta. Siempre responde 200 sin
 * decir nada: no es un oráculo de tokens.
 */
const schema = z.union([
  z.object({ orderId: z.string().min(1).max(64) }),
  z.object({ token: z.string().min(1).max(64) }),
]);

async function POSTHandler(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ ok: true });
  const tenant = await db.restaurant.findUnique({ where: { slug }, select: { id: true } });
  if (!tenant) return NextResponse.json({ ok: true });
  if (await staffForRestaurant(tenant.id)) return NextResponse.json({ ok: true });

  if ("token" in parsed.data) {
    const link = await db.paymentLink.findUnique({
      where: { token: parsed.data.token },
      select: { restaurantId: true, kind: true },
    });
    if (link && link.restaurantId === tenant.id && link.kind === "order") {
      await markPayLinkOpened({ token: parsed.data.token });
    }
    return NextResponse.json({ ok: true });
  }
  const orderId = parsed.data.orderId;
  const scopes = await guestScopes(tenant.id);
  if (scopes.some((s) => s.orderId === orderId)) {
    await markPayLinkOpened({ orderId });
  }
  return NextResponse.json({ ok: true });
}

export const POST = secureApi(POSTHandler);
