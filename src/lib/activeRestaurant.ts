import { cookies } from "next/headers";
import { auth } from "@/auth";
import type { Session } from "next-auth";

export const IMPERSONATE_COOKIE = "mesapay_act_as";

export type ActiveContext = {
  session: Session;
  restaurantId: string | null;
  impersonating: boolean;
};

/**
 * Resolve which restaurant the current user is acting on.
 *
 * - operator → their own restaurantId (ignores impersonation cookie)
 * - platform_admin → cookie value if set, otherwise null
 */
export async function getActiveContext(): Promise<ActiveContext | null> {
  const session = await auth();
  if (!session?.user) return null;
  if (session.user.role === "platform_admin") {
    const jar = await cookies();
    const impersonated = jar.get(IMPERSONATE_COOKIE)?.value ?? null;
    return {
      session,
      restaurantId: impersonated,
      impersonating: Boolean(impersonated),
    };
  }
  return {
    session,
    restaurantId: session.user.restaurantId ?? null,
    impersonating: false,
  };
}

export async function getActiveRestaurantId(): Promise<string | null> {
  const ctx = await getActiveContext();
  return ctx?.restaurantId ?? null;
}
