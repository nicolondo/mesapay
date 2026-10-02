/** Shared by the server guard and UI. Missing waiter policy fails closed. */
export const TABLE_MOVE_ADMIN_ONLY_ERROR = "table_move_admin_only" as const;

export function canMoveBetweenTables(
  role: string | null | undefined,
  adminOnlyTableMove: boolean | null | undefined,
): boolean {
  if (role === "operator" || role === "platform_admin" || role === "group_admin") {
    return true;
  }
  return role === "mesero" && adminOnlyTableMove === false;
}
