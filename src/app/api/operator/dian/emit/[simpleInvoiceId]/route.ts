import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import {
  DianConfigError,
  emisorToSupplierParty,
  loadDianConfig,
  resolveEmisor,
} from "@/lib/dian/config";
import { buildDianInvoiceXml, type DianInvoiceInput } from "@/lib/dian/ubl";
import { signXmlDian } from "@/lib/dian/xades";
import { sendBillSync, sendTestSetAsync, zipInvoice } from "@/lib/dian/soap";
import { transitionAfterSend } from "@/lib/dian/documentState";
import {
  bogotaIssueTime,
  claimDianDocument,
  orderToInvoiceLines,
} from "@/lib/dian/emit";
import { formatInvoiceNumber, type InvoiceSnapshot } from "@/lib/invoice";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["einvoicing"];

/**
 * Emite a la DIAN la factura electrónica de una factura simple ya
 * generada. Idempotente (claimDianDocument): sólo (re)envía lo
 * reintentable. La venta NUNCA se bloquea — un rechazo/caída deja el
 * documento con estado y errores para reintentar.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ simpleInvoiceId: string }> },
) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { simpleInvoiceId } = await params;

  const inv = await db.simpleInvoice.findUnique({
    where: { id: simpleInvoiceId },
    select: {
      id: true,
      restaurantId: true,
      invoiceNumber: true,
      snapshot: true,
      order: {
        select: {
          items: {
            select: {
              nameSnapshot: true,
              qty: true,
              priceCentsSnapshot: true,
              cancelledAt: true,
            },
          },
        },
      },
    },
  });
  if (!inv || inv.restaurantId !== ctx.restaurantId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const claim = await claimDianDocument(simpleInvoiceId, ctx.restaurantId);
  if (!claim) {
    return NextResponse.json({ error: "already_emitted" }, { status: 409 });
  }

  const emisor = await resolveEmisor(ctx.restaurantId);
  let config;
  try {
    config = await loadDianConfig(ctx.restaurantId);
  } catch (err) {
    if (err instanceof DianConfigError) {
      await db.dianDocument.update({
        where: { id: claim.id },
        data: { state: "error", errors: [err.code] },
      });
      return NextResponse.json({ error: err.code }, { status: 400 });
    }
    throw err;
  }
  if (!emisor?.resolution || !emisor.invoicePrefix) {
    return NextResponse.json({ error: "emisor_incomplete" }, { status: 400 });
  }
  const snap = inv.snapshot as unknown as InvoiceSnapshot;
  const invoiceNumber = formatInvoiceNumber(snap, inv.invoiceNumber);
  const now = new Date();
  const issueDate = now.toISOString().slice(0, 10);
  const env: "1" | "2" = config.environment === "produccion" ? "1" : "2";

  // Impuesto: 0% por defecto (la mayoría de las facturas simples no
  // discriminan IVA/INC hoy). La tarifa configurable llega como mejora.
  const lines = orderToInvoiceLines(inv.order.items, 0, "01");
  if (lines.length === 0) {
    await db.dianDocument.update({
      where: { id: claim.id },
      data: { state: "error", errors: ["no_lines"] },
    });
    return NextResponse.json({ error: "no_lines" }, { status: 400 });
  }

  const num = emisor.resolutionFrom ?? inv.invoiceNumber;
  const input: DianInvoiceInput = {
    environment: env,
    softwareId: config.softwareId,
    softwarePin: config.softwarePin,
    technicalKey: config.technicalKey,
    resolution: {
      number: emisor.resolution,
      startDate: issueDate,
      endDate: issueDate,
      prefix: emisor.invoicePrefix,
      from: emisor.resolutionFrom ?? num,
      to: emisor.resolutionTo ?? num,
    },
    invoiceNumber,
    issueDate,
    issueTime: bogotaIssueTime(now),
    supplier: emisorToSupplierParty(emisor),
    customer: {
      name: "Consumidor final",
      companyId: "222222222222",
      idSchemeName: "13",
      taxLevelCode: "R-99-PN",
      taxRegimeCode: "49",
      personType: "2",
    },
    lines,
    paymentMeansCode: "10",
  };

  const built = buildDianInvoiceXml(input);
  const signed = signXmlDian(built.xml, config.cert);
  const zip = await zipInvoice(`${invoiceNumber}.xml`, signed);

  // Habilitación usa test set; producción usa SendBillSync síncrono.
  const result =
    env === "2" && config.testSetId
      ? await sendTestSetAsync(zip, config.testSetId, {
          environment: "habilitacion",
          cert: config.cert,
        })
      : await sendBillSync(zip, {
          environment: config.environment,
          cert: config.cert,
        });
  const t = transitionAfterSend(result, built.cufe);

  await db.dianDocument.update({
    where: { id: claim.id },
    data: {
      state: t.state,
      cufe: t.cufe ?? built.cufe,
      trackId: t.trackId ?? null,
      errors: t.errors.length ? t.errors : undefined,
      xmlZip: new Uint8Array(zip),
      attempts: { increment: 1 },
    },
  });

  return NextResponse.json({
    document: {
      state: t.state,
      cufe: t.cufe,
      qrUrl: t.fiscal ? built.qrUrl : null,
      errors: t.errors,
      statusMessage: result.statusMessage ?? null,
    },
  });
}

/** Estado del documento DIAN de una factura simple (para la UI). */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ simpleInvoiceId: string }> },
) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { simpleInvoiceId } = await params;
  const doc = await db.dianDocument.findUnique({
    where: { simpleInvoiceId },
    select: { restaurantId: true, state: true, cufe: true, errors: true, kind: true },
  });
  if (!doc || doc.restaurantId !== ctx.restaurantId) {
    return NextResponse.json({ document: null });
  }
  return NextResponse.json({ document: doc });
}
