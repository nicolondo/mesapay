import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { secureApi } from "@/lib/secureApi";
import { rateLimit } from "@/lib/rateLimit";
import { normalizeCustomerDocument } from "@/lib/customerDocument";
import { invoiceDocTypeSchema } from "@/lib/invoiceRequestInput";
import {
  LOOKUP_LIMITS,
  LOOKUP_MIN_RESPONSE_MS,
  maskEmail,
  maskName,
  orderAcceptsLookup,
} from "@/lib/invoiceCustomerMemory";
import { createLookupToken, findSavedCustomer } from "@/lib/invoiceCustomerMemoryQueries";
import { DINER_SESSION_COOKIE_PREFIX } from "@/lib/dinerSession";

/**
 * POST /api/tenant/[slug]/orders/[orderId]/invoice-customer — primer paso
 * de la factura personalizada del COMENSAL: escribe tipo y número de
 * documento y, si ya está guardado en ESTE comercio, ve sus datos
 * ENMASCARADOS para reconocerlos ("Ju••• P.", "ju***@gm***.com") y un token
 * para "Usar estos datos". Nunca los datos completos ni el id del cliente.
 *
 * Barreras (ver src/lib/invoiceCustomerMemory.ts):
 *  - `secureApi` exige acceso a ESTA orden (personal, el comensal dueño o la
 *    cookie de invitado de la mesa) y que el origen sea el propio sitio.
 *  - La orden tiene que estar viva (abierta o pagada hace poco).
 *  - Límite de intentos por orden, por sesión y por IP.
 *  - Encontrado o no, la respuesta tiene la misma forma, el mismo estado y
 *    el mismo tiempo mínimo.
 *  - POST y no GET: el documento no viaja en la URL (que sí queda en los
 *    logs del servidor). Y acá nunca se escribe en un log.
 */

const bodySchema = z.object({
  docType: invoiceDocTypeSchema,
  docNumber: z.string().trim().min(4).max(40),
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Huella de la sesión del comensal (cookies de invitado / de cuenta), sin guardar ninguna. */
function sessionFingerprint(req: Request, restaurantId: string): string {
  const header = req.headers.get("cookie") ?? "";
  const values = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => {
      const name = part.slice(0, part.indexOf("="));
      return (
        name.startsWith("mesapay_guest_") ||
        name === DINER_SESSION_COOKIE_PREFIX + restaurantId ||
        name.endsWith("authjs.session-token")
      );
    })
    .sort();
  if (values.length === 0) return "none";
  return createHash("sha256").update(values.join("\n")).digest("hex");
}

async function POSTHandler(
  req: Request,
  { params }: { params: Promise<{ slug: string; orderId: string }> },
) {
  const started = Date.now();
  const { slug, orderId } = await params;
  const tenant = await db.restaurant.findUnique({ where: { slug }, select: { id: true, name: true } });
  if (!tenant) return NextResponse.json({ error: "unknown_tenant" }, { status: 404 });

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const document = normalizeCustomerDocument(parsed.data.docType, parsed.data.docNumber);
  if (!document.ok) return NextResponse.json({ error: "invalid", code: document.error }, { status: 400 });

  const order = await db.order.findFirst({
    where: { id: orderId, restaurantId: tenant.id },
    select: {
      status: true,
      paidAt: true,
      simpleInvoice: { select: { id: true } },
      invoiceRequests: { where: { status: "generated" }, select: { id: true }, take: 1 },
    },
  });
  if (!order) return NextResponse.json({ error: "order_not_found" }, { status: 404 });
  // Facturada antes de cobrar: el adquiriente ya está en la factura.
  const preInvoiced = !!order.simpleInvoice && order.status !== "paid";
  if (preInvoiced || !orderAcceptsLookup(order, order.invoiceRequests.length > 0)) {
    return NextResponse.json({ error: "order_closed" }, { status: 409 });
  }

  // Todos los intentos cuentan, existan o no. Los límites son por orden,
  // por sesión y por IP: quien quisiera probar cédulas necesita mesa,
  // orden y sesión nuevas cada pocos intentos.
  const ip = req.headers.get("x-real-ip") ?? "unattributed";
  const session = sessionFingerprint(req, tenant.id);
  const allowed = await Promise.all([
    rateLimit(`invoice-customer:order:${orderId}`, ...LOOKUP_LIMITS.perOrder),
    rateLimit(`invoice-customer:session:${tenant.id}:${session}`, ...LOOKUP_LIMITS.perSession),
    rateLimit(`invoice-customer:ip:${tenant.id}:${ip}`, ...LOOKUP_LIMITS.perIp),
  ]);
  if (allowed.includes(false)) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(LOOKUP_LIMITS.perOrder[1]) } },
    );
  }

  const customer = await findSavedCustomer(tenant.id, parsed.data.docType, document.docNumber, { forDiner: true });
  const match = customer
    ? {
        token: await createLookupToken(tenant.id, orderId, customer.id),
        name: maskName(customer.customerName),
        email: maskEmail(customer.email),
      }
    : null;

  // Mismo tiempo mínimo encontrado o no.
  const elapsed = Date.now() - started;
  if (elapsed < LOOKUP_MIN_RESPONSE_MS) await sleep(LOOKUP_MIN_RESPONSE_MS - elapsed);
  return NextResponse.json(
    { restaurantName: tenant.name, match },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export const POST = secureApi(POSTHandler);
