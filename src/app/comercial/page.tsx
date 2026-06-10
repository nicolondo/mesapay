import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { fmtCOP } from "@/lib/format";
import { fmtBogotaDateTime } from "@/lib/bogota";
import {
  resolveCommissionBps,
  summarizeCommissions,
} from "@/lib/commissions";

export const dynamic = "force-dynamic";

export default async function ComercialPage() {
  const session = await auth();
  if (!session?.user) redirect("/signin?callbackUrl=/comercial");

  const { role, id: uid } = session.user;
  if (role !== "comercial" && role !== "platform_admin") {
    redirect("/");
  }

  const t = await getTranslations("comercialPortal");

  // For platform_admin viewing the portal directly, we'd show an
  // empty state (no salesRepUserId scope). They use /admin/comisiones
  // for the global view. Only fetch data when role === "comercial".
  const isComercial = role === "comercial";

  // Fetch platform default bps
  const platformConfig = await db.platformConfig.findUnique({
    where: { id: "singleton" },
    select: { salesCommissionBps: true },
  });
  const platformBps = platformConfig?.salesCommissionBps ?? 1000;

  // Fetch the user's own commissionBps
  const selfUser = isComercial
    ? await db.user.findUnique({
        where: { id: uid },
        select: { commissionBps: true },
      })
    : null;

  const [restaurants, entries] = isComercial
    ? await Promise.all([
        db.restaurant.findMany({
          where: { salesRepUserId: uid },
          select: {
            id: true,
            name: true,
            plan: true,
            monthlyPriceCents: true,
            suspended: true,
            periodEndsAt: true,
            salesRepCommissionBps: true,
          },
          orderBy: { name: "asc" },
        }),
        db.commissionEntry.findMany({
          where: { salesRepUserId: uid },
          include: {
            restaurant: { select: { name: true } },
            membershipPayment: {
              select: { periodStart: true, periodEnd: true },
            },
          },
          orderBy: { createdAt: "desc" },
          take: 200,
        }),
      ])
    : [[], []];

  const summary = summarizeCommissions(
    entries.map((e) => ({
      amountCents: e.amountCents,
      status: e.status as "pending" | "paid" | "reversed",
      createdAt: e.createdAt,
    })),
  );

  const activeCount = restaurants.filter((r) => !r.suspended).length;

  return (
    <div className="flex-1 p-4 md:p-6 max-w-5xl mx-auto w-full">
      <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted mb-1">
        {"MESAPAY"}
      </div>
      <div className="font-display text-3xl tracking-[-0.015em] mb-1">
        {t("title")}
      </div>
      <p className="text-sm text-op-muted mb-6">{t("subtitle")}</p>

      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-8">
        <SummaryCard label={t("cardActive")} value={String(activeCount)} />
        <SummaryCard
          label={t("cardPending")}
          value={fmtCOP(summary.pendingCents)}
          highlight
        />
        <SummaryCard
          label={t("cardPaid")}
          value={fmtCOP(summary.paidCents)}
        />
      </div>

      {/* Restaurants table */}
      <div className="rounded-2xl border border-op-border bg-op-surface mb-6">
        <div className="p-5 border-b border-op-border">
          <div className="font-display text-lg">{t("sectionRestaurants")}</div>
        </div>
        {restaurants.length === 0 ? (
          <div className="p-5 text-sm text-op-muted">{t("emptyRestaurants")}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-op-border">
                  <Th>{t("colName")}</Th>
                  <Th>{t("colPlan")}</Th>
                  <Th>{t("colMonthly")}</Th>
                  <Th>{t("colBps")}</Th>
                  <Th>{t("colStatus")}</Th>
                  <Th>{t("colExpires")}</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-op-border">
                {restaurants.map((r) => {
                  const effectiveBps = resolveCommissionBps({
                    restaurantBps: r.salesRepCommissionBps,
                    repBps: selfUser?.commissionBps,
                    platformBps,
                  });
                  return (
                    <tr key={r.id}>
                      <Td className="font-medium">{r.name}</Td>
                      <Td className="font-mono text-[11px] text-op-muted">
                        {r.plan}
                      </Td>
                      <Td className="font-mono tabular">
                        {r.monthlyPriceCents > 0
                          ? fmtCOP(r.monthlyPriceCents)
                          : "—"}
                      </Td>
                      <Td className="font-mono tabular">
                        {(effectiveBps / 100).toFixed(2)}
                        {"%"}
                      </Td>
                      <Td>
                        {r.suspended ? (
                          <StatusBadge variant="suspended">
                            {t("stateSuspended")}
                          </StatusBadge>
                        ) : (
                          <StatusBadge variant="active">
                            {t("stateActive")}
                          </StatusBadge>
                        )}
                      </Td>
                      <Td className="font-mono text-[11px] text-op-muted">
                        {r.periodEndsAt
                          ? fmtBogotaDateTime(r.periodEndsAt).date
                          : "—"}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Commission entries table */}
      <div className="rounded-2xl border border-op-border bg-op-surface">
        <div className="p-5 border-b border-op-border">
          <div className="font-display text-lg">{t("sectionEntries")}</div>
        </div>
        {entries.length === 0 ? (
          <div className="p-5 text-sm text-op-muted">{t("emptyEntries")}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-op-border">
                  <Th>{t("colDate")}</Th>
                  <Th>{t("colName")}</Th>
                  <Th>{t("colPeriod")}</Th>
                  <Th>{t("colBase")}</Th>
                  <Th>{t("colPct")}</Th>
                  <Th>{t("colAmount")}</Th>
                  <Th>{t("colCommStatus")}</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-op-border">
                {entries.map((e) => (
                  <tr key={e.id}>
                    <Td className="font-mono text-[11px] text-op-muted whitespace-nowrap">
                      {fmtBogotaDateTime(e.createdAt).date}
                    </Td>
                    <Td>{e.restaurant.name}</Td>
                    <Td className="font-mono text-[11px] text-op-muted whitespace-nowrap">
                      {e.membershipPayment
                        ? `${fmtBogotaDateTime(e.membershipPayment.periodStart).date} → ${fmtBogotaDateTime(e.membershipPayment.periodEnd).date}`
                        : "—"}
                    </Td>
                    <Td className="font-mono tabular">
                      {fmtCOP(e.baseAmountCents)}
                    </Td>
                    <Td className="font-mono tabular">
                      {(e.bps / 100).toFixed(2)}
                      {"%"}
                    </Td>
                    <Td className="font-mono tabular font-medium">
                      {fmtCOP(e.amountCents)}
                    </Td>
                    <Td>
                      <CommissionBadge
                        status={e.status as "pending" | "paid" | "reversed"}
                        pendingLabel={t("statusPending")}
                        paidLabel={t("statusPaid")}
                        reversedLabel={t("statusReversed")}
                      />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function SummaryCard({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div className="rounded-2xl border border-op-border bg-op-surface p-5">
      <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted">
        {label}
      </div>
      <div
        className={
          "font-display text-2xl tabular mt-1 " +
          (highlight ? "text-terracotta" : "")
        }
      >
        {value}
      </div>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-4 py-3 text-left font-mono text-[10px] tracking-wider uppercase text-op-muted font-normal">
      {children}
    </th>
  );
}

function Td({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <td className={"px-4 py-3 " + (className ?? "")}>{children}</td>
  );
}

function StatusBadge({
  variant,
  children,
}: {
  variant: "active" | "suspended";
  children: React.ReactNode;
}) {
  const cls =
    variant === "active"
      ? "bg-ok/10 text-[#1E5339] border-ok/30"
      : "bg-ink/80 text-bone border-ink";
  return (
    <span
      className={
        "font-mono text-[10px] tracking-wider uppercase px-2 py-0.5 rounded border " +
        cls
      }
    >
      {children}
    </span>
  );
}

function CommissionBadge({
  status,
  pendingLabel,
  paidLabel,
  reversedLabel,
}: {
  status: "pending" | "paid" | "reversed";
  pendingLabel: string;
  paidLabel: string;
  reversedLabel: string;
}) {
  const map = {
    pending: "bg-[#C98A2E]/15 text-[#7F5A1F] border-[#C98A2E]/50",
    paid: "bg-ok/10 text-[#1E5339] border-ok/30",
    reversed: "bg-op-bg text-op-muted border-op-border",
  };
  const labelMap = { pending: pendingLabel, paid: paidLabel, reversed: reversedLabel };
  return (
    <span
      className={
        "font-mono text-[10px] tracking-wider uppercase px-2 py-0.5 rounded border " +
        map[status]
      }
    >
      {labelMap[status]}
    </span>
  );
}
