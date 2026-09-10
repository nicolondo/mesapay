import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { db } from "../src/lib/db";
import { registerRestaurant } from "../src/lib/registerRestaurant";
import {
  hashResetToken,
  PENDING_PASSWORD_HASH,
  WELCOME_TOKEN_TTL_MS,
} from "../src/lib/passwordReset";
import { POST as reset } from "../src/app/api/auth/reset-password/route";
import { POST as resend } from "../src/app/api/auth/resend-restaurant-welcome/route";
const mail = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<boolean>>(),
);
vi.mock("@/lib/mailer", () => ({ sendRestaurantWelcomeEmail: mail }));
vi.mock("next-intl/server", () => ({ getLocale: async () => "es" }));
vi.mock("@/auth", () => ({ auth: async () => null }));
vi.mock("@/lib/activeRestaurant", () => ({
  getActiveContext: async () => null,
}));
vi.mock("@/lib/guestAccess", () => ({
  canAccessOrder: async () => false,
  canAccessTable: async () => false,
}));

const url = new URL(
  process.env.DATABASE_URL ?? "postgresql://localhost/invalid",
);
if (
  !["127.0.0.1", "localhost"].includes(url.hostname) ||
  !/^\/mesapay_.*(?:test|validation)$/.test(url.pathname)
)
  throw Error("Isolated local database required");
const restaurants: string[] = [];
beforeEach(() => {
  mail.mockClear();
  mail.mockResolvedValue(true);
});
afterAll(async () => {
  await db.restaurant.deleteMany({ where: { id: { in: restaurants } } });
  await db.$disconnect();
});
async function create() {
  const slug = `welcome-${randomUUID().slice(0, 16)}`;
  const result = await registerRestaurant({
    restaurantName: "Fixture welcome",
    restaurantSlug: slug,
    ownerName: "Fixture Owner",
    ownerEmail: `${slug}@example.test`,
    country: "CO",
    locale: "es",
  });
  if (!result.ok) throw Error(result.error);
  restaurants.push(result.restaurantId);
  const token = mail.mock.calls.at(-1)![2] as string;
  return { ...result, token, email: `${slug}@example.test` };
}
function request(path: string, body: unknown) {
  return new Request(`http://localhost/api/auth/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-real-ip": randomUUID() },
    body: JSON.stringify(body),
  });
}
const activate = (token: string, password = "FixtureSecurePassword1") =>
  reset(request("reset-password", { token, password }));

describe("restaurant welcome on PostgreSQL", () => {
  it("creates an unusable password and only a token digest, then accepts one activation", async () => {
    const r = await create();
    expect(r.emailSent).toBe(true);
    const before = await db.user.findUniqueOrThrow({ where: { id: r.userId } });
    expect(before.passwordHash).toBe(PENDING_PASSWORD_HASH);
    const token = await db.passwordResetToken.findUniqueOrThrow({
      where: { tokenHash: hashResetToken(r.token) },
    });
    expect(token.tokenHash).not.toBe(r.token);
    expect(token.expiresAt.getTime() - Date.now()).toBeGreaterThan(
      WELCOME_TOKEN_TTL_MS - 10000,
    );
    expect((await activate(r.token)).status).toBe(200);
    const user = await db.user.findUniqueOrThrow({ where: { id: r.userId } });
    expect(
      await bcrypt.compare("FixtureSecurePassword1", user.passwordHash),
    ).toBe(true);
    expect((await activate(r.token, "AnotherPassword123")).status).toBe(400);
  });
  it("preserves the created account when email delivery fails and allows resending", async () => {
    mail.mockResolvedValue(false);
    const r = await create();
    expect(r.emailSent).toBe(false);
    mail.mockResolvedValue(true);
    expect(
      (await resend(request("resend-restaurant-welcome", { email: r.email })))
        .status,
    ).toBe(200);
    expect(mail).toHaveBeenCalledTimes(2);
    expect(await db.restaurant.count({ where: { id: r.restaurantId } })).toBe(
      1,
    );
  });
  it("rejects expired and short passwords without changing the pending account", async () => {
    const r = await create();
    expect((await activate(r.token, "short")).status).toBe(400);
    await db.passwordResetToken.updateMany({
      where: { userId: r.userId },
      data: { expiresAt: new Date(0) },
    });
    expect((await activate(r.token)).status).toBe(400);
    expect(
      (await db.user.findUniqueOrThrow({ where: { id: r.userId } }))
        .passwordHash,
    ).toBe(PENDING_PASSWORD_HASH);
  });
  it("accepts only one of two simultaneous uses of the same link", async () => {
    const r = await create();
    const responses = await Promise.all([
      activate(r.token),
      activate(r.token, "OtherSecurePassword2"),
    ]);
    expect(responses.map((x) => x.status).sort()).toEqual([200, 400]);
  });
  it("invalidates all welcome links when one is used, even under concurrent requests", async () => {
    const r = await create();
    await resend(request("resend-restaurant-welcome", { email: r.email }));
    const second = mail.mock.calls.at(-1)![2] as string;
    const responses = await Promise.all([
      activate(r.token),
      activate(second, "OtherSecurePassword2"),
    ]);
    expect(responses.map((x) => x.status).sort()).toEqual([200, 400]);
    expect(
      await db.passwordResetToken.count({
        where: { userId: r.userId, usedAt: null },
      }),
    ).toBe(0);
    const count = mail.mock.calls.length;
    await resend(request("resend-restaurant-welcome", { email: r.email }));
    expect(mail.mock.calls.length).toBe(count);
  });
  it("does not mail unknown accounts and limits repeat welcome requests", async () => {
    expect(
      (
        await resend(
          request("resend-restaurant-welcome", {
            email: `${randomUUID()}@example.test`,
          }),
        )
      ).status,
    ).toBe(200);
    expect(mail).not.toHaveBeenCalled();
    const r = await create();
    for (let i = 0; i < 3; i++)
      expect(
        (await resend(request("resend-restaurant-welcome", { email: r.email })))
          .status,
      ).toBe(200);
    expect(
      (await resend(request("resend-restaurant-welcome", { email: r.email })))
        .status,
    ).toBe(429);
  });
});
