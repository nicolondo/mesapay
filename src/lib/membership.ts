export type MembershipStatus =
  | "trial"
  | "al_dia"
  | "por_vencer"
  | "vencido"
  | "suspendido";

export const STATUS_LABEL: Record<MembershipStatus, string> = {
  trial: "Prueba",
  al_dia: "Al día",
  por_vencer: "Por vencer",
  vencido: "Vencido",
  suspendido: "Suspendido",
};

export function deriveMembershipStatus(input: {
  plan: "trial" | "basic" | "pro";
  periodEndsAt: Date | null;
  suspended: boolean;
  now?: Date;
}): MembershipStatus {
  if (input.suspended) return "suspendido";
  if (input.plan === "trial") return "trial";
  const now = input.now ?? new Date();
  if (!input.periodEndsAt) return "vencido";
  const daysLeft = Math.floor(
    (input.periodEndsAt.getTime() - now.getTime()) / 86400000,
  );
  if (daysLeft < 0) return "vencido";
  if (daysLeft <= 5) return "por_vencer";
  return "al_dia";
}

/**
 * Extend the membership period by one month from today (or from the
 * existing period-end if it's still in the future — this way consecutive
 * on-time payments stack cleanly).
 */
export function extendOneMonth(current: Date | null, now = new Date()): {
  periodStart: Date;
  periodEnd: Date;
} {
  const base = current && current > now ? current : now;
  const periodStart = base;
  const periodEnd = new Date(base);
  periodEnd.setMonth(periodEnd.getMonth() + 1);
  return { periodStart, periodEnd };
}
