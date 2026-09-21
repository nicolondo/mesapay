import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  restaurant: vi.fn(),
  restore: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("@/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/activeRestaurant", () => ({
  getActiveRestaurantId: mocks.restaurant,
}));
vi.mock("@/lib/secureApi", () => ({
  secureApi: (handler: unknown) => handler,
}));
vi.mock("@/lib/backups", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/backups")>()),
  restoreSnapshot: mocks.restore,
  deleteBackup: mocks.remove,
}));
import { BackupError } from "@/lib/backups/errors";
import { DELETE, POST } from "./route";

const params = { params: Promise.resolve({ id: "backup-1" }) };
const restore = (body: unknown) =>
  POST(
    new Request("http://localhost/api/operator/backups/backup-1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    params,
  );
const remove = () =>
  DELETE(new Request("http://localhost/api/operator/backups/backup-1", { method: "DELETE" }), params);

beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ user: { id: "user-1", role: "operator" } });
  mocks.restaurant.mockResolvedValue("restaurant-a");
  mocks.restore.mockResolvedValue({ restored: { Order: 2 }, pruned: {}, preRestoreBackupId: "pre-1" });
  mocks.remove.mockResolvedValue(true);
});

describe("restore a backup", () => {
  it.each([undefined, "mesero", "kitchen", "terminal"])("rejects role %s", async (role) => {
    mocks.auth.mockResolvedValue(role ? { user: { id: "u", role } } : null);
    expect((await restore({ action: "restore", confirm: "RESTAURAR" })).status).toBe(403);
    expect(mocks.restore).not.toHaveBeenCalled();
  });
  it("needs an active restaurant", async () => {
    mocks.restaurant.mockResolvedValue(null);
    expect((await restore({ action: "restore", confirm: "RESTAURAR" })).status).toBe(400);
    expect(mocks.restore).not.toHaveBeenCalled();
  });
  it.each(["", "restaurar", "RESTAURAR ", "SI", undefined])(
    "requires the exact confirmation word (got %j)",
    async (confirm) => {
      const response = await restore({ action: "restore", confirm });
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe("confirm_required");
      expect(mocks.restore).not.toHaveBeenCalled();
    },
  );
  it("rejects an unknown action", async () => {
    expect((await restore({ action: "wipe", confirm: "RESTAURAR" })).status).toBe(400);
    expect(mocks.restore).not.toHaveBeenCalled();
  });
  it("restores with the active restaurant and the actor from the session", async () => {
    const response = await restore({ action: "restore", confirm: "RESTAURAR" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      restored: { Order: 2 },
      pruned: {},
      preRestoreBackupId: "pre-1",
    });
    expect(mocks.restore).toHaveBeenCalledWith({
      restaurantId: "restaurant-a",
      backupId: "backup-1",
      actorId: "user-1",
    });
  });
  it("maps a backup of another restaurant to 404", async () => {
    mocks.restore.mockRejectedValue(new BackupError("backup_not_found"));
    expect((await restore({ action: "restore", confirm: "RESTAURAR" })).status).toBe(404);
  });
  it("refuses a partial restore and names the missing tables", async () => {
    mocks.restore.mockRejectedValue(new BackupError("backup_missing_tables", { missing: ["Voucher"] }));
    const response = await restore({ action: "restore", confirm: "RESTAURAR" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "backup_missing_tables", missing: ["Voucher"] });
  });
});

describe("delete a backup", () => {
  it("deletes within the active restaurant only", async () => {
    expect((await remove()).status).toBe(200);
    expect(mocks.remove).toHaveBeenCalledWith("restaurant-a", "backup-1");
  });
  it("does not reveal backups of other restaurants", async () => {
    mocks.remove.mockResolvedValue(false);
    expect((await remove()).status).toBe(404);
  });
  it("rejects a mesero", async () => {
    mocks.auth.mockResolvedValue({ user: { id: "u", role: "mesero" } });
    expect((await remove()).status).toBe(403);
    expect(mocks.remove).not.toHaveBeenCalled();
  });
});
