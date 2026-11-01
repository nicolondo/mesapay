import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { businessCodeProblem, maskBusinessCode } from "@/lib/payments/businessCode";

/**
 * Guardar el Business-Code del Cloud Terminal (datáfono Kushki) del
 * comercio. Se edita desde Configuración → Datáfonos. "" → null.
 *
 * Rechaza (400) el Merchant ID o la llave pública del comercio: son otras
 * credenciales de Kushki, y con ellas cada cobro rebota con
 * `CLOUDPAYMENT_VALIDATION_ERROR` (ver lib/payments/businessCode.ts).
 * Responde sólo el valor enmascarado: es una clave.
 */
const schema = z.object({
  businessCode: z
    .string()
    .trim()
    .max(64)
    .nullable()
    .transform((v) => (v ? v : null)),
});

function guard(role?: string) {
  return role === "operator" || role === "platform_admin";
}

async function POSTHandler(req: Request) {
  const session = await auth();
  if (!guard(session?.user?.role)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return NextResponse.json({ error: "no_restaurant" }, { status: 400 });
  }
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const code = parsed.data.businessCode;
  if (code) {
    const credentials = await db.restaurant.findUnique({
      where: { id: restaurantId },
      select: { kushkiMerchantId: true, kushkiPublicKey: true },
    });
    const problem = businessCodeProblem(code, credentials ?? {});
    if (problem) return NextResponse.json({ error: problem }, { status: 400 });
  }
  await db.restaurant.update({
    where: { id: restaurantId },
    data: { cloudTerminalBusinessCode: code },
  });
  return NextResponse.json({ ok: true, masked: maskBusinessCode(code) });
}

export const POST = secureApi(POSTHandler);
