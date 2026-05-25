// Mesero scope — resolves which tables a given session can see.
//
// In a restaurant with multiple meseros, each one handles a section
// (e.g. tables 1–10, or non-contiguous 1/3/5). They shouldn't see
// orders / cobros / mesas for tables that aren't theirs — the noise
// distracts them from their own customers.
//
// Storage: `User.assignedTableNumbers Int[]`. Empty array = no scope
// applied = sees everything. Only the `mesero` role honours the
// scope; operator/admin/kitchen/bar/terminal always see the whole
// restaurant.

import { auth } from "@/auth";
import { db } from "@/lib/db";

export type MeseroScope = {
  // Whether the current user is a scoped mesero. False for everyone else
  // and for meseros with an empty assignment list.
  scoped: boolean;
  // The set of table numbers the user is allowed to see. Null = no
  // restriction (the caller skips the filter entirely).
  tableNumbers: number[] | null;
};

/**
 * Read the current session and return the scope to apply to queries
 * that surface table-bound data. Safe to call from server components.
 */
export async function getMeseroScope(): Promise<MeseroScope> {
  const session = await auth();
  const role = session?.user?.role;
  const userId = session?.user?.id;
  if (!session?.user || !userId || role !== "mesero") {
    return { scoped: false, tableNumbers: null };
  }
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { assignedTableNumbers: true },
  });
  const nums = user?.assignedTableNumbers ?? [];
  if (nums.length === 0) {
    return { scoped: false, tableNumbers: null };
  }
  return { scoped: true, tableNumbers: nums };
}

/**
 * Convenience: build a Prisma-compatible `table` filter from a scope.
 * Returns undefined when there's no restriction so the caller can
 * spread it into a `where` without adding a clause.
 */
export function meseroTableWhere(
  scope: MeseroScope,
): { number: { in: number[] } } | undefined {
  if (!scope.scoped || !scope.tableNumbers) return undefined;
  return { number: { in: scope.tableNumbers } };
}
