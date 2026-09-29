import type { Prisma } from "@prisma/client";

type HistoryOrder = { createdAt: Date; paidAt: Date | null };

/** Sale time is final settlement; unpaid and old undated records retain opening time. */
export function historyDate(order: HistoryOrder): Date {
  return order.paidAt ?? order.createdAt;
}

/**
 * Two bounded, disjoint streams give the latest displayed dates, including
 * a bill opened yesterday and paid today. Sorting only after taking the
 * latest openings would silently omit those sales.
 */
export function historyQueries(
  where: Prisma.OrderWhereInput,
  since: Date | null,
): Array<Required<Pick<Prisma.OrderFindManyArgs, "where" | "orderBy" | "take">>> {
  return [
    {
      where: { ...where, paidAt: since ? { gte: since } : { not: null } },
      orderBy: [{ paidAt: "desc" }, { id: "desc" }],
      take: 100,
    },
    {
      where: { ...where, paidAt: null, ...(since ? { createdAt: { gte: since } } : {}) },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 100,
    },
  ] satisfies Prisma.OrderFindManyArgs[];
}

export function mergeHistory<T extends HistoryOrder & { id: string }>(orders: readonly T[], limit = 100): T[] {
  return [...orders].sort((a, b) =>
    historyDate(b).getTime() - historyDate(a).getTime() || b.id.localeCompare(a.id),
  ).slice(0, limit);
}
