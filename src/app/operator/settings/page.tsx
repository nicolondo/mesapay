import Link from "next/link";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) return <div className="p-6">Sin restaurante.</div>;

  const tenant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: {
      name: true,
      kushkiMerchantId: true,
      kushkiOnboardingStatus: true,
      hasBar: true,
    },
  });
  if (!tenant) return <div className="p-6">Restaurante no encontrado.</div>;

  const status = humanStatus(tenant.kushkiOnboardingStatus);
  const stationsCount = await db.category.count({
    where: { restaurantId, prepStation: { not: "kitchen" } },
  });

  return (
    <div className="p-6 max-w-3xl mx-auto w-full">
      <div className="font-display text-3xl mb-1">Configuración</div>
      <p className="text-sm text-op-muted mb-6">
        Activa pagos, configura datáfonos y revisa la información de tu
        restaurante.
      </p>

      <div className="space-y-3">
        <SettingCard
          href="/operator/settings/pagos"
          title="Pagos"
          subtitle="Onboarding, datos bancarios y datáfonos"
          badge={status.label}
          tint={status.tint}
        />
        <SettingCard
          href="/operator/wallet"
          title="Wallet y dispersiones"
          subtitle="Saldo, movimientos y transferencia al banco"
          badge={tenant.kushkiMerchantId ? "Disponible" : "Bloqueado"}
          tint={
            tenant.kushkiMerchantId
              ? "bg-ok/15 text-ok"
              : "bg-op-bg text-op-muted"
          }
        />
        <SettingCard
          href="/operator/settings/estaciones"
          title="Estaciones de preparación"
          subtitle="A dónde manda los tickets: cocina, bar o refri"
          badge={
            tenant.hasBar
              ? `Bar activo · ${stationsCount} ${
                  stationsCount === 1 ? "categoría" : "categorías"
                } ruteada${stationsCount === 1 ? "" : "s"}`
              : stationsCount > 0
                ? `${stationsCount} ${
                    stationsCount === 1 ? "categoría" : "categorías"
                  } ruteada${stationsCount === 1 ? "" : "s"}`
                : "Todo a cocina"
          }
          tint={
            tenant.hasBar || stationsCount > 0
              ? "bg-ok/15 text-ok"
              : "bg-paper text-op-muted"
          }
        />
      </div>
    </div>
  );
}

function SettingCard({
  href,
  title,
  subtitle,
  badge,
  tint,
}: {
  href: string;
  title: string;
  subtitle: string;
  badge: string;
  tint: string;
}) {
  return (
    <Link
      href={href}
      className="flex items-center gap-4 bg-op-surface border border-op-border rounded-2xl p-5 hover:bg-op-bg transition-colors"
    >
      <div className="flex-1">
        <div className="font-display text-lg">{title}</div>
        <div className="text-sm text-op-muted mt-0.5">{subtitle}</div>
      </div>
      <span
        className={
          "px-3 h-6 inline-flex items-center rounded-full text-[11px] font-medium " +
          tint
        }
      >
        {badge}
      </span>
      <span className="text-op-muted">→</span>
    </Link>
  );
}

function humanStatus(s: string): { label: string; tint: string } {
  switch (s) {
    case "active":
      return { label: "Activo", tint: "bg-ok/15 text-ok" };
    case "in_review":
    case "submitted":
      return { label: "En revisión", tint: "bg-[#C98A2E]/20 text-[#8F6828]" };
    case "rejected":
      return { label: "Rechazado", tint: "bg-danger/15 text-danger" };
    case "suspended":
      return { label: "Suspendido", tint: "bg-danger/15 text-danger" };
    case "docs_uploaded":
      return { label: "Documentos cargados", tint: "bg-paper text-op-muted" };
    default:
      return { label: "No iniciado", tint: "bg-paper text-op-muted" };
  }
}
