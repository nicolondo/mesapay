import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import type { Prisma } from "@prisma/client";

vi.mock("@/lib/db", () => ({ db: {} }));
import { collectUploadRefs, removeUploadedFiles, resolveUploadPath } from "./files";

const root = "/srv/mesapay/uploads";

/** Cliente falso: `used` son las URLs que todavía referencia alguna fila que queda. */
function clientWith(used: string[] = [], fail = false): Prisma.TransactionClient {
  return new Proxy(
    {},
    {
      get: () => ({
        findMany: async (args: { where: Record<string, { in: string[] }>; select: Record<string, boolean> }) => {
          if (fail) throw new Error("db down");
          const field = Object.keys(args.select)[0];
          return args.where[field].in.filter((u) => used.includes(u)).map((u) => ({ [field]: u }));
        },
      }),
    },
  ) as unknown as Prisma.TransactionClient;
}

describe("resolveUploadPath", () => {
  it("resuelve sólo archivos subidos dentro de la raíz", () => {
    expect(resolveUploadPath("/uploads/abc.webp", root)).toBe(path.join(root, "abc.webp"));
    expect(resolveUploadPath("/uploads/onboarding/r1_x.pdf", root)).toBe(path.join(root, "onboarding", "r1_x.pdf"));
    expect(resolveUploadPath("/uploads/abc.webp?v=2", root)).toBe(path.join(root, "abc.webp"));
  });
  it.each([
    "https://cdn.example.com/a.jpg",
    "/uploads/../etc/passwd",
    "/uploads/../../secret",
    "/uploads/",
    "/uploads/crm/brochure.pdf",
    "/uploads/a\\..\\b",
    "uploads/abc.webp",
    null,
    42,
  ])("rechaza %j", (url) => {
    expect(resolveUploadPath(url, root)).toBeNull();
  });
});

describe("collectUploadRefs", () => {
  it("junta las URLs del comercio sin repetir y marca qué se archiva", () => {
    const refs = collectUploadRefs({
      restaurant: { logoUrl: "/uploads/logo.webp" },
      tables: {
        MenuItem: [{ photoUrl: "/uploads/a.webp" }, { photoUrl: "/uploads/a.webp" }, { photoUrl: "https://x/y.jpg" }],
        StaffShift: [{ checkInPhotoUrl: "/uploads/in.jpg", checkOutPhotoUrl: null }],
        PurchaseInvoiceUpload: [{ fileUrl: "/uploads/factura-1.pdf" }],
      },
      platform: { KushkiDocument: [{ fileUrl: "/uploads/onboarding/r1_rut.pdf" }] },
    });
    expect(refs).toEqual(
      expect.arrayContaining([
        { url: "/uploads/logo.webp", archive: false },
        { url: "/uploads/a.webp", archive: false },
        { url: "/uploads/in.jpg", archive: false },
        { url: "/uploads/factura-1.pdf", archive: "purchase-invoices" },
        { url: "/uploads/onboarding/r1_rut.pdf", archive: "onboarding" },
      ]),
    );
    expect(refs).toHaveLength(5);
  });
});

describe("removeUploadedFiles (después del commit)", () => {
  it("borra lo del comercio, conserva lo que otra fila usa y no falla por un archivo", async () => {
    const remove = vi.fn(async (p: string) => {
      if (p.endsWith("gone.webp")) throw Object.assign(new Error("nope"), { code: "ENOENT" });
      if (p.endsWith("locked.webp")) throw Object.assign(new Error("perm"), { code: "EACCES" });
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const report = await removeUploadedFiles(
      ["/uploads/a.webp", "/uploads/shared.webp", "/uploads/gone.webp", "/uploads/locked.webp", "/uploads/../x"],
      { client: clientWith(["/uploads/shared.webp"]), remove, root },
    );
    expect(report).toEqual({ deleted: 1, kept: 2, missing: 1, failed: 1 });
    expect(remove).not.toHaveBeenCalledWith(path.join(root, "shared.webp"));
    expect(remove).toHaveBeenCalledWith(path.join(root, "a.webp"));
    expect(error).toHaveBeenCalledWith("restaurant_delete_file_failed", expect.objectContaining({ url: "/uploads/locked.webp" }));
    error.mockRestore();
  });

  it("si no puede confirmar quién más usa los archivos, no borra ninguno", async () => {
    const remove = vi.fn();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const report = await removeUploadedFiles(["/uploads/a.webp"], { client: clientWith([], true), remove, root });
    expect(report).toEqual({ deleted: 0, kept: 1, missing: 0, failed: 0 });
    expect(remove).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
