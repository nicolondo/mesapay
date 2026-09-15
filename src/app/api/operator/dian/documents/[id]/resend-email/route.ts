import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { dianEnvironment } from "@/lib/dian/config";
import { sendDianInvoiceEmail } from "@/lib/dian/sendInvoiceEmail";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["einvoicing"];

/**
 * Reenvía al adquiriente la factura electrónica de un documento ACEPTADO.
 *
 * El envío automático (los dos rieles de la aceptación) sólo ocurre en el
 * instante en que la DIAN acepta, y no cubre nada de lo que pasa después:
 * el correo que rebota, el que el cliente borró, la dirección que se
 * corrigió más tarde — ni las facturas que se aceptaron ANTES de que ese
 * envío existiera, que quedaron con `emailedAt` en null y sin forma de
 * salir. Esta es esa forma.
 *
 * Por eso va con `force`: el envío automático es idempotente por
 * `emailedAt` (así los dos rieles no mandan dos correos), y reenviar es
 * exactamente lo que esa idempotencia impide.
 */
async function POSTHandler(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { id } = await params;

  const doc = await db.dianDocument.findUnique({
    where: { id },
    select: { id: true, restaurantId: true, state: true },
  });
  // 404 y no 403 para el documento de otro comercio: la existencia de un
  // id ajeno no es información que este comercio tenga por qué recibir.
  if (!doc || doc.restaurantId !== ctx.restaurantId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (doc.state !== "accepted") {
    // Sin aceptación no hay documento fiscal: lo que se mandaría no sería
    // una factura electrónica sino un papel sin valor.
    return NextResponse.json({ error: "not_accepted" }, { status: 400 });
  }

  const environment = await dianEnvironment(ctx.restaurantId);
  if (!environment) {
    return NextResponse.json({ error: "no_config" }, { status: 400 });
  }

  const result = await sendDianInvoiceEmail({
    documentId: doc.id,
    environment,
    force: true,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.reason }, { status: 400 });
  }

  return NextResponse.json({
    sentTo: result.to,
    emailedAt: result.emailedAt,
    // false ⇒ salió el correo pero sin el AttachedDocument (faltaba el XML
    // firmado o el acuse). Vale la pena que el operador lo sepa.
    attachment: result.attachment,
  });
}

export const POST = secureApi(POSTHandler);
