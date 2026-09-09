import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  restaurant: vi.fn(),
  find: vi.fn(),
  archive: vi.fn(),
  printers: vi.fn(),
}));
vi.mock("@/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/activeRestaurant", () => ({
  getActiveRestaurantId: mocks.restaurant,
}));
vi.mock("@/lib/secureApi", () => ({
  secureApi: (handler: unknown) => handler,
}));
vi.mock("@/lib/db", () => ({
  db: {
    printAgent: { findFirst: mocks.find },
    $transaction: (run: (tx: unknown) => unknown) =>
      run({
        printAgent: { updateMany: mocks.archive },
        printer: { updateMany: mocks.printers },
      }),
  },
}));
import { DELETE } from "./route";
const remove = () =>
  DELETE(
    new Request("http://localhost/api/operator/print-agents/device", {
      method: "DELETE",
    }),
    { params: Promise.resolve({ id: "device" }) },
  );

beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ user: { role: "operator" } });
  mocks.restaurant.mockResolvedValue("restaurant-a");
  mocks.find.mockResolvedValue({ revokedAt: new Date(), deletedAt: null });
  mocks.archive.mockResolvedValue({ count: 1 });
  mocks.printers.mockResolvedValue({ count: 2 });
});

describe("delete revoked print device", () => {
  it.each([undefined, "mesero", "kitchen"])("rejects role %s", async (role) => {
    mocks.auth.mockResolvedValue(role ? { user: { role } } : null);
    expect((await remove()).status).toBe(403);
    expect(mocks.find).not.toHaveBeenCalled();
  });
  it("does not reveal devices outside the active restaurant", async () => {
    mocks.find.mockResolvedValue(null);
    expect((await remove()).status).toBe(404);
    expect(mocks.find.mock.calls[0][0].where).toEqual({
      id: "device",
      restaurantId: "restaurant-a",
    });
    expect(mocks.archive).not.toHaveBeenCalled();
  });
  it("requires revocation before removal", async () => {
    mocks.find.mockResolvedValue({ revokedAt: null, deletedAt: null });
    expect((await remove()).status).toBe(409);
    expect(mocks.archive).not.toHaveBeenCalled();
  });
  it("retains the device and printers while hiding and disabling them within the tenant", async () => {
    expect((await remove()).status).toBe(200);
    expect(mocks.archive).toHaveBeenCalledWith({
      where: {
        id: "device",
        restaurantId: "restaurant-a",
        revokedAt: { not: null },
        deletedAt: null,
      },
      data: { deletedAt: expect.any(Date) },
    });
    expect(mocks.printers).toHaveBeenCalledWith({
      where: { agentId: "device", restaurantId: "restaurant-a" },
      data: { active: false },
    });
  });
  it("accepts a repeated removal without further writes", async () => {
    mocks.find.mockResolvedValue({
      revokedAt: new Date(),
      deletedAt: new Date(),
    });
    expect((await remove()).status).toBe(200);
    expect(mocks.archive).not.toHaveBeenCalled();
  });
});
