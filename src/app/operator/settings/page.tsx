import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { resolveMenuTags } from "@/lib/menuTags";
import { isModuleEnabled, type ModuleSlug } from "@/lib/modules";
import { resolveEnabledPaymentMethods } from "@/lib/paymentMethods";
import {
  resolveTipPolicy,
  resolveShiftPolicy,
} from "@/lib/staffPolicies";

export const dynamic = "force-dynamic";

// Módulos ERP cuya activación hace visible el catálogo de insumos (basta
// con uno — mismo gate que la página y la API).
const INSUMOS_GATE: ModuleSlug[] = ["inventory", "purchasing", "recipes"];

export default async function SettingsPage() {
  const t = await getTranslations("opSettings");
  const tErp = await getTranslations("opErp");
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) return <div className="p-6">{t("noRestaurant")}</div>;

  const tenant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: {
      name: true,
      kushkiMerchantId: true,
      kushkiOnboardingStatus: true,
      hasBar: true,
      menuTags: true,
      tipPolicy: true,
      shiftPolicy: true,
      logoUrl: true,
      legalName: true,
      taxId: true,
      dianResolution: true,
      reservationsEnabled: true,
      enabledPaymentMethods: true,
      enabledModules: true,
    },
  });
  if (!tenant) return <div className="p-6">{t("restaurantNotFound")}</div>;

  // La tarjeta de datáfonos solo aplica si el comercio tiene activado el
  // cobro por datáfono Kushki (kushki_card_terminal).
  const showDatafonos = resolveEnabledPaymentMethods(
    tenant.enabledPaymentMethods,
  ).includes("kushki_card_terminal");

  // Wallet y dispersiones solo aplican cuando Pagos está "Listo para cobrar"
  // (onboarding Kushki activo): antes de eso no hay saldo que mover.
  const showWallet = tenant.kushkiOnboardingStatus === "active";

  // Catálogo de insumos (ERP track A): la card solo existe con algún
  // módulo activado — con todo apagado el comercio no ve nada del ERP.
  const showInsumos = INSUMOS_GATE.some((m) =>
    isModuleEnabled(tenant.enabledModules, m),
  );
  const ingredientCount = showInsumos
    ? await db.ingredient.count({ where: { restaurantId } })
    : 0;

  // Reservas próximas (confirmadas/pendientes futuras) para el badge.
  const upcomingReservations = await db.reservation.count({
    where: {
      restaurantId,
      startsAt: { gte: new Date() },
      status: { in: ["pending", "confirmed"] },
    },
  });

  const status = humanStatus(tenant.kushkiOnboardingStatus);
  const tipPol = resolveTipPolicy(tenant.tipPolicy);
  const shiftPol = resolveShiftPolicy(tenant.shiftPolicy);
  const stationsCount = await db.category.count({
    where: { restaurantId, prepStation: { not: "kitchen" } },
  });
  const tagCount = resolveMenuTags(tenant.menuTags).length;
  const [deviceCount, deviceAssigned] = await Promise.all([
    db.terminalDevice.count({ where: { restaurantId } }),
    db.terminalDevice.count({
      where: { restaurantId, assignedUserId: { not: null } },
    }),
  ]);
  const [meseroCount, meserosWithRange, staffCount] = await Promise.all([
    db.user.count({ where: { restaurantId, role: "mesero" } }),
    db.user.count({
      where: {
        restaurantId,
        role: "mesero",
        // Postgres `Int[]` non-empty check via NOT isEmpty.
        NOT: { assignedTableNumbers: { isEmpty: true } },
      },
    }),
    db.user.count({
      where: {
        restaurantId,
        role: { in: ["operator", "mesero", "kitchen", "bar", "terminal"] },
      },
    }),
  ]);

  const stationsRouted = t("badgeStationsRouted", { count: stationsCount });

  return (
    <div className="p-6 max-w-3xl mx-auto w-full">
      <div className="font-display text-3xl mb-1">{t("landingTitle")}</div>
      <p className="text-sm text-op-muted mb-6">{t("landingSubtitle")}</p>

      <div className="space-y-3">
        <SettingCard
          href="/operator/settings/identidad"
          title={t("cardIdentityTitle")}
          subtitle={t("cardIdentitySubtitle")}
          badge={
            tenant.logoUrl && tenant.legalName && tenant.taxId
              ? t("badgeComplete")
              : tenant.logoUrl || tenant.legalName
                ? t("badgePartial")
                : t("badgeUnconfigured")
          }
          tint={
            tenant.logoUrl && tenant.legalName && tenant.taxId
              ? "bg-ok/15 text-ok"
              : tenant.logoUrl || tenant.legalName
                ? "bg-[#C98A2E]/20 text-[#8F6828]"
                : "bg-paper text-op-muted"
          }
        />
        <SettingCard
          href="/operator/settings/usuarios"
          title={t("cardUsersTitle")}
          subtitle={t("cardUsersSubtitle")}
          badge={t("badgeUsers", { count: staffCount })}
          tint={
            staffCount > 0
              ? "bg-ok/15 text-ok"
              : "bg-paper text-op-muted"
          }
        />
        <SettingCard
          href="/operator/settings/pagos"
          title={t("cardPaymentsTitle")}
          subtitle={t("cardPaymentsSubtitle")}
          badge={t(status.statusKey)}
          tint={status.tint}
        />
        {showWallet && (
          <SettingCard
            href="/operator/wallet"
            title={t("cardWalletTitle")}
            subtitle={t("cardWalletSubtitle")}
            badge={t("badgeWalletAvailable")}
            tint="bg-ok/15 text-ok"
          />
        )}
        <SettingCard
          href="/operator/settings/etiquetas"
          title={t("cardTagsTitle")}
          subtitle={t("cardTagsSubtitle")}
          badge={t("badgeTags", { count: tagCount })}
          tint="bg-paper text-op-muted"
        />
        {showInsumos && (
          <SettingCard
            href="/operator/settings/insumos"
            title={tErp("cardInsumosTitle")}
            subtitle={tErp("cardInsumosSubtitle")}
            badge={tErp("badgeInsumos", { count: ingredientCount })}
            tint={
              ingredientCount > 0
                ? "bg-ok/15 text-ok"
                : "bg-paper text-op-muted"
            }
          />
        )}
        <SettingCard
          href="/operator/settings/traducciones"
          title={t("cardTranslationsTitle")}
          subtitle={t("cardTranslationsSubtitle")}
          badge={t("badgeTranslate")}
          tint="bg-paper text-op-muted"
        />
        {/* Solo cuando el comercio cobra por datáfono Kushki: ahí entra a
            dar de alta su datáfono y cargar el serial (Cloud Terminal API). */}
        {showDatafonos && (
          <SettingCard
            href="/operator/settings/datafonos"
            title={t("cardDevicesTitle")}
            subtitle={t("cardDevicesSubtitle")}
            badge={
              deviceCount === 0
                ? t("badgeDevicesEmpty")
                : deviceAssigned === 0
                  ? t("badgeDevicesUnassigned", { count: deviceCount })
                  : t("badgeDevicesAssigned", {
                      assigned: deviceAssigned,
                      total: deviceCount,
                    })
            }
            tint={
              deviceAssigned > 0
                ? "bg-ok/15 text-ok"
                : "bg-paper text-op-muted"
            }
          />
        )}
        <SettingCard
          href="/operator/settings/staff-policies"
          title={t("cardPoliciesTitle")}
          subtitle={t("cardPoliciesSubtitle")}
          badge={`${t("tip_" + tipPol)} · ${t("shift_" + shiftPol)}`}
          tint="bg-paper text-op-muted"
        />
        {meseroCount > 0 && (
          <SettingCard
            href="/operator/settings/meseros"
            title={t("cardMeserosTitle")}
            subtitle={t("cardMeserosSubtitle")}
            badge={
              meserosWithRange === 0
                ? t("badgeMeserosSeeAll", { count: meseroCount })
                : t("badgeMeserosAssigned", {
                    assigned: meserosWithRange,
                    total: meseroCount,
                  })
            }
            tint={
              meserosWithRange > 0
                ? "bg-ok/15 text-ok"
                : "bg-paper text-op-muted"
            }
          />
        )}
        <SettingCard
          href="/operator/settings/estaciones"
          title={t("cardStationsTitle")}
          subtitle={t("cardStationsSubtitle")}
          badge={
            tenant.hasBar
              ? t("badgeBarActive", { routed: stationsRouted })
              : stationsCount > 0
                ? stationsRouted
                : t("badgeAllToKitchen")
          }
          tint={
            tenant.hasBar || stationsCount > 0
              ? "bg-ok/15 text-ok"
              : "bg-paper text-op-muted"
          }
        />
        <SettingCard
          href="/operator/settings/reservas"
          title={t("cardReservasTitle")}
          subtitle={t("cardReservasSubtitle")}
          badge={
            tenant.reservationsEnabled
              ? upcomingReservations > 0
                ? t("badgeReservasActiveUpcoming", {
                    count: upcomingReservations,
                  })
                : t("badgeReservasActive")
              : t("badgeReservasDisabled")
          }
          tint={
            tenant.reservationsEnabled
              ? "bg-ok/15 text-ok"
              : "bg-paper text-op-muted"
          }
        />
        {tenant.reservationsEnabled && (
          <SettingCard
            href="/operator/settings/mesas"
            title={t("cardMesasTitle")}
            subtitle={t("cardMesasSubtitle")}
            badge={t("badgeConfigure")}
            tint="bg-paper text-op-muted"
          />
        )}
        {tenant.reservationsEnabled && (
          <SettingCard
            href="/operator/settings/salon"
            title={t("cardSalonTitle")}
            subtitle={t("cardSalonSubtitle")}
            badge={t("badgeDesign")}
            tint="bg-paper text-op-muted"
          />
        )}
        <SettingCard
          href="/operator/settings/suscripcion"
          title={t("subscriptionCardTitle")}
          subtitle={t("subscriptionCardDesc")}
          badge={t("badgeConfigure")}
          tint="bg-paper text-op-muted"
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
      <span className="text-op-muted" aria-hidden="true">
        {"→"}
      </span>
    </Link>
  );
}

// Maps the Kushki onboarding status to an i18n key + tint. The label is
// resolved by the caller via t(statusKey) so this stays language-free.
function humanStatus(s: string): { statusKey: string; tint: string } {
  switch (s) {
    case "active":
      return { statusKey: "kushkiStatusActive", tint: "bg-ok/15 text-ok" };
    case "in_review":
    case "submitted":
      return {
        statusKey: "kushkiStatusInReview",
        tint: "bg-[#C98A2E]/20 text-[#8F6828]",
      };
    case "rejected":
      return {
        statusKey: "kushkiStatusRejected",
        tint: "bg-danger/15 text-danger",
      };
    case "suspended":
      return {
        statusKey: "kushkiStatusSuspended",
        tint: "bg-danger/15 text-danger",
      };
    case "docs_uploaded":
      return {
        statusKey: "kushkiStatusDocsUploaded",
        tint: "bg-paper text-op-muted",
      };
    default:
      return {
        statusKey: "kushkiStatusNotStarted",
        tint: "bg-paper text-op-muted",
      };
  }
}
