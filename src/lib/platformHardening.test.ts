import { afterEach, describe, expect, it, vi } from "vitest";
import { signGuestScope, verifyGuestScope } from "./guestToken";
import { isPublicIp, checkUrlSafe } from "./ssrf";
import { amountCentsSchema, validPaymentAmounts, demoPaymentsAllowed } from "./payments/validation";
import { computeOrderTotals } from "./orderTotals";

afterEach(() => vi.unstubAllEnvs());
describe("platform security boundaries", () => {
  it("rejects modified and expired guest scopes", () => {
    vi.stubEnv("AUTH_SECRET", "isolated-test-secret-never-used-in-production");
    const scope = { restaurantId: "restaurant-a", tableId: "table-a", expires: 2000 };
    const token = signGuestScope(scope);
    expect(verifyGuestScope(token, 1000)).toEqual(scope);
    expect(verifyGuestScope(token, 2000)).toBeNull();
    const altered = Buffer.from(JSON.stringify({ ...scope, restaurantId: "restaurant-b" })).toString("base64url");
    expect(verifyGuestScope(altered + "." + token.split(".")[1], 1000)).toBeNull();
    expect(verifyGuestScope(token + ".extra", 1000)).toBeNull();
  });
  it.each(["127.0.0.1", "10.0.0.1", "100.64.0.1", "169.254.169.254", "::1", "[::1]", "::ffff:127.0.0.1", "::ffff:7f00:1", "fc00::1", "fe80::1", "64:ff9b::7f00:1"])("blocks internal IP %s", ip => {
    expect(isPublicIp(ip)).toBe(false);
  });
  it("accepts public IPv4 and IPv6", () => {
    expect(isPublicIp("8.8.8.8")).toBe(true);
    expect(isPublicIp("2606:4700:4700::1111")).toBe(true);
  });
  it.each(["file:///etc/passwd", "http://2130706433", "http://0x7f000001", "http://user:password@8.8.8.8"])("rejects unsafe URL %s before fetching", async url => {
    expect((await checkUrlSafe(url)).ok).toBe(false);
  });
  it("never enables demo payments in production", () => {
    vi.stubEnv("KUSHKI_MODE", "mock");
    vi.stubEnv("NODE_ENV", "production");
    expect(demoPaymentsAllowed()).toBe(false);
    vi.stubEnv("NODE_ENV", "test");
    expect(demoPaymentsAllowed()).toBe(true);
  });
  it("rejects fractional/negative amounts and tips above the charge", () => {
    for (const amount of [-100, 100.5, 2_000_000_001]) expect(amountCentsSchema.safeParse(amount).success).toBe(false);
    expect(validPaymentAmounts({ amountCents: 100, tipCents: 101 })).toBe(false);
  });
  it("requires tax as well as subtotal before closing the bill", () => {
    const before = computeOrderTotals(10000, [{ amountCents: 11000, tipCents: 1000 }], 1900);
    expect(before.fullyPaid).toBe(false);
    expect(before.outstandingCents).toBe(1900);
    expect(computeOrderTotals(10000, [{ amountCents: 12900, tipCents: 1000 }], 1900).fullyPaid).toBe(true);
  });
});
