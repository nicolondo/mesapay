import { getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { OnboardingClient } from "./OnboardingClient";

export const dynamic = "force-dynamic";

export default async function KushkiOnboardingPage() {
  const t = await getTranslations("opPagos");
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) return <div className="p-6">{t("noRestaurant")}</div>;

  const tenant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: {
      id: true,
      name: true,
      slug: true,
      kushkiMerchantId: true,
      kushkiOnboardingStatus: true,
      kushkiOnboardingNotes: true,
      kushkiSubmittedAt: true,
      kushkiActivatedAt: true,
      bankInfo: true,
      // Datos legales ya guardados (los llena el OCR del RUT en el primer
      // envío). Sin esto el formulario arrancaba vacío en cada visita.
      legalName: true,
      taxId: true,
      legalPhone: true,
    },
  });
  if (!tenant) return <div className="p-6">{t("restaurantNotFound")}</div>;

  const documents = await db.kushkiDocument.findMany({
    where: { restaurantId },
    orderBy: { createdAt: "desc" },
  });

  return (
    <OnboardingClient
      tenant={{
        name: tenant.name,
        status: tenant.kushkiOnboardingStatus,
        notes: tenant.kushkiOnboardingNotes,
        merchantId: tenant.kushkiMerchantId,
        submittedAt: tenant.kushkiSubmittedAt?.toISOString() ?? null,
        activatedAt: tenant.kushkiActivatedAt?.toISOString() ?? null,
      }}
      initialBankInfo={
        tenant.bankInfo as Record<string, unknown> | null
      }
      initialLegal={{
        legalName: tenant.legalName,
        taxId: tenant.taxId,
        legalPhone: tenant.legalPhone,
      }}
      initialDocuments={documents.map((d) => ({
        id: d.id,
        kind: d.kind,
        fileName: d.fileName,
        fileUrl: d.fileUrl,
        mimeType: d.mimeType,
        fileSize: d.fileSize,
        extractedFields:
          (d.extractedFields as Record<string, unknown> | null) ?? null,
      }))}
    />
  );
}
