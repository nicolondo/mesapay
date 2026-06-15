import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { WalletClient } from "./WalletClient";

export const dynamic = "force-dynamic";

type AutoPolicy =
  | { enabled: false }
  | {
      enabled: true;
      mode: "daily" | "weekly" | "threshold";
      thresholdCents?: number;
      weekdays?: number[];
      time?: string;
    };

function normalisePolicy(raw: unknown): AutoPolicy {
  if (!raw || typeof raw !== "object") return { enabled: false };
  const r = raw as Record<string, unknown>;
  if (r.enabled !== true) return { enabled: false };
  const mode =
    r.mode === "daily" || r.mode === "weekly" || r.mode === "threshold"
      ? r.mode
      : "daily";
  return {
    enabled: true,
    mode,
    thresholdCents:
      typeof r.thresholdCents === "number" ? r.thresholdCents : undefined,
    weekdays:
      Array.isArray(r.weekdays) && r.weekdays.every((n) => typeof n === "number")
        ? (r.weekdays as number[])
        : undefined,
    time: typeof r.time === "string" ? r.time : undefined,
  };
}

export default async function WalletPage() {
  const t = await getTranslations("opWallet");
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) return <div className="p-6">{t("noRestaurant")}</div>;

  const tenant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: {
      name: true,
      kushkiMerchantId: true,
      kushkiOnboardingStatus: true,
      bankInfo: true,
      autoDispersePolicy: true,
    },
  });
  if (!tenant) return <div className="p-6">{t("notFound")}</div>;

  // Wallet y dispersiones solo aplican cuando Pagos está "Listo para cobrar"
  // (onboarding Kushki activo). Antes de eso no hay saldo que mover → volver
  // a ajustes (también evita verla entrando por URL directa).
  if (tenant.kushkiOnboardingStatus !== "active") {
    redirect("/operator/settings");
  }

  const movements = await db.walletMovement.findMany({
    where: { restaurantId },
    orderBy: { occurredAt: "desc" },
    take: 50,
  });

  const bank =
    (tenant.bankInfo as Record<string, unknown> | null) ?? null;
  const bankLabel =
    bank && typeof bank.bankName === "string"
      ? `${bank.bankName} · ${typeof bank.accountNumber === "string" ? "•••• " + bank.accountNumber.slice(-4) : ""}`
      : null;

  return (
    <WalletClient
      tenantName={tenant.name}
      onboarded={
        !!tenant.kushkiMerchantId &&
        tenant.kushkiOnboardingStatus === "active"
      }
      bankLabel={bankLabel}
      initialMovements={movements.map((m) => ({
        id: m.id,
        kind: m.kind,
        amountCents: m.amountCents,
        balanceAfterCents: m.balanceAfterCents,
        description: m.description ?? "",
        occurredAt: m.occurredAt.toISOString(),
      }))}
      initialPolicy={normalisePolicy(tenant.autoDispersePolicy)}
    />
  );
}
