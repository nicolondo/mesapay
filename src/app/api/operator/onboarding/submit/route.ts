import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import {
  deliverPendingDocsToSftp,
  deliverOnboardingManifest,
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
 */
export async function POST(req: Request) {
  const session = await auth();
  if (
    !session?.user ||
    (session.user.role !== "operator" && session.user.role !== "platform_admin")
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

  // Server-side beneficiary check: the document number on the bank account
  // must match the NIT on the RUT. We compare digits-only so DV, hyphens
  // and spaces don't trip the check.
  const rutId = parsed.data.taxId.replace(/\D/g, "");
  const bankId = parsed.data.bankInfo.holderDocNumber.replace(/\D/g, "");
  if (rutId && bankId && rutId !== bankId) {
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
    bankInfo: parsed.data.bankInfo,
    documents: docs.map((d) => ({
      kind: d.kind,
      fileName: d.fileName,
      mimeType: d.mimeType,
    })),
  };

  const manifestOk = await deliverOnboardingManifest(restaurantId, manifest);
  const docsResult = await deliverPendingDocsToSftp(restaurantId);

  await db.restaurant.update({
    where: { id: restaurantId },
    data: {
      kushkiOnboardingStatus: "in_review",
      kushkiSubmittedAt: new Date(),
      bankInfo: parsed.data.bankInfo,
      kushkiOnboardingNotes: docsResult.configured
        ? `SFTP: ${docsResult.delivered}/${docsResult.total} docs + manifiesto ${manifestOk ? "ok" : "falló"}`
        : "SFTP no configurado en el server — entrega pendiente",
    },
  });

  console.log("[onboarding/submit] entregado por SFTP", {
    restaurantId,
    sftpConfigured: docsResult.configured,
    docsDelivered: docsResult.delivered,
    docsTotal: docsResult.total,
    manifest: manifestOk,
  });

  return NextResponse.json({
    ok: true,
    status: "in_review",
    sftp: {
      configured: docsResult.configured,
      docsDelivered: docsResult.delivered,
      docsTotal: docsResult.total,
      manifest: manifestOk,
    },
  });
}
