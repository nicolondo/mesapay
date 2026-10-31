import { beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { Prisma } from "@prisma/client";
import { fakeClient, type FakeOptions } from "@/test/fakeDeletionClient";

const holder = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/db", () => ({
  db: new Proxy({}, { get: (_t, prop) => (holder.client as Record<string | symbol, unknown>)[prop] }),
}));

import { deleteRestaurant } from "./service";
import { isRestaurantDeletionError } from "./errors";

const ROOT = "/srv/mesapay/uploads";
const restaurant = { id: "r1", slug: "sonymelona", name: "Son y Melona", legalName: "SYM SAS", taxId: "900123456", country: "CO" };
const actor = { id: "admin-1", email: "admin@mesapay.co", role: "platform_admin" };
const users = [
  { id: "admin-1", role: "platform_admin" },
  { id: "op-1", role: "operator" },
  { id: "mesero-1", role: "mesero" },
  { id: "rep-1", role: "comercial" },
];

function setup(options: FakeOptions = {}) {
  const fake = fakeClient({
    restaurant,
    rows: {
      user: users,
      menuItem: [{ id: "m1", restaurantId: "r1", photoUrl: "/uploads/plato.webp" }],
      purchaseInvoiceUpload: [{ id: "p1", restaurantId: "r1", fileUrl: "/uploads/factura-1.pdf" }],
    },
    ...options,
  });
  holder.client = fake.client;
  return fake;
}

async function run(overrides: Partial<Parameters<typeof deleteRestaurant>[0]> = {}) {
  const removed: string[] = [];
  const result = deleteRestaurant({
    restaurantId: "r1",
    confirmSlug: "sonymelona",
    actor,
    now: new Date("2026-10-31T12:00:00.000Z"),
    readUpload: async () => Buffer.from("pdf"),
    removeFile: async (p) => {
      removed.push(p);
    },
    ...overrides,
  });
  return { result, removed };
}

async function codeOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (isRestaurantDeletionError(error)) return { code: error.code, details: error.details };
    throw error;
  }
  throw new Error("expected a deletion error");
}

beforeEach(() => {
  vi.restoreAllMocks();
  process.env.UPLOAD_DIR = ROOT;
});

