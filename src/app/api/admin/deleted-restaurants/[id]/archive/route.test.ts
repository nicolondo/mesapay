import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), archive: vi.fn(), audit: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("@/lib/auditLog", () => ({ recordAuditEvent: mocks.audit }));
vi.mock("@/lib/restaurantDeletion", () => ({ getDeletedRestaurantArchive: mocks.archive }));

import { GET } from "./route";

const params = { params: Promise.resolve({ id: "arch-1" }) };
const get = () => GET(new Request("http://localhost/api/admin/deleted-restaurants/arch-1/archive"), params);

beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ user: { id: "admin-1", role: "platform_admin" } });
  mocks.archive.mockResolvedValue({
    id: "arch-1",
    slug: "sonymelona",
    name: "Son y Melona",
    deletedAt: new Date("2026-10-31T12:00:00.000Z"),
    archive: new Uint8Array([80, 75, 3, 4]),
    archiveSha256: "abc",
  });
});

describe("descarga del archivo final", () => {
  it.each([null, "operator", "group_admin", "comercial"])("rol %s no descarga", async (role) => {
    mocks.auth.mockResolvedValue(role ? { user: { id: "u", role } } : null);
    expect((await get()).status).toBe(role ? 403 : 401);
    expect(mocks.archive).not.toHaveBeenCalled();
  });

  it("404 si no existe", async () => {
    mocks.archive.mockResolvedValue(null);
    expect((await get()).status).toBe(404);
  });

  it("devuelve el ZIP como adjunto y lo deja en la auditoría", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="mesapay-archive-sonymelona-2026-10-31.zip"');
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([80, 75, 3, 4]));
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ kind: "restaurant.archive.download", restaurantId: null }));
  });
});
