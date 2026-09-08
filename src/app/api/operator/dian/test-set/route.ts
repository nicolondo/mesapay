import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import {
  DianConfigError,
  emisorResolution,
  emisorToSupplierParty,
  loadDianConfig,
  missingLocationFields,
  missingResolutionFields,
  resolveEmisor,
} from "@/lib/dian/config";
import {
  buildDianInvoiceXml,
  splitTaxIncludedCents,
  type DianInvoiceInput,
} from "@/lib/dian/ubl";
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
  // La resolución se valida ANTES de enviar: mandar un número, un
  // prefijo o unas fechas que no existen en el registro del
  // contribuyente es un rechazo garantizado (FAB05b…FAB12b, FAD05c).
  const missingResolution = missingResolutionFields(emisor);
  const resolution = emisorResolution(emisor);
  if (!resolution) {
    return NextResponse.json(
      { error: "resolution_incomplete", missingResolution },
      { status: 400 },
    );
  }
  // Misma lógica para la ubicación: sin el código DANE real del
  // establecimiento no se envía. Antes se mandaba Bogotá por defecto y la
  // DIAN resolvía mal el punto de facturación (FAB10a / FAJ50).
  const missingLocation = missingLocationFields(emisor);
  if (missingLocation.length > 0) {
    return NextResponse.json(
      { error: "location_incomplete", missingLocation },
      { status: 400 },
    );
  }

  // Impuesto de venta del comercio: el documento de prueba tiene que
  // parecerse a lo que va a emitir de verdad.
  const tenant = await db.restaurant.findUnique({
    where: { id: ctx.restaurantId },
    select: { salesTaxKind: true, salesTaxPct: true },
  });
  const restaurantTax = {
    kind: (tenant?.salesTaxKind ?? "none") as "none" | "inc" | "iva",
    pct: tenant?.salesTaxPct ?? 0,
  };
  const testTaxPct = restaurantTax.kind === "none" ? 0 : restaurantTax.pct;
  const testLine = splitTaxIncludedCents(100_000, testTaxPct * 100);

  // Número dentro del rango autorizado.
  const num = resolution.from;
  const invoiceNumber = `${resolution.prefix}${num}`;
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
    resolution,
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
    // Línea representativa: mismo régimen de impuesto que la carta del
    // comercio (precio con el impuesto por dentro), no un 0% ficticio.
    lines: [
      {
        description: "Servicio de prueba de habilitación",
        quantity: 1,
        itemCode: "PRUEBA-1",
        unitPriceCents: testLine.baseCents,
        lineTotalCents: testLine.baseCents,
        taxCents: testLine.taxCents,
        taxPct: testTaxPct.toFixed(2),
        taxSchemeId: restaurantTax.kind === "inc" ? "04" : "01",
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

  const doc = await db.dianDocument.create({
    data: {
      restaurantId: ctx.restaurantId,
      kind: "invoice",
      state: t.state,
      cufe: t.cufe ?? built.cufe,
      trackId: t.trackId ?? null,
      errors: t.errors.length ? t.errors : undefined,
      responseXml: result.raw ?? null,
      // El ZIP firmado también se guarda: sin él no hay forma de
      // reproducir qué se envió cuando la DIAN devuelve reglas.
      xmlZip: new Uint8Array(zip),
      attempts: 1,
    },
    select: { id: true },
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
      id: doc.id,
      state: t.state,
      cufe: t.cufe,
      trackId: t.trackId,
      errors: t.errors,
      statusMessage: result.statusMessage ?? null,
    },
  });
}
