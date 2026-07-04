import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { auth } from "@/auth";
import { fmtBogotaDateTime } from "@/lib/bogota";
import { fmtCOP } from "@/lib/format";
import { IMPERSONATE_COOKIE } from "@/lib/activeRestaurant";
import {
  deriveMembershipStatus,
  type MembershipStatus,
} from "@/lib/membership";
import { getPlanCatalog } from "@/lib/planCatalog";
import {
  PickupSchedulePanel,
  PickupToggle,
  PlanEditor,
  RecordPaymentForm,
  ServiceModePicker,
  SuspendButton,
} from "./BillingPanel";
import { UsersPanel } from "./UsersPanel";
import { RestaurantNameEditor } from "./RestaurantNameEditor";
import { RestaurantCountryEditor } from "./RestaurantCountryEditor";
import { getEnabledCountries, getCurrencyForCountry } from "@/lib/billing/countries";
import { PaymentMethodsPanel } from "./PaymentMethodsPanel";
import { ModulesPanel } from "./ModulesPanel";
import { resolveEnabledModules } from "@/lib/modules";
import { GroupAssignPanel } from "./GroupAssignPanel";
import { resolveEnabledPaymentMethods } from "@/lib/paymentMethods";
import { AdminAiConfig } from "./AdminAiConfig";
import { AdminSalesRep } from "./AdminSalesRep";
import { DangerZonePanel } from "./DangerZonePanel";
import { CashBox } from "@/components/CashBox";
import { buildCashSnapshot } from "@/lib/cashBox";
import { resolveShiftPolicy } from "@/lib/staffPolicies";

export const dynamic = "force-dynamic";


