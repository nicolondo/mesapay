import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { fmtCOP } from "@/lib/format";
import { fmtBogotaDateTime } from "@/lib/bogota";
import { listShiftsWithSummary } from "@/lib/shiftReport";

export const dynamic = "force-dynamic";

/**
 * /operator/shifts — historial de turnos cerrados con resumen por
 * fila. Click → /operator/shifts/[id] para el reporte detallado e
 * imprimible. Paginación simple via cursor en query string.
 */
export default async function ShiftsListPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>;
}) {
  const t = await getTranslations("opShifts");
  const { cursor } = await searchParams;
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) return <div className="p-6">{t("noRestaurant")}</div>;

  const { items, nextCursor } = await listShiftsWithSummary(restaurantId, {
    cursor: cursor || undefined,
    limit: 30,
  });

  return (
    <div className="flex-1 p-4 md:p-6 max-w-5xl mx-auto w-full">
      <div className="flex items-center justify-between mb-1">
        <Link
          href="/operator/reports"
          className="font-mono text-[10px] tracking-wider uppercase text-op-muted hover:text-op-text"
        >
          {t("back")}
        </Link>
      </div>
      <div className="font-display text-3xl tracking-[-0.015em] mt-2 mb-1">
        {t("title")}
      </div>
      <p className="text-sm text-op-muted mb-6">
        {t("subtitle")}
      </p>

      {items.length === 0 ? (
        <div className="rounded-2xl border border-op-border bg-op-surface p-8 text-center text-sm text-op-muted">
          {t("emptyClosed")}
        </div>
      ) : (
        <div className="rounded-2xl border border-op-border bg-op-surface overflow-hidden">
          <ul className="divide-y divide-op-border">
            {items.map((s) => {
              const closeLabel = s.closedAt
                ? fmtBogotaDateTime(s.closedAt)
                : null;
              const durMs = s.closedAt
                ? s.closedAt.getTime() - s.openedAt.getTime()
                : 0;
              return (
                <li key={s.id}>
                  <Link
                    href={`/operator/shifts/${s.id}`}
                    className="flex items-start gap-4 p-4 hover:bg-op-bg/50 transition-colors"
                  >
                    <div className="font-mono text-[11px] text-op-muted shrink-0 w-28 leading-snug">
                      {closeLabel ? (
                        <>
                          {closeLabel.date}
                          <br />
                          {closeLabel.time}
                        </>
                      ) : (
                        t("durationDash")
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-sm">
                        {s.userLabel ?? t("shiftOfRestaurant")}
                      </div>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1 text-[11px] text-op-muted">
                        <span>{formatDuration(durMs, t)}</span>
                        <span>·</span>
                        <span>{t("paymentsCount", { count: s.paymentCount })}</span>
                        {s.cashDiffCents != null && s.cashDiffCents !== 0 && (
                          <>
                            <span>·</span>
                            <span
                              className={
                                s.cashDiffCents > 0
                                  ? "text-[#7F5A1F]"
                                  : "text-danger"
                              }
                            >
                              {t("drawer", {
                                sign: s.cashDiffCents > 0 ? "+" : "",
                                amount: fmtCOP(s.cashDiffCents),
                              })}
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="font-display text-lg tabular">
                        {fmtCOP(s.grossCents)}
                      </div>
                      {s.tipCents > 0 && (
                        <div className="font-mono text-[11px] text-op-muted">
                          {t("tipSuffix", { amount: fmtCOP(s.tipCents) })}
                        </div>
                      )}
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {nextCursor && (
        <div className="mt-4 flex justify-center">
          <Link
            href={`/operator/shifts?cursor=${nextCursor}`}
            className="h-9 px-4 inline-flex items-center rounded-full border border-op-border text-sm hover:bg-op-bg"
          >
            {t("loadMore")}
          </Link>
        </div>
      )}
    </div>
  );
}

function formatDuration(
  ms: number,
  t: Awaited<ReturnType<typeof getTranslations<"opShifts">>>,
): string {
  if (ms <= 0) return t("durationDash");
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return t("durationM", { m });
  return t("durationHm", { h, m });
}
