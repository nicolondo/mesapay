import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { canMoveBetweenTables } from "@/lib/tableMoveControl";

/** Read the persisted policy on every move; never trust an old UI/session. */
export async function isTableMoveBlocked(
  role: string | null | undefined,
  restaurantId: string,
  client: Pick<Prisma.TransactionClient, "restaurant"> = db,
): Promise<boolean> {
  const tenant = await client.restaurant.findUnique({
    where: { id: restaurantId },
    select: { adminOnlyTableMove: true },
  });
  return !tenant || !canMoveBetweenTables(role, tenant.adminOnlyTableMove);
}

/** Both ends must be in the waiter's current section and current tenant. */
export async function tableMoveScopeError(args: {
  role: string | null | undefined;
  userId: string;
  restaurantId: string;
  sourceNumber: number;
  targetNumber: number;
}, client: Pick<Prisma.TransactionClient, "user"> = db): Promise<"forbidden" | "source_out_of_scope" | "target_out_of_scope" | null> {
  if (args.role !== "mesero") return null;
  const user = await client.user.findUnique({
    where: { id: args.userId },
    select: { restaurantId: true, role: true, assignedTableNumbers: true },
  });
  if (!user || user.restaurantId !== args.restaurantId || user.role !== "mesero") {
    return "forbidden";
  }
  const numbers = user.assignedTableNumbers;
  if (numbers.length === 0) return null;
  if (!numbers.includes(args.sourceNumber)) return "source_out_of_scope";
  if (!numbers.includes(args.targetNumber)) return "target_out_of_scope";
  return null;
}
