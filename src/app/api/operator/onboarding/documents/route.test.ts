import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  auth: vi.fn(),
  findMany: vi.fn(),
  create: vi.fn(),
  deleteMany: vi.fn(),
  updateMany: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  unlink: vi.fn(),
  deliver: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("@/auth", () => ({ auth: m.auth }));
vi.mock("@/lib/activeRestaurant", () => ({
  getActiveRestaurantId: async () => "r1",
}));
vi.mock("@/lib/secureApi", () => ({ secureApi: (h: unknown) => h }));
vi.mock("fs/promises", () => ({
  writeFile: m.writeFile,
  mkdir: m.mkdir,
  unlink: m.unlink,
}));
vi.mock("@/lib/onboardingSftp", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/onboardingSftp")>()),
  deliverDocumentToSftp: m.deliver,
  removeDocumentFromSftp: m.remove,
}));
vi.mock("@/lib/db", () => {
  const tx = {
    kushkiDocument: {
      findMany: m.findMany,
      create: m.create,
      deleteMany: m.deleteMany,
    },
    restaurant: { updateMany: m.updateMany },
  };
  return {
    db: { ...tx, $transaction: (cb: (t: typeof tx) => unknown) => cb(tx) },
  };
});
import { POST } from "./route";

const MERCHANT = { legalName: "SON Y MELONA S.A.S.", taxId: "901944469-1" };

function upload(
  kind: string,
  file: File = new File(["%PDF-1.4"], "rut.pdf", { type: "application/pdf" }),
) {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("kind", kind);
  return POST(
    new Request("http://localhost/api/operator/onboarding/documents", {
      method: "POST",
      body: fd,
    }),
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  m.auth.mockResolvedValue({ user: { role: "operator", id: "u1" } });
  m.findMany.mockResolvedValue([]);
  m.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "new",
    ...data,
  }));
  m.deleteMany.mockResolvedValue({ count: 0 });
  m.updateMany.mockResolvedValue({ count: 0 });
  m.writeFile.mockResolvedValue(undefined);
  m.mkdir.mockResolvedValue(undefined);
  m.unlink.mockResolvedValue(undefined);
  m.deliver.mockResolvedValue(undefined);
  m.remove.mockResolvedValue(true);
});

describe("POST /api/operator/onboarding/documents", () => {
  it("el primer documento de un tipo se crea, se entrega y sólo sube el estado desde not_started", async () => {
    const res = await upload("rut");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.document.id).toBe("new");
    expect(body.replacedIds).toEqual([]);
    expect(m.create).toHaveBeenCalledTimes(1);
    expect(m.create.mock.calls[0][0].data).toEqual(
      expect.objectContaining({ restaurantId: "r1", kind: "rut", mimeType: "application/pdf" }),
    );
    expect(m.deleteMany).not.toHaveBeenCalled();
    expect(m.unlink).not.toHaveBeenCalled();
    expect(m.remove).not.toHaveBeenCalled();
    expect(m.deliver).toHaveBeenCalledWith("new");
    expect(m.updateMany).toHaveBeenCalledWith({
      where: { id: "r1", kushkiOnboardingStatus: "not_started" },
      data: { kushkiOnboardingStatus: "docs_uploaded" },
    });
  });

  it("subir otro del mismo tipo reemplaza al anterior (pdf → pdf: mismo nombre remoto, sin borrado en SFTP)", async () => {
    m.findMany.mockResolvedValue([
      {
        id: "old",
        kind: "rut",
        mimeType: "application/pdf",
        fileUrl: "/uploads/onboarding/r1_deadbeef.pdf",
        sftpUploadedAt: new Date("2026-09-01T00:00:00Z"),
        restaurant: MERCHANT,
      },
    ]);
    const res = await upload("rut");
    expect(res.status).toBe(200);
    expect((await res.json()).replacedIds).toEqual(["old"]);
    expect(m.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { restaurantId: "r1", kind: "rut" } }),
    );
    expect(m.create).toHaveBeenCalledTimes(1);
    expect(m.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["old"] } } });
    expect(m.unlink).toHaveBeenCalledTimes(1);
    expect(String(m.unlink.mock.calls[0][0])).toMatch(/onboarding[\\/]r1_deadbeef\.pdf$/);
    // El put del nuevo RUT.pdf sobreescribe al viejo: nada que borrar.
    expect(m.remove).not.toHaveBeenCalled();
    expect(m.deliver).toHaveBeenCalledWith("new");
  });

  it("si cambia la extensión (pdf → jpg) borra el archivo remoto viejo", async () => {
    const old = {
      id: "old",
      kind: "rut",
      mimeType: "application/pdf",
      fileUrl: "/uploads/onboarding/r1_deadbeef.pdf",
      sftpUploadedAt: new Date("2026-09-01T00:00:00Z"),
      restaurant: MERCHANT,
    };
    m.findMany.mockResolvedValue([old]);
    const res = await upload(
      "rut",
      new File([new Uint8Array([0xff, 0xd8, 0xff])], "rut.jpg", { type: "image/jpeg" }),
    );
    expect(res.status).toBe(200);
    expect(m.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["old"] } } });
    expect(m.remove).toHaveBeenCalledWith(old);
    expect(m.deliver).toHaveBeenCalledWith("new");
  });

  it("no borra el remoto de un reemplazado que nunca llegó al SFTP", async () => {
    m.findMany.mockResolvedValue([
      {
        id: "old",
        kind: "rut",
        mimeType: "application/pdf",
        fileUrl: "/uploads/onboarding/r1_deadbeef.pdf",
        sftpUploadedAt: null,
        restaurant: MERCHANT,
      },
    ]);
    await upload(
      "rut",
      new File([new Uint8Array([0xff, 0xd8, 0xff])], "rut.jpg", { type: "image/jpeg" }),
    );
    expect(m.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["old"] } } });
    expect(m.unlink).toHaveBeenCalledTimes(1);
    expect(m.remove).not.toHaveBeenCalled();
  });

  it("los documentos 'other' se acumulan: no se reemplaza ninguno", async () => {
    m.findMany.mockResolvedValue([
      { id: "other-1", kind: "other", mimeType: "application/pdf", fileUrl: "/uploads/onboarding/a.pdf", sftpUploadedAt: new Date(), restaurant: MERCHANT },
    ]);
    const res = await upload("other");
    expect(res.status).toBe(200);
    expect((await res.json()).replacedIds).toEqual([]);
    expect(m.findMany).not.toHaveBeenCalled();
    expect(m.create).toHaveBeenCalledTimes(1);
    expect(m.deleteMany).not.toHaveBeenCalled();
    expect(m.unlink).not.toHaveBeenCalled();
    expect(m.remove).not.toHaveBeenCalled();
    expect(m.deliver).toHaveBeenCalledWith("new");
  });

  it("rechaza archivos de más de 10 MB sin crear nada", async () => {
    const res = await upload(
      "rut",
      new File([new Uint8Array(11 * 1024 * 1024)], "big.pdf", { type: "application/pdf" }),
    );
    expect(res.status).toBe(413);
    expect(m.findMany).not.toHaveBeenCalled();
    expect(m.writeFile).not.toHaveBeenCalled();
    expect(m.create).not.toHaveBeenCalled();
    expect(m.deleteMany).not.toHaveBeenCalled();
    expect(m.updateMany).not.toHaveBeenCalled();
    expect(m.deliver).not.toHaveBeenCalled();
  });
});
