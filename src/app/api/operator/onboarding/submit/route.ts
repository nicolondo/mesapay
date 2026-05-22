import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import {
  getPaymentProvider,
  saveSubmerchantCredentials,
} from "@/lib/payments";
import { env } from "@/lib/env";

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
 * Final step of the onboarding wizard. The operator has uploaded documents
 * and filled (or verified) the bank info; we package everything for the
 * provider and store the returned credentials.
 *
 * The set of required documents and the partner endpoint will be confirmed
 * once we receive Kushki's partner docs. For now we require at least one
 * bank_cert and one cedula_rep_legal — anything else can be added later
 * from the operator's settings page.
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

  // Mark as submitted before calling the provider so a slow Kushki request
  // doesn't leave the operator clicking "Enviar" repeatedly. If Kushki
  // errors out we roll back below.
  const baseUrl =
    env.APP_PUBLIC_BASE_URL ?? "https://mesapay.co";

  await db.restaurant.update({
    where: { id: restaurantId },
    data: {
      kushkiOnboardingStatus: "submitted",
      kushkiSubmittedAt: new Date(),
      bankInfo: parsed.data.bankInfo,
    },
  });

  try {
    const provider = getPaymentProvider();
    const result = await provider.submitOnboarding({
      legalName: parsed.data.legalName,
      taxId: parsed.data.taxId,
      contactEmail: parsed.data.contactEmail,
      contactPhone: parsed.data.contactPhone,
      bankInfo: parsed.data.bankInfo,
      documents: docs.map((d) => ({
        kind: d.kind,
        fileUrl: d.fileUrl.startsWith("/")
          ? `${baseUrl}${d.fileUrl}`
          : d.fileUrl,
        fileName: d.fileName,
        mimeType: d.mimeType,
      })),
    });

    await saveSubmerchantCredentials(restaurantId, {
      merchantId: result.merchantId,
      publicKey: result.publicKey,
      privateKey: result.privateKey,
    });

    // Provider may return active immediately (mock + some Kushki paths) or
    // in_review. Reflect that on the restaurant row.
    await db.restaurant.update({
      where: { id: restaurantId },
      data: {
        kushkiOnboardingStatus: result.status,
        kushkiActivatedAt: result.status === "active" ? new Date() : null,
        kushkiOnboardingNotes: result.notes ?? null,
      },
    });

    return NextResponse.json({
      ok: true,
      status: result.status,
      merchantId: result.merchantId,
    });
  } catch (err) {
    // Roll the status back so the operator can retry. We surface the error
    // message but keep the submitted bankInfo so they don't re-type.
    await db.restaurant.update({
      where: { id: restaurantId },
      data: {
        kushkiOnboardingStatus: "docs_uploaded",
        kushkiOnboardingNotes:
          err instanceof Error ? err.message.slice(0, 500) : "submit failed",
      },
    });
    return NextResponse.json(
      { error: "submit_failed", detail: err instanceof Error ? err.message : "unknown" },
      { status: 502 },
    );
  }
}
