import { SettingsDirectory, type SettingsItem } from "./SettingsDirectory";
import { getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { resolveMenuTags } from "@/lib/menuTags";
import { isModuleEnabled } from "@/lib/modules";
import { dianConfigStatus } from "@/lib/dian/config";
import { resolveEnabledPaymentMethods } from "@/lib/paymentMethods";
import { AGENT_ONLINE_MS } from "@/lib/print/agentStatus";
import { resolveTipPolicy, resolveShiftPolicy } from "@/lib/staffPolicies";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const t = await getTranslations("opSettings");
  const tErp = await getTranslations("opErp");
  const tDian = await getTranslations("opDian");
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

  // Proveedores (ERP track A): gate estricto — solo con compras activado
  // (mismo gate que la página y la API de suppliers).
  const showProveedores = isModuleEnabled(tenant.enabledModules, "purchasing");
  const supplierCount = showProveedores
    ? await db.supplier.count({ where: { restaurantId } })
    : 0;

  // La tarjeta ahora se muestra SIEMPRE porque es el único lugar donde se
  // carga la resolución de numeración (prefijo y consecutivo del
  // comprobante impreso, que existe con o sin facturación electrónica).
  // Con el módulo `einvoicing` apagado la pantalla muestra sólo esa
  // sección y la tarjeta se titula "Resolución de facturación".
  const einvoicing = isModuleEnabled(tenant.enabledModules, "einvoicing");
  const dian = await dianConfigStatus(restaurantId);
  const dianStatus = dian.status.status;
  const resolutionReady = dian.status.missingResolution.length === 0;

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

  // Impresoras de red: el badge tiene que gritar cuando el local TIENE
  // impresoras pero ningún agente responde — ahí las comandas se están
  // encolando contra un PC apagado y nadie se entera hasta que un cliente
  // reclama. Sin impresoras registradas la tarjeta sólo dice "Configurar".
  const printersNow = new Date();
  const [printerCount, liveAgents] = await Promise.all([
    db.printer.count({ where: { restaurantId, active: true } }),
    db.printAgent.count({
      where: {
        restaurantId,
        revokedAt: null,
        lastSeenAt: {
          gte: new Date(printersNow.getTime() - AGENT_ONLINE_MS),
        },
      },
    }),
  ]);
  const printersOffline = printerCount > 0 && liveAgents === 0;

  const settings: (SettingsItem | false)[] = [
    {
      href: "/operator/settings/identidad",
      title: t("cardIdentityTitle"),
      subtitle: t("cardIdentitySubtitle"),
      badge:
        tenant.logoUrl && tenant.legalName && tenant.taxId
          ? t("badgeComplete")
          : tenant.logoUrl || tenant.legalName
            ? t("badgePartial")
            : t("badgeUnconfigured"),
      tint:
        tenant.logoUrl && tenant.legalName && tenant.taxId
          ? "bg-ok/15 text-ok"
          : tenant.logoUrl || tenant.legalName
            ? "bg-[#C98A2E]/20 text-[#8F6828]"
            : "bg-paper text-op-muted",
    },
    {
      href: "/operator/settings/usuarios",
      title: t("cardUsersTitle"),
      subtitle: t("cardUsersSubtitle"),
      badge: t("badgeUsers", { count: staffCount }),
      tint: staffCount > 0 ? "bg-ok/15 text-ok" : "bg-paper text-op-muted",
    },
    {
      href: "/operator/settings/pagos",
      title: t("cardPaymentsTitle"),
      subtitle: t("cardPaymentsSubtitle"),
      badge: t(status.statusKey),
      tint: status.tint,
    },
    showWallet && {
      href: "/operator/wallet",
      title: t("cardWalletTitle"),
      subtitle: t("cardWalletSubtitle"),
      badge: t("badgeWalletAvailable"),
      tint: "bg-ok/15 text-ok",
    },
    {
      href: "/operator/settings/etiquetas",
      title: t("cardTagsTitle"),
      subtitle: t("cardTagsSubtitle"),
      badge: t("badgeTags", { count: tagCount }),
      tint: "bg-paper text-op-muted",
    },
    showProveedores && {
      href: "/operator/settings/proveedores",
      title: tErp("cardProveedoresTitle"),
      subtitle: tErp("cardProveedoresSubtitle"),
      badge: tErp("badgeProveedores", { count: supplierCount }),
      tint: supplierCount > 0 ? "bg-ok/15 text-ok" : "bg-paper text-op-muted",
    },
    {
      href: "/operator/settings/facturacion-dian",
      title: einvoicing ? tDian("cardTitle") : tDian("cardResolutionTitle"),
      subtitle: einvoicing
        ? tDian("cardSubtitle")
        : tDian("cardResolutionSubtitle"),
      badge: !einvoicing
        ? resolutionReady
          ? tDian("cardBadgeResolutionReady")
          : tDian("cardBadgeConfigure")
        : dianStatus === "enabled"
          ? tDian("cardBadgeEnabled")
          : dianStatus === "testing"
            ? tDian("cardBadgeTesting")
            : tDian("cardBadgeConfigure"),
      tint:
        (!einvoicing && resolutionReady) || dianStatus === "enabled"
          ? "bg-ok/15 text-ok"
          : einvoicing && dianStatus === "testing"
            ? "bg-[#C98A2E]/20 text-[#8F6828]"
            : "bg-paper text-op-muted",
    },
    {
      href: "/operator/settings/traducciones",
      title: t("cardTranslationsTitle"),
      subtitle: t("cardTranslationsSubtitle"),
      badge: t("badgeTranslate"),
      tint: "bg-paper text-op-muted",
    },
    showDatafonos && {
      href: "/operator/settings/datafonos",
      title: t("cardDevicesTitle"),
      subtitle: t("cardDevicesSubtitle"),
      badge:
        deviceCount === 0
          ? t("badgeDevicesEmpty")
          : deviceAssigned === 0
            ? t("badgeDevicesUnassigned", { count: deviceCount })
            : t("badgeDevicesAssigned", {
                assigned: deviceAssigned,
                total: deviceCount,
              }),
      tint: deviceAssigned > 0 ? "bg-ok/15 text-ok" : "bg-paper text-op-muted",
    },
    {
      href: "/operator/settings/staff-policies",
      title: t("cardPoliciesTitle"),
      subtitle: t("cardPoliciesSubtitle"),
      badge: `${t("tip_" + tipPol)} · ${t("shift_" + shiftPol)}`,
      tint: "bg-paper text-op-muted",
    },
    meseroCount > 0 && {
      href: "/operator/settings/meseros",
      title: t("cardMeserosTitle"),
      subtitle: t("cardMeserosSubtitle"),
      badge:
        meserosWithRange === 0
          ? t("badgeMeserosSeeAll", { count: meseroCount })
          : t("badgeMeserosAssigned", {
              assigned: meserosWithRange,
              total: meseroCount,
            }),
      tint:
        meserosWithRange > 0 ? "bg-ok/15 text-ok" : "bg-paper text-op-muted",
    },
    {
      href: "/operator/settings/estaciones",
      title: t("cardStationsTitle"),
      subtitle: t("cardStationsSubtitle"),
      badge: tenant.hasBar
        ? t("badgeBarActive", { routed: stationsRouted })
        : stationsCount > 0
          ? stationsRouted
          : t("badgeAllToKitchen"),
      tint:
        tenant.hasBar || stationsCount > 0
          ? "bg-ok/15 text-ok"
          : "bg-paper text-op-muted",
    },
    {
      href: "/operator/settings/impresoras",
      title: t("cardPrintersTitle"),
      subtitle: t("cardPrintersSubtitle"),
      badge:
        printerCount === 0
          ? t("badgePrintersEmpty")
          : printersOffline
            ? t("badgePrintersOffline")
            : t("badgePrintersOk", { count: printerCount }),
      tint:
        printerCount === 0
          ? "bg-paper text-op-muted"
          : printersOffline
            ? "bg-danger/10 text-danger"
            : "bg-ok/15 text-ok",
    },
    {
      href: "/operator/settings/reservas",
      title: t("cardReservasTitle"),
      subtitle: t("cardReservasSubtitle"),
      badge: tenant.reservationsEnabled
        ? upcomingReservations > 0
          ? t("badgeReservasActiveUpcoming", {
              count: upcomingReservations,
            })
          : t("badgeReservasActive")
        : t("badgeReservasDisabled"),
      tint: tenant.reservationsEnabled
        ? "bg-ok/15 text-ok"
        : "bg-paper text-op-muted",
    },
    tenant.reservationsEnabled && {
      href: "/operator/settings/mesas",
      title: t("cardMesasTitle"),
      subtitle: t("cardMesasSubtitle"),
      badge: t("badgeConfigure"),
      tint: "bg-paper text-op-muted",
    },
    tenant.reservationsEnabled && {
      href: "/operator/settings/salon",
      title: t("cardSalonTitle"),
      subtitle: t("cardSalonSubtitle"),
      badge: t("badgeDesign"),
      tint: "bg-paper text-op-muted",
    },
    {
      href: "/operator/settings/suscripcion",
      title: t("subscriptionCardTitle"),
      subtitle: t("subscriptionCardDesc"),
      badge: t("badgeConfigure"),
      tint: "bg-paper text-op-muted",
    },
  ];
  return (
    <div className="mp-page">
      <header className="mp-page-header">
        <div>
          <p className="mp-eyebrow">{tenant.name}</p>
          <h1 className="mp-page-title">{t("landingTitle")}</h1>
          <p className="mp-page-description">{t("landingSubtitle")}</p>
        </div>
      </header>
      <SettingsDirectory
        items={settings.filter((item): item is SettingsItem => item !== false)}
      />
    </div>
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