export default async function RestaurantDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const t = await getTranslations("opAdmin");
  const METHOD_LABEL: Record<string, string> = {
    manual_cash: t("methodCash"),
    manual_transfer: t("methodTransfer"),
    wompi: t("methodWompi"),
  };
  const [rest, operators, counts, lastOrder, firstOrder, payments, planCatalog, allGroups, currentLegalEntity, comerciales, platformConfig] =
    await Promise.all([
      db.restaurant.findUnique({ where: { id } }),
      db.user.findMany({
        where: {
          restaurantId: id,
          role: { in: ["operator", "terminal", "mesero", "kitchen", "bar", "comercial"] },
        },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          createdAt: true,
        },
        orderBy: { createdAt: "asc" },
      }),
      db.restaurant.findUnique({
        where: { id },
        select: {
          _count: {
            select: { tables: true, menuItems: true, orders: true, categories: true },
          },
        },
      }),
      db.order.findFirst({
        where: { restaurantId: id },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true, status: true, totalCents: true },
      }),
      db.order.findFirst({
        where: { restaurantId: id },
        orderBy: { createdAt: "asc" },
        select: { createdAt: true },
      }),
      db.membershipPayment.findMany({
        where: { restaurantId: id },
        orderBy: { createdAt: "desc" },
        take: 12,
      }),
      getPlanCatalog(),
      // Todos los grupos para el dropdown del GroupAssignPanel.
      // Es una lista chica (decenas como mucho) y la cacheamos
      // implícitamente porque el page es force-dynamic.
      db.group.findMany({
        orderBy: { name: "asc" },
        select: { id: true, name: true, slug: true },
      }),
      // Resolvemos el legalEntity actual (si tiene) por separado
      // porque depende del rest cargado. Necesario para avisar al
      // admin que un cambio de grupo desvinculará la razón social.
      (async () => {
        const r = await db.restaurant.findUnique({
          where: { id },
          select: { legalEntityId: true },
        });
        if (!r?.legalEntityId) return null;
        return db.legalEntity.findUnique({
          where: { id: r.legalEntityId },
          select: { name: true },
        });
      })(),
      // List of users with role=comercial for the sales rep selector.
      db.user.findMany({
        where: { role: "comercial" },
        select: { id: true, name: true, email: true, commissionBps: true },
        orderBy: { name: "asc" },
      }),
      // Platform default commission bps.
      db.platformConfig.findUnique({
        where: { id: "singleton" },
        select: { salesCommissionBps: true },
      }),
    ]);

  if (!rest) notFound();

  // País + moneda derivada para el editor de país del header.
  const [enabledCountries, restCurrency] = await Promise.all([
    getEnabledCountries(),
    getCurrencyForCountry(rest.country),
  ]);

  // Snapshot inicial de caja (el CashBox refresca en vivo por SSE).
  const cashSnap = await buildCashSnapshot(
    rest.id,
    resolveShiftPolicy(rest.shiftPolicy),
  );

  // Label del plan actual sale del catálogo editable (fallback al
  // tier crudo si por alguna razón no está en el catálogo).
  const currentPlanLabel =
    planCatalog.find((p) => p.tier === rest.plan)?.name ?? rest.plan;

  const paidCount = await db.order.count({
    where: { restaurantId: id, status: "paid" },
  });

  const status = deriveMembershipStatus({
    plan: rest.plan,
    periodEndsAt: rest.periodEndsAt,
    suspended: rest.suspended,
  });

  async function impersonate() {
    "use server";
    const session = await auth();
    if (!session?.user || session.user.role !== "platform_admin") {
      redirect("/admin");
    }
    const jar = await cookies();
    jar.set(IMPERSONATE_COOKIE, id, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 4,
    });
    redirect("/operator");
  }

  return (
    <div className="flex-1 p-4 md:p-6 max-w-5xl mx-auto w-full">
      <Link
        href="/admin/restaurants"
        className="font-mono text-[10px] tracking-wider uppercase text-op-muted hover:text-op-text"
      >
        {t("detailBack")}
      </Link>

      <div className="flex items-start justify-between mt-4 mb-6 gap-3">
        <div className="min-w-0 flex-1">
          <RestaurantNameEditor
            restaurantId={rest.id}
            initialName={rest.name}
          />
          <div className="font-mono text-xs text-op-muted mt-1">/{rest.slug}</div>
          <div className="font-mono text-[11px] text-op-muted mt-1">
            {t("detailCreatedAt", { date: fmtBogotaDateTime(rest.createdAt).date })}
          </div>
          <RestaurantCountryEditor
            restaurantId={rest.id}
            initialCountry={rest.country}
            initialCountryName={rest.countryName}
            currency={restCurrency}
            options={enabledCountries}
          />
        </div>
        <form action={impersonate}>
          <button
            type="submit"
            className="h-10 px-4 rounded-xl bg-ink text-bone text-sm font-medium"
          >
            {t("enterAsOperator")}
          </button>
        </form>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
        <Stat label={t("colOperators")} value={operators.length} />
        <Stat label={t("statCategories")} value={counts?._count.categories ?? 0} />
        <Stat label={t("statDishes")} value={counts?._count.menuItems ?? 0} />
        <Stat label={t("colTables")} value={counts?._count.tables ?? 0} />
        <Stat label={t("colOrders")} value={counts?._count.orders ?? 0} />
      </div>

      <div className="rounded-2xl border border-op-border bg-op-surface mb-4 overflow-hidden">
        {/* Section 1 — plan + estado del periodo */}
        <div className="p-5">
          <div className="flex items-start justify-between mb-5">
            <div>
              <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted">
                {t("planAndBilling")}
              </div>
              <div className="font-display text-2xl mt-1">
                {currentPlanLabel}{" "}
                <span className="text-op-muted text-base font-sans">
                  <span aria-hidden>{"·"}</span>{" "}
                  {rest.monthlyPriceCents > 0
                    ? t("perMonth", { price: fmtCOP(rest.monthlyPriceCents) })
                    : t("noCost")}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <StatusPill status={status} t={t} />
              <SuspendButton restaurantId={id} suspended={rest.suspended} />
            </div>
          </div>

          <PlanEditor
            restaurantId={id}
            plan={rest.plan}
            monthlyPriceCents={rest.monthlyPriceCents}
            // Pasamos el catálogo editable para que el selector
            // refleje nombres + precios sugeridos actualizados sin
            // tener que duplicar la lista en cliente.
            planOptions={planCatalog
              // Mostramos el plan actual aunque esté marcado
              // invisible, para no romper la edición de comercios
              // legacy que quedaron en un plan deprecated.
              .filter((p) => p.visible || p.tier === rest.plan)
              .map((p) => ({
                value: p.tier,
                label: p.name,
                suggestedPriceCents: p.defaultPriceCents,
              }))}
          />

          <div className="mt-5 grid grid-cols-2 gap-3">
            <MiniStat
              label={t("expires")}
              value={
                rest.periodEndsAt
                  ? fmtBogotaDateTime(rest.periodEndsAt).date
                  : "—"
              }
            />
            <MiniStat
              label={t("daysLeft")}
              value={
                rest.periodEndsAt ? <DaysLeft date={rest.periodEndsAt} t={t} /> : "—"
              }
            />
          </div>
        </div>

        {/* Section 2 — registrar pago manual */}
        <div className="p-5 border-t border-op-border bg-op-bg/30">
          <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-3">
            {t("recordManualPayment")}
          </div>
          <RecordPaymentForm
            restaurantId={id}
            suggestedAmountCents={rest.monthlyPriceCents}
          />
        </div>

        {/* Section 3 — historial */}
        <div className="p-5 border-t border-op-border">
          <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-3">
            {t("history", { count: payments.length })}
          </div>
          {payments.length === 0 ? (
            <div className="text-sm text-op-muted">{t("noPaymentsRecorded")}</div>
          ) : (
            <ul className="divide-y divide-op-border">
              {payments.map((p) => (
                <li
                  key={p.id}
                  className="py-3 flex items-start justify-between text-sm gap-4"
                >
                  <div className="min-w-0">
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <span className="font-mono tabular font-medium">
                        {fmtCOP(p.amountCents)}
                      </span>
                      <span className="text-[11px] text-op-muted">
                        {METHOD_LABEL[p.method] ?? p.method}
                      </span>
                    </div>
                    <div className="font-mono text-[11px] text-op-muted mt-0.5">
                      {fmtBogotaDateTime(p.periodStart).date} →{" "}
                      {fmtBogotaDateTime(p.periodEnd).date}
                    </div>
                    <div className="text-[11px] text-op-muted mt-0.5">
                      {t("recordedBy", { email: p.recordedByEmail })}
                      {p.note ? ` · ${p.note}` : ""}
                    </div>
                  </div>
                  <div className="font-mono text-[10px] text-op-muted shrink-0">
                    {fmtBogotaDateTime(p.createdAt).date}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <PaymentMethodsPanel
        restaurantId={id}
        initialEnabled={resolveEnabledPaymentMethods(rest.enabledPaymentMethods)}
      />

      <ModulesPanel
        restaurantId={id}
        initialEnabled={resolveEnabledModules(rest.enabledModules)}
      />

      <GroupAssignPanel
        restaurantId={id}
        initialGroupId={rest.groupId}
        groups={allGroups}
        currentLegalEntityName={currentLegalEntity?.name ?? null}
      />

      <div className="mb-4">
        <AdminAiConfig
          restaurantId={id}
          initial={{
            aiInsightsEnabled: rest.aiInsightsEnabled,
            aiDailyMessageLimit: rest.aiDailyMessageLimit,
          }}
        />
      </div>

      <AdminSalesRep
        restaurantId={id}
        comerciales={comerciales}
        initialSalesRepUserId={rest.salesRepUserId}
        initialSalesRepCommissionBps={rest.salesRepCommissionBps}
        platformDefaultBps={platformConfig?.salesCommissionBps ?? 1000}
        repDefaultBps={
          rest.salesRepUserId
            ? (comerciales.find((c) => c.id === rest.salesRepUserId)?.commissionBps ?? null)
            : null
        }
      />

      <div className="rounded-2xl border border-op-border bg-op-surface p-4 mb-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted">
              {t("paymentsCardTitle")}
            </div>
            <div className="text-sm mt-1">
              {rest.kushkiOnboardingStatus === "active"
                ? t("paymentsActive")
                : rest.kushkiOnboardingStatus === "not_started"
                  ? t("paymentsNotStarted")
                  : t("paymentsStatus", { status: rest.kushkiOnboardingStatus })}
            </div>
          </div>
          <Link
            href={`/admin/restaurants/${id}/pagos`}
            className="h-9 px-4 rounded-full bg-ink text-bone text-sm font-medium inline-flex items-center"
          >
            {t("viewDetails")}
          </Link>
        </div>
      </div>

      <div className="rounded-2xl border border-op-border bg-op-surface p-4 mb-4">
        <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted mb-3">
          {t("serviceModeTitle")}
        </div>
        <ServiceModePicker
          restaurantId={id}
          serviceMode={rest.serviceMode}
        />
        <div className="text-[11px] text-op-muted mt-2">
          {rest.serviceMode === "counter"
            ? t("serviceModeCounter")
            : t("serviceModeTable")}
        </div>
      </div>

      <div className="rounded-2xl border border-op-border bg-op-surface p-4 mb-4">
        <div className="flex items-start justify-between gap-4 mb-2">
          <div>
            <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted">
              {t("pickupTitle")}
            </div>
            <div className="text-sm mt-1">
              {t("pickupBody")}
            </div>
          </div>
          <PickupToggle
            restaurantId={id}
            pickupEnabled={rest.pickupEnabled}
          />
        </div>
        <div className="text-[11px] text-op-muted mt-2">
          {t("pickupHint")}
        </div>
        {rest.pickupEnabled && (
          <div className="mt-5 pt-4 border-t border-op-border">
            <PickupSchedulePanel
              restaurantId={id}
              pickupHours={
                rest.pickupHours as Record<string, unknown> | null
              }
              pickupMaxEtaMinutes={rest.pickupMaxEtaMinutes}
            />
          </div>
        )}
      </div>

      <div className="rounded-2xl border border-op-border bg-op-surface p-4 mb-4">
        <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted mb-3">
          {t("activityTitle")}
        </div>
        <Row label={t("rowFirstOrder")}>
          {firstOrder
            ? fmtBogotaDateTime(firstOrder.createdAt).date
            : "—"}
        </Row>
        <Row label={t("rowLastOrder")}>
          {lastOrder ? (
            <>
              {fmtBogotaDateTime(lastOrder.createdAt).date}{" "}
              <span className="text-op-muted">
                ({lastOrder.status})
              </span>
            </>
          ) : (
            "—"
          )}
        </Row>
        <Row label={t("rowPaid")}>{paidCount}</Row>
      </div>

      <UsersPanel
        restaurantId={id}
        initialUsers={operators.map((u) => ({
          id: u.id,
          email: u.email,
          name: u.name,
          role: u.role as "operator" | "terminal" | "mesero" | "kitchen" | "bar" | "comercial",
          createdAt: u.createdAt.toISOString(),
        }))}
      />

      <div className="mb-4">
        <CashBox
          initial={cashSnap}
          snapshotUrl={`/api/admin/restaurants/${id}/cash/snapshot`}
          movementUrl={`/api/admin/restaurants/${id}/cash/movement`}
          tenantSlug={rest.slug}
        />
      </div>

      <DangerZonePanel restaurantId={id} slug={rest.slug} />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-op-border bg-op-surface p-3">
      <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted">
        {label}
      </div>
      <div className="font-display text-2xl mt-1">{value}</div>
    </div>
  );
}

function MiniStat({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-op-border bg-op-bg/40 px-3 py-2">
      <div className="font-mono text-[9px] tracking-[0.14em] uppercase text-op-muted">
        {label}
      </div>
      <div className="text-sm mt-0.5">{value}</div>
    </div>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex justify-between py-1.5 text-sm border-t border-op-border first:border-t-0">
      <div className="text-op-muted">{label}</div>
      <div>{children}</div>
    </div>
  );
}

function DaysLeft({
  date,
  t,
}: {
  date: Date;
  t: Awaited<ReturnType<typeof getTranslations<"opAdmin">>>;
}) {
  const days = Math.floor((date.getTime() - Date.now()) / 86400000);
  if (days < 0)
    return (
      <span className="text-danger font-mono tabular">
        {t("daysLeftExpiredAgo", { days: Math.abs(days) })}
      </span>
    );
  if (days === 0)
    return (
      <span className="text-[#7F5A1F] font-mono tabular">
        {t("daysLeftToday")}
      </span>
    );
  return (
    <span className="font-mono tabular">{t("daysLeftValue", { days })}</span>
  );
}

function StatusPill({
  status,
  t,
}: {
  status: MembershipStatus;
  t: Awaited<ReturnType<typeof getTranslations<"opAdmin">>>;
}) {
  const map: Record<MembershipStatus, string> = {
    al_dia: "bg-ok/10 text-[#1E5339] border-ok/30",
    trial: "bg-op-bg text-op-muted border-op-border",
    por_vencer: "bg-[#C98A2E]/15 text-[#7F5A1F] border-[#C98A2E]/50",
    vencido: "bg-danger/10 text-danger border-danger/25",
    suspendido: "bg-ink/80 text-bone border-ink",
  };
  return (
    <span
      className={
        "font-mono text-[10px] tracking-wider uppercase px-2 py-1 rounded border " +
        map[status]
      }
    >
      {t("ms_" + status)}
    </span>
  );
}
