import { NextResponse } from "next/server";
import { z } from "zod";
import { secureApi } from "@/lib/secureApi";
import { requireOperatorScope, isScopeError } from "@/lib/operatorScope";
import { rateLimit } from "@/lib/rateLimit";
import { BILLING_CUSTOMER_READ_ROLES } from "@/lib/billingCustomers";
import { normalizeCustomerDocument } from "@/lib/customerDocument";
import { invoiceDocTypeSchema } from "@/lib/invoiceRequestInput";
import { findSavedCustomer } from "@/lib/invoiceCustomerMemoryQueries";

/**
 * POST /api/operator/billing-customers/lookup — el PERSONAL escribe el
 * documento del cliente al pedir la factura personalizada y, si está
 * guardado en este comercio, recibe el registro COMPLETO para revisarlo y
 * corregirlo (como en Clientes). Los mismos roles que pueden ver Clientes;
 * el comercio sale de la sesión, nunca del cuerpo.
 *
 * POST para que el documento no quede en la URL ni en los logs.
 */
const bodySchema = z.object({
  docType: invoiceDocTypeSchema,
  docNumber: z.string().trim().min(4).max(40),
});

async function POSTHandler(req: Request) {
  const scope = await requireOperatorScope(BILLING_CUSTOMER_READ_ROLES);
  if (isScopeError(scope)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!await rateLimit(`billing-customers:lookup:${scope.restaurantId}:${scope.userId}`, 120, 60)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": "60" } });
  }
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const document = normalizeCustomerDocument(parsed.data.docType, parsed.data.docNumber);
  if (!document.ok) return NextResponse.json({ error: "invalid", code: document.error }, { status: 400 });
  const row = await findSavedCustomer(scope.restaurantId, parsed.data.docType, document.docNumber);
  if (!row) return NextResponse.json({ customer: null }, { headers: { "Cache-Control": "no-store" } });
  // Fuera lo interno: conteos y marcas de la memoria no son del formulario.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { _count, selfService, rememberOptOutAt, updatedAt, restaurantId, ...customer } = row;
  return NextResponse.json({ customer }, { headers: { "Cache-Control": "no-store" } });
}

export const POST = secureApi(POSTHandler);
