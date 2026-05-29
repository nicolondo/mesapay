import Link from "next/link";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { resolveMenuTags } from "@/lib/menuTags";
import {
  resolveTipPolicy,
  resolveShiftPolicy,
  TIP_POLICY_LABELS,
  SHIFT_POLICY_LABELS,
} from "@/lib/staffPolicies";

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
      menuTags: true,
      tipPolicy: true,
      shiftPolicy: true,
      logoUrl: true,
      legalName: true,
      taxId: true,
      dianResolution: true,
      reservationsEnabled: true,
    },
  });
  if (!tenant) return <div className="p-6">Restaurante no encontrado.</div>;

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

  return (
    <div className="p-6 max-w-3xl mx-auto w-full">
      <div className="font-display text-3xl mb-1">Configuración</div>
      <p className="text-sm text-op-muted mb-6">
        Activa pagos, configura datáfonos y revisa la información de tu
        restaurante.
      </p>

      <div className="space-y-3">
        <SettingCard
          href="/operator/settings/identidad"
          title="Identidad del comercio"
          subtitle="Logo, razón social, NIT, resolución DIAN"
          badge={
            tenant.logoUrl && tenant.legalName && tenant.taxId
              ? "Completo"
              : tenant.logoUrl || tenant.legalName
                ? "Parcial"
                : "Sin configurar"
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
          title="Usuarios"
          subtitle="Meseros, cocina, bar, datáfono y operadores"
          badge={`${staffCount} ${staffCount === 1 ? "usuario" : "usuarios"}`}
          tint={
            staffCount > 0
              ? "bg-ok/15 text-ok"
              : "bg-paper text-op-muted"
          }
        />
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
          href="/operator/settings/etiquetas"
          title="Etiquetas de platos"
          subtitle="De la casa, Favorito, Vegetariano… o las que tú definas"
          badge={`${tagCount} ${tagCount === 1 ? "etiqueta" : "etiquetas"}`}
          tint="bg-paper text-op-muted"
        />
        {deviceCount > 0 && (
          <SettingCard
            href="/operator/settings/datafonos"
            title="Datáfonos"
            subtitle="Asigna cada Smart POS al mesero que lo carga"
            badge={
              deviceAssigned === 0
                ? `${deviceCount} sin asignar`
                : `${deviceAssigned}/${deviceCount} asignados`
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
          title="Propinas y turnos"
          subtitle="Compartidas o por mesero. Turno único del local o por mesero."
          badge={`${TIP_POLICY_LABELS[tipPol]} · ${SHIFT_POLICY_LABELS[shiftPol]}`}
          tint="bg-paper text-op-muted"
        />
        {meseroCount > 0 && (
          <SettingCard
            href="/operator/settings/meseros"
            title="Mesas por mesero"
            subtitle="Asigna a cada mesero su sección del salón"
            badge={
              meserosWithRange === 0
                ? `${meseroCount} ${meseroCount === 1 ? "mesero ve todas" : "meseros ven todas"}`
                : `${meserosWithRange}/${meseroCount} ${meserosWithRange === 1 ? "asignado" : "asignados"}`
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
        <SettingCard
          href="/operator/settings/reservas"
          title="Reservas"
          subtitle="Recibí reservas de mesa desde un link. Turnos, duración y confirmación."
          badge={
            tenant.reservationsEnabled
              ? upcomingReservations > 0
                ? `Activo · ${upcomingReservations} próxima${upcomingReservations === 1 ? "" : "s"}`
                : "Activo"
              : "Desactivado"
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
            title="Mesas: capacidad y consumo"
            subtitle="Cuántos entran y consumo mínimo por mesa. Usado al reservar."
            badge="Configurar"
            tint="bg-paper text-op-muted"
          />
        )}
        {tenant.reservationsEnabled && (
          <SettingCard
            href="/operator/settings/salon"
            title="Mapa del salón"
            subtitle="Acomodá tus mesas como están en el local. El cliente lo ve al reservar."
            badge="Diseñar"
            tint="bg-paper text-op-muted"
          />
        )}
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
