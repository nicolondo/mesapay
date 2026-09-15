import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { compareBeneficiaryIds } from "@/lib/beneficiaryIdentity";
import {
  deliverPendingDocsToSftp,
  deliverOnboardingManifest,
  deliverOnboardingWorkbook,
  fileNameForSftpDocument,
} from "@/lib/onboardingSftp";

const bankInfoSchema = z.object({
  bankName: z.string().min(1).max(80),
  accountType: z.enum(["ahorros", "corriente"]),
  accountNumber: z.string().min(4).max(40),
  holderName: z.string().min(2).max(120),
  holderDocType: z.enum(["CC", "CE", "NIT", "PA"]),
  holderDocNumber: z.string().min(4).max(40),
  source: z.enum(["manual", "ai_extracted"]).default("manual"),
  aiConfidence: z.number().min(0).max(1).optional(),
});

const submitSchema = z.object({
  legalName: z.string().min(2).max(160),
  taxId: z.string().min(4).max(40),
  contactEmail: z.string().email(),
  contactPhone: z.string().min(6).max(32),
  // Representante legal: obligatorio porque el formulario de alta de Kushki
  // (hoja "Datos de Negocio") lo exige y no sale de ningún documento.
  legalRepName: z.string().min(2).max(160),
  legalRepDocNumber: z.string().min(4).max(40),
  bankInfo: bankInfoSchema,
});

/**
 * Paso final del wizard de onboarding. La entrega a Kushki es por SFTP, NO por
 * la API de partner: el KYC (documentos + datos del comercio) se deposita en la
 * carpeta del comercio en el SFTP de Kushki, ellos revisan y provisionan el
 * sub-merchant fuera de línea, y las credenciales (public/private key) se cargan
 * después. Acá: validamos, entregamos documentos pendientes + un manifiesto
 * JSON al SFTP, y marcamos el comercio como `submitted`/`in_review`.
 *
 * Requerimos al menos un bank_cert y un cedula_rep_legal; el resto se puede
 * agregar luego desde la página de pagos.
 *
 * Junto al manifiesto va el formulario de alta de Salesforce/Kushki en Excel
 * (misma data, en el formato que ellos cargan) — ver onboardingWorkbook.ts.
 */
async function POSTHandler(req: Request) {
  const session = await auth();
  if (
    !session?.user ||
    (session.user.role !== "operator" &&
      session.user.role !== "platform_admin" &&
      session.user.role !== "group_admin")
  ) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return NextResponse.json({ error: "no restaurant" }, { status: 400 });
  }

  const body = await req.json().catch(() => null);
  const parsed = submitSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid payload", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const docs = await db.kushkiDocument.findMany({
    where: { restaurantId },
    orderBy: { createdAt: "desc" },
  });
  const haveCedula = docs.some((d) => d.kind === "cedula_rep_legal");
  const haveBank = docs.some((d) => d.kind === "bank_cert");
  if (!haveCedula || !haveBank) {
    return NextResponse.json(
      {
        error: "documents_incomplete",
        missing: [
          ...(!haveCedula ? ["cedula_rep_legal"] : []),
          ...(!haveBank ? ["bank_cert"] : []),
        ],
      },
      { status: 400 },
    );
  }

  const restaurant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: {
      country: true,
      // Ciudad y dirección para el formulario de alta: primero la legal (la
      // del RUT), si no la operativa.
      legalAddress: true,
      legalCity: true,
      address: true,
      city: true,
    },
  });
  if (!restaurant)
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  const { matches, rutId, bankId } = compareBeneficiaryIds({
    taxId: parsed.data.taxId,
    holderDocNumber: parsed.data.bankInfo.holderDocNumber,
    holderDocType: parsed.data.bankInfo.holderDocType,
    country: restaurant.country ?? "CO",
  });
  if (!matches) {
    return NextResponse.json(
      {
        error: "beneficiary_mismatch",
        rutId,
        bankId,
      },
      { status: 400 },
    );
  }

  // Entrega por SFTP: manifiesto de datos + documentos pendientes. Best-effort
  // (los helpers no lanzan) — si el SFTP no está configurado en el server, el
  // comercio igual queda `submitted` y la entrega se completa cuando se
  // configuren las credenciales (o vía reintento). Nunca dejamos al operador
  // trabado por infraestructura del lado plataforma.
  const manifest = {
    restaurantId,
    submittedAt: new Date().toISOString(),
    legalName: parsed.data.legalName,
    taxId: parsed.data.taxId,
    contactEmail: parsed.data.contactEmail,
    contactPhone: parsed.data.contactPhone,
    legalRepName: parsed.data.legalRepName,
    legalRepDocNumber: parsed.data.legalRepDocNumber,
    bankInfo: parsed.data.bankInfo,
    documents: docs.map((d) => ({
      kind: d.kind,
      fileName: fileNameForSftpDocument(d),
      mimeType: d.mimeType,
    })),
  };

  const manifestOk = await deliverOnboardingManifest(restaurantId, manifest);
  const workbookOk = await deliverOnboardingWorkbook(restaurantId, {
    legalName: manifest.legalName,
    taxId: manifest.taxId,
    city: restaurant.legalCity ?? restaurant.city ?? null,
    address: restaurant.legalAddress ?? restaurant.address ?? null,
    legalRepName: manifest.legalRepName,
    legalRepDocNumber: manifest.legalRepDocNumber,
    contactEmail: manifest.contactEmail,
    contactPhone: manifest.contactPhone,
  });
  const docsResult = await deliverPendingDocsToSftp(restaurantId, {
    legalName: manifest.legalName,
    taxId: manifest.taxId,
  });
  const status =
    manifestOk &&
    workbookOk &&
    docsResult.configured &&
    docsResult.delivered === docsResult.total
      ? "in_review"
      : "submitted";

  await db.restaurant.update({
    where: { id: restaurantId },
    data: {
      kushkiOnboardingStatus: status,
      kushkiSubmittedAt: new Date(),
      bankInfo: parsed.data.bankInfo,
      legalRepName: parsed.data.legalRepName,
      legalRepDocNumber: parsed.data.legalRepDocNumber,
      // La página lee "manifiesto ok" de acá con una regex: no cambiar el literal.
      kushkiOnboardingNotes: docsResult.configured
        ? `SFTP: ${docsResult.delivered}/${docsResult.total} docs + manifiesto ${manifestOk ? "ok" : "falló"} + excel ${workbookOk ? "ok" : "falló"}`
        : "SFTP no configurado en el server — entrega pendiente",
    },
  });

  console.log("[onboarding/submit] entregado por SFTP", {
    restaurantId,
    sftpConfigured: docsResult.configured,
    docsDelivered: docsResult.delivered,
    docsTotal: docsResult.total,
    manifest: manifestOk,
    workbook: workbookOk,
  });

  return NextResponse.json({
    ok: true,
    status,
    sftp: {
      configured: docsResult.configured,
      docsDelivered: docsResult.delivered,
      docsTotal: docsResult.total,
      manifest: manifestOk,
      workbook: workbookOk,
    },
  });
}

export const POST = secureApi(POSTHandler);
