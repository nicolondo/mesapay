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
import { sendTestSetAsync, zipInvoice } from "@/lib/dian/soap";
import { transitionAfterSend } from "@/lib/dian/documentState";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["einvoicing"];

/**
 * Corre el set de pruebas de habilitación (spec D4): construye una
 * factura representativa desde los datos legales del comercio, la firma
 * con su certificado, la envía a SendTestSetAsync y registra el
 * DianDocument. Requiere ambiente habilitación + testSetId + credenciales
 * completas. NUNCA bloquea: los errores de la DIAN se devuelven legibles.
 */
export async function POST() {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const emisor = await resolveEmisor(ctx.restaurantId);
  if (!emisor) return NextResponse.json({ error: "no_emisor" }, { status: 400 });

  let config;
  try {
    config = await loadDianConfig(ctx.restaurantId);
  } catch (err) {
    if (err instanceof DianConfigError) {
      return NextResponse.json({ error: err.code }, { status: 400 });
    }
    throw err;
  }
  if (config.environment !== "habilitacion") {
    return NextResponse.json({ error: "not_habilitacion" }, { status: 400 });
  }
  if (!config.testSetId) {
    return NextResponse.json({ error: "no_test_set" }, { status: 400 });
  }
  if (!emisor.resolution || !emisor.invoicePrefix) {
    return NextResponse.json({ error: "emisor_incomplete" }, { status: 400 });
  }

  // Número dentro del rango autorizado (from si existe, si no 990000001).
  const num = emisor.resolutionFrom ?? 990000001;
  const invoiceNumber = `${emisor.invoicePrefix}${num}`;
  const now = new Date();
  const issueDate = now.toISOString().slice(0, 10);
  const issueTime =
    now.toLocaleTimeString("en-GB", { hour12: false, timeZone: "America/Bogota" }) +
    "-05:00";

  const input: DianInvoiceInput = {
    environment: "2",
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
    issueTime,
    supplier: emisorToSupplierParty(emisor),
    customer: {
      name: "Consumidor final",
      companyId: "222222222222",
      idSchemeName: "13",
      taxLevelCode: "R-99-PN",
      taxRegimeCode: "49",
      personType: "2",
    },
    lines: [
      {
        description: "Servicio de prueba de habilitación",
        quantity: 1,
        unitPriceCents: 100_000,
        lineTotalCents: 100_000,
        taxCents: 0,
        taxPct: "0.00",
        taxSchemeId: "01",
      },
    ],
    paymentMeansCode: "10",
    note: "Documento de prueba — set de habilitación DIAN",
  };

  const built = buildDianInvoiceXml(input);
  const signed = signXmlDian(built.xml, config.cert);
  const zip = await zipInvoice(`${invoiceNumber}.xml`, signed);

  const result = await sendTestSetAsync(zip, config.testSetId, {
    environment: "habilitacion",
    cert: config.cert,
  });
  const t = transitionAfterSend(result, built.cufe);

  await db.dianDocument.create({
    data: {
      restaurantId: ctx.restaurantId,
      kind: "invoice",
      state: t.state,
      cufe: t.cufe ?? built.cufe,
      trackId: t.trackId ?? null,
      errors: t.errors.length ? t.errors : undefined,
      attempts: 1,
    },
  });

  // Al aceptar/quedar pendiente, el comercio ya está "en pruebas".
  if (t.state === "accepted" || t.state === "pending") {
    await db.dianConfig.update({
      where: { id: config.configId },
      data: { status: "testing" },
    });
  }

  return NextResponse.json({
    result: {
      state: t.state,
      cufe: t.cufe,
      trackId: t.trackId,
      errors: t.errors,
      statusMessage: result.statusMessage ?? null,
    },
  });
}
