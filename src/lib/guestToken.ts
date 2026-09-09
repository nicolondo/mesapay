import { createHmac, timingSafeEqual } from "node:crypto";

export type GuestScope = { restaurantId: string; tableId?: string; orderId?: string; expires: number };
const key = () => {
  const secret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET_required");
  return secret;
};
export function signGuestScope(scope: GuestScope): string {
  const data = Buffer.from(JSON.stringify(scope)).toString("base64url");
  return data + "." + createHmac("sha256", key()).update(data).digest("base64url");
}
export function verifyGuestScope(token: string, now = Date.now()): GuestScope | null {
  try {
    const [data, sig, extra] = token.split(".");
    if (!data || !sig || extra) return null;
    const expected = createHmac("sha256", key()).update(data).digest();
    const received = Buffer.from(sig, "base64url");
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) return null;
    const scope = JSON.parse(Buffer.from(data, "base64url").toString()) as GuestScope;
    if (typeof scope.restaurantId !== "string" || !Number.isFinite(scope.expires) || scope.expires <= now || !(typeof scope.tableId === "string" || typeof scope.orderId === "string")) return null;
    return scope;
  } catch { return null; }
}
