export type CrmRole =
  | "comercial"
  | "gerente_comercial"
  | "platform_admin"
  | string;

export interface ScopeUser {
  id: string;
  role: CrmRole;
}

/**
 * Returns the list of user IDs whose CRM leads are visible to `user`.
 *
 * - `comercial`         → only their own leads ([id])
 * - `gerente_comercial` → their own leads + all team member IDs ([id, ...teamIds])
 * - `platform_admin`    → no filter (null = all)
 * - any other role      → empty array (no access)
 */
export function crmVisibleUserIds(
  user: ScopeUser,
  teamIds: string[],
): string[] | null {
  switch (user.role) {
    case "comercial":
      return [user.id];
    case "gerente_comercial":
      return [user.id, ...teamIds];
    case "platform_admin":
      return null;
    default:
      return [];
  }
}
