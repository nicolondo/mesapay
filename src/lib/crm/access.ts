/**
 * CRM server-side access context helper.
 *
 * Call getCrmContext() at the top of every CRM route.
 * Returns null if the caller has no CRM role → respond 403.
 */
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { crmVisibleUserIds } from "./scope";

export const CRM_ROLES = new Set([
  "comercial",
  "gerente_comercial",
  "platform_admin",
]);

export interface CrmContext {
  userId: string;
  role: string;
  countryCode: string | null; // null for admin (no restriction)
  /** User IDs whose leads are visible. null = no filter (platform_admin). */
  visibleUserIds: string[] | null;
}

/**
 * Authenticates the request and returns CRM scope context.
 * Returns null if:
 *   - Not authenticated.
 *   - User has no CRM role (not comercial / gerente_comercial / platform_admin).
 */
export async function getCrmContext(): Promise<CrmContext | null> {
  const session = await auth();
  const user = session?.user;
  if (!user?.id || !user.role) return null;
  if (!CRM_ROLES.has(user.role)) return null;

  // Fetch countryCode (not in JWT) and team in parallel.
  const [dbUser, teamRows] =
    user.role === "gerente_comercial"
      ? await Promise.all([
          db.user.findUnique({
            where: { id: user.id },
            select: { countryCode: true },
          }),
          db.user.findMany({
            where: { managerId: user.id },
            select: { id: true },
          }),
        ])
      : await Promise.all([
          db.user.findUnique({
            where: { id: user.id },
            select: { countryCode: true },
          }),
          Promise.resolve([] as { id: string }[]),
        ]);

  const teamIds = teamRows.map((u) => u.id);

  const visibleUserIds = crmVisibleUserIds(
    { id: user.id, role: user.role },
    teamIds,
  );

  return {
    userId: user.id,
    role: user.role,
    countryCode: dbUser?.countryCode ?? null,
    visibleUserIds,
  };
}