describe("eliminar un comercio", () => {
  it("no existe → not_found, sin tocar nada", async () => {
    const fake = setup({ restaurant: null });
    expect((await codeOf((await run()).result)).code).toBe("not_found");
    expect(fake.events).not.toContain("tx:begin");
  });

  it.each(["", "SONYMELONA", "sonymelona ", "otro"])("confirmSlug incorrecto (%j) → no abre la transacción", async (confirmSlug) => {
    const fake = setup();
    expect((await codeOf((await run({ confirmSlug })).result)).code).toBe("confirm_mismatch");
    expect(fake.events).not.toContain("tx:begin");
    expect(fake.events.some((e) => e.startsWith("deleteMany"))).toBe(false);
  });

  it.each([
    ["payments_pending", (m: string, a: { where?: Record<string, unknown> }) => (m === "payment" && a.where?.status === "pending" ? 2 : 0)],
    ["refunds_in_flight", (m: string, a: { where?: Record<string, unknown> }) => (m === "payment" && "refundReservedCents" in (a.where ?? {}) ? 1 : 0)],
    ["payouts_in_flight", (m: string) => (m === "payout" ? 1 : 0)],
    ["payment_links_pending", (m: string) => (m === "paymentLink" ? 1 : 0)],
    [
      "dian_pending",
      (m: string, a: { where?: Record<string, unknown> }) =>
        m === "dianDocument" && String(JSON.stringify(a.where?.state)).includes("to_send") ? 3 : 0,
    ],
    ["dian_error", (m: string, a: { where?: Record<string, unknown> }) => (m === "dianDocument" && a.where?.state === "error" ? 1 : 0)],
  ] as const)("bloquea con %s y no borra nada", async (code, count) => {
    const fake = setup({ count });
    const error = await codeOf((await run()).result);
    expect(error.code).toBe("blocked");
    expect(error.details.blockers?.map((b) => b.code)).toContain(code);
    expect(fake.events).not.toContain("tx:begin");
  });

  it("bloquea si el débito automático sigue activo", async () => {
    setup({ findUnique: (m) => (m === "billingSubscription" ? { status: "active" } : undefined) as never });
    const error = await codeOf((await run()).result);
    expect(error.details.blockers).toEqual([{ code: "subscription_active", count: 1, detail: ["active"] }]);
  });

  it("si el export falla, no se borra nada: ni filas, ni archivo final, ni disco", async () => {
    const fake = setup();
    const removeFile = vi.fn();
    const promise = deleteRestaurant({
      restaurantId: "r1",
      confirmSlug: "sonymelona",
      actor,
      readUpload: async () => {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      },
      removeFile,
    });
    await expect(promise).rejects.toThrow("permission denied");
    expect(fake.events).toContain("tx:begin");
    expect(fake.events).not.toContain("tx:commit");
    expect(fake.events.filter((e) => /^(deleteMany|delete|updateMany|create):/.test(e))).toEqual([]);
    expect(removeFile).not.toHaveBeenCalled();
  });

  it("guarda el archivo y la auditoría ANTES de borrar, borra el comercio al final y el disco después del commit", async () => {
    const fake = setup();
    const { result, removed } = await run();
    const outcome = await result;
    expect(outcome.archiveId).toBe("deletedRestaurantArchive-1");

    const ev = fake.events;
    const firstDelete = ev.findIndex((e) => e.startsWith("deleteMany:"));
    expect(ev.indexOf("create:deletedRestaurantArchive")).toBeGreaterThan(-1);
    expect(ev.indexOf("create:deletedRestaurantArchive")).toBeLessThan(firstDelete);
    expect(ev.indexOf("create:auditEvent")).toBeLessThan(firstDelete);
    // El bypass de triggers se fija antes de borrar.
    expect(ev.findIndex((e) => e.includes("app.restoring"))).toBeLessThan(firstDelete);
    expect(ev.findIndex((e) => e.includes("app.ingredient_barcodes_restore"))).toBeLessThan(firstDelete);
    // Lock del comercio primero, después las filas padre, y recién ahí se arma el archivo.
    const forUpdate = ev.findIndex((e) => e.startsWith("$queryRaw:") && e.includes("FOR UPDATE"));
    expect(ev.findIndex((e) => e.includes("pg_advisory_xact_lock"))).toBeLessThan(forUpdate);
    const parentLocks = ev.map((e, i) => (e.startsWith("$queryRawUnsafe:") && e.includes("FOR UPDATE") ? i : -1)).filter((i) => i >= 0);
    expect(parentLocks.length).toBeGreaterThan(10);
    expect(Math.min(...parentLocks)).toBeGreaterThan(forUpdate);
    expect(Math.max(...parentLocks)).toBeLessThan(ev.indexOf("create:deletedRestaurantArchive"));
    // Hijos antes que padres (FK RESTRICT): notas crédito antes que la tirilla, líneas antes que la cuenta.
    expect(ev.indexOf("deleteMany:dianDocument")).toBeLessThan(ev.indexOf("deleteMany:creditNote"));
    expect(ev.indexOf("deleteMany:creditNote")).toBeLessThan(ev.indexOf("deleteMany:simpleInvoice"));
    expect(ev.indexOf("deleteMany:journalLine")).toBeLessThan(ev.indexOf("deleteMany:ledgerAccount"));
    expect(ev.indexOf("deleteMany:order")).toBeLessThan(ev.indexOf("deleteMany:table"));
    // El comercio es lo último de la transacción.
    expect(ev.indexOf("delete:restaurant")).toBe(ev.indexOf("tx:commit") - 1);
    // Los archivos del disco recién después del commit.
    expect([...removed].sort()).toEqual([path.join(ROOT, "factura-1.pdf"), path.join(ROOT, "plato.webp")]);
    expect(outcome.files).toMatchObject({ deleted: 2 });
    expect(outcome.summary).toMatchObject({ usersDeleted: 2, usersDetached: 2, usersDisabled: 0, files: 2, filesArchived: 1 });

    const archive = fake.calls.find((c) => c.model === "deletedRestaurantArchive" && c.method === "create")!;
    expect(archive.args.data).toMatchObject({
      deletedRestaurantId: "r1",
      name: "Son y Melona",
      slug: "sonymelona",
      taxId: "900123456",
      deletedByEmail: "admin@mesapay.co",
    });
    const audit = fake.calls.find((c) => c.model === "auditEvent" && c.method === "create")!;
    expect(audit.args.data).toMatchObject({ restaurantId: null, kind: "restaurant.delete", targetId: "r1" });
  });

  it("un platform_admin (o cualquier rol de plataforma) nunca se borra: sólo se desvincula", async () => {
    const fake = setup();
    await (await run()).result;
    const userDeletes = fake.calls.filter((c) => c.model === "user" && c.method === "deleteMany");
    expect(userDeletes).toHaveLength(1);
    const where = userDeletes[0].args.where as { id: { in: string[] }; role: { in: string[] } };
    expect(where.id.in.sort()).toEqual(["mesero-1", "op-1"]);
    expect(where.role.in).not.toContain("platform_admin");
    expect(where.role.in).not.toContain("group_admin");
    const detach = fake.calls.find((c) => c.model === "user" && c.method === "updateMany")!;
    expect((detach.args.where as { id: { in: string[] } }).id.in.sort()).toEqual(["admin-1", "rep-1"]);
    expect(detach.args.data).toEqual({ restaurantId: null });
  });

  it("el personal con filas en otro comercio no se borra: se desvincula y se desactiva", async () => {
    const fake = setup({
      select: (m, a) => {
        if (m === "user" && !a.distinct) return users;
        return m === "shift" && JSON.stringify(a.where).includes("op-1") ? [{ openedById: "op-1" }] : [];
      },
    });
    const outcome = await (await run()).result;
    expect(outcome.summary).toMatchObject({ usersDeleted: 1, usersDisabled: 1 });
    const deleted = fake.calls.find((c) => c.model === "user" && c.method === "deleteMany")!;
    expect((deleted.args.where as { id: { in: string[] } }).id.in).toEqual(["mesero-1"]);
    const disabled = fake.calls.filter((c) => c.model === "user" && c.method === "updateMany");
    expect(disabled.some((c) => (c.args.data as Record<string, unknown>).disabledAt instanceof Date)).toBe(true);
  });

  it("si quedó una fila del comercio sin borrar, aborta antes del DELETE final", async () => {
    const fake = setup({ count: (m, a, s) => (s.deletesStarted && m === "order" && Object.keys(a.where ?? {}).length === 1 ? 3 : 0) });
    const { result, removed } = await run();
    const error = await codeOf(result);
    expect(error.code).toBe("leftover_rows");
    expect(error.details.leftovers).toEqual({ Order: 3 });
    expect(fake.events).not.toContain("delete:restaurant");
    expect(fake.events).not.toContain("tx:commit");
    expect(removed).toEqual([]);
  });

  it("un conflicto de serialización (actividad concurrente) se informa como concurrent_activity", async () => {
    setup({
      transactionError: new Prisma.PrismaClientKnownRequestError("write conflict", { code: "P2034", clientVersion: "6" }),
    });
    expect((await codeOf((await run()).result)).code).toBe("concurrent_activity");
  });
});
