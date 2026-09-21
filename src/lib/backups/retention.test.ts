import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ deleteMany: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { restaurantBackup: { deleteMany: mocks.deleteMany } } }));
import { expiresAtFor, purgeExpiredBackups, RETENTION_DAYS } from "./retention";

beforeEach(() => vi.resetAllMocks());

describe("retention", () => {
  it("keeps a backup for seven days", () => {
    expect(RETENTION_DAYS).toBe(7);
    const now = new Date("2026-09-18T04:00:00.000Z");
    expect(expiresAtFor(now).toISOString()).toBe("2026-09-25T04:00:00.000Z");
  });
  it("purges only what expired before now", async () => {
    mocks.deleteMany.mockResolvedValue({ count: 3 });
    const now = new Date("2026-09-18T04:00:00.000Z");
    expect(await purgeExpiredBackups(now)).toBe(3);
    expect(mocks.deleteMany).toHaveBeenCalledWith({ where: { expiresAt: { lt: now } } });
  });
});
