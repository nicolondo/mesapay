import { describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import type { SnapshotData } from "@/lib/backups/snapshot";
import { buildArchive, fiscalFiles, redactRows, type ArchiveInput } from "./archive";

const signedZip = Buffer.from("PK-fake-signed-invoice-zip");

function snapshot(): SnapshotData {
  return {
    version: 1,
    takenAt: "2026-10-31T12:00:00.000Z",
    restaurantId: "r1",
    restaurant: { id: "r1", slug: "sonymelona", name: "Son y Melona", kushkiPrivateKeyEnc: "secret", kushkiPublicKey: "pub" },
    tables: {
      Order: [{ id: "o1", restaurantId: "r1" }],
      Diner: [{ id: "d1", restaurantId: "r1", email: "a@b.co", passwordHash: "$2a$hash" }],
      SimpleInvoice: [
        { id: "si1", restaurantId: "r1", orderId: "o1", invoiceNumber: 42, totalCents: 10000, snapshot: { invoicePrefix: "SYM" } },
      ],
      CreditNote: [{ id: "cn1", restaurantId: "r1", documentNumber: "NC7", totalCents: 5000 }],
      DianDocument: [
        {
          id: "dd1", restaurantId: "r1", kind: "invoice", state: "accepted", cufe: "cufe-1",
          simpleInvoiceId: "si1", creditNoteId: null, issuedAt: "2026-10-01T15:00:00.000Z",
          xmlZip: signedZip.toString("base64"), responseXml: "<ApplicationResponse/>", deliveryXml: "<AttachedDocument/>",
        },
        {
          id: "dd2", restaurantId: "r1", kind: "credit_note", state: "accepted", cufe: "cude-1",
          simpleInvoiceId: null, creditNoteId: "cn1", issuedAt: "2026-10-02T15:00:00.000Z",
          xmlZip: null, responseXml: "<Response, with comma/>", deliveryXml: null,
        },
      ],
    },
  };
}

function input(overrides: Partial<ArchiveInput> = {}): ArchiveInput {
  return {
    restaurantId: "r1",
    restaurant: { name: "Son y Melona", slug: "sonymelona", legalName: "SYM SAS", taxId: "900123456", country: "CO" },
    deletedAt: new Date("2026-10-31T12:00:00.000Z"),
    deletedBy: { id: "admin-1", email: "admin@mesapay.co" },
    snapshot: snapshot(),
    platform: {
      User: [{ id: "u1", email: "op@sym.co", role: "operator", passwordHash: "$2a$x" }],
      DianConfig: [{ id: "dc1", restaurantId: "r1", certP12Enc: "AAAA", softwarePinEnc: "pin", environment: "produccion" }],
      AuditEvent: [{ id: "a1", restaurantId: "r1", kind: "order.cancel" }],
    },
    summary: { orders: 1 },
    users: { deleted: ["u1"], detached: [], disabled: [] },
    uploads: [
      { url: "/uploads/factura-1.pdf", archive: "purchase-invoices" },
      { url: "/uploads/onboarding/r1_rut.pdf", archive: "onboarding" },
      { url: "/uploads/factura-gone.pdf", archive: "purchase-invoices" },
      { url: "/uploads/photo.webp", archive: false },
    ],
    uploadRoot: "/srv/uploads",
    readUpload: async (p: string) => {
      if (p.endsWith("gone.pdf")) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return Buffer.from(`contents of ${p}`);
    },
    ...overrides,
  };
}

describe("archivo final", () => {
  it("guarda el snapshot con el formato de las copias, las tablas de plataforma, los DIAN y los archivos a conservar", async () => {
    const result = await buildArchive(input());
    const zip = await JSZip.loadAsync(result.zip);
    const data = JSON.parse(await zip.file("data/restaurant.json")!.async("string"));
    expect(data.snapshot.version).toBe(1);
    expect(data.snapshot.restaurantId).toBe("r1");
    expect(data.snapshot.tables.Order).toEqual([{ id: "o1", restaurantId: "r1" }]);
    expect(data.platform.AuditEvent).toHaveLength(1);

    // XML firmado byte a byte, respuesta y AttachedDocument.
    const inv = "fiscal/invoices/SYM42";
    expect(await zip.file(`${inv}/signed-xml.zip`)!.async("nodebuffer")).toEqual(signedZip);
    expect(await zip.file(`${inv}/dian-response.xml`)!.async("string")).toBe("<ApplicationResponse/>");
    expect(await zip.file(`${inv}/attached-document.xml`)!.async("string")).toBe("<AttachedDocument/>");
    const meta = JSON.parse(await zip.file(`${inv}/document.json`)!.async("string"));
    expect(meta.dianDocument).not.toHaveProperty("xmlZip");
    expect(meta.simpleInvoice.invoiceNumber).toBe(42);
    expect(await zip.file("fiscal/credit-notes/NC7/dian-response.xml")!.async("string")).toBe("<Response, with comma/>");
    const index = await zip.file("fiscal/index.csv")!.async("string");
    expect(index.split("\n")[0]).toBe("kind,number,state,issuedAt,cufe,totalCents,folder");
    expect(index).toContain("invoice,SYM42,accepted,2026-10-01T15:00:00.000Z,cufe-1,10000,fiscal/invoices/SYM42");
    expect(index).toContain("credit_note,NC7,accepted");

    // Facturas de compra y documentos del alta; las fotos no se archivan.
    expect(await zip.file("files/purchase-invoices/factura-1.pdf")!.async("string")).toBe("contents of /srv/uploads/factura-1.pdf");
    expect(zip.file("files/onboarding/r1_rut.pdf")).not.toBeNull();
    expect(Object.keys(zip.files).some((n) => n.includes("photo"))).toBe(false);

    const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"));
    expect(manifest).toMatchObject({
      format: "mesapay-deleted-restaurant",
      formatVersion: 1,
      restaurant: { id: "r1", slug: "sonymelona", taxId: "900123456" },
      deletedBy: { email: "admin@mesapay.co" },
      fiscal: { documents: 2, invoices: 1, creditNotes: 1, retentionYears: 5 },
      files: { missing: ["/uploads/factura-gone.pdf"], notArchived: 1 },
      users: { deleted: ["u1"] },
    });
    expect(manifest.files.archived).toHaveLength(2);
    expect(result.manifest).toEqual(manifest);
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("no guarda secretos: contraseñas, llaves Kushki ni el certificado DIAN", async () => {
    const result = await buildArchive(input());
    const zip = await JSZip.loadAsync(result.zip);
    const raw = await zip.file("data/restaurant.json")!.async("string");
    for (const secret of ["$2a$hash", "$2a$x", "\"secret\"", "AAAA", "\"pin\""]) expect(raw).not.toContain(secret);
    const data = JSON.parse(raw);
    expect(data.snapshot.restaurant.kushkiPrivateKeyEnc).toBeNull();
    expect(data.snapshot.restaurant.kushkiPublicKey).toBe("pub");
    expect(data.snapshot.tables.Diner[0]).toMatchObject({ email: "a@b.co", passwordHash: null });
    expect(data.platform.DianConfig[0]).toMatchObject({ environment: "produccion", certP12Enc: null, softwarePinEnc: null });
    expect(result.manifest.redactedFields).toEqual(
      expect.arrayContaining(["Diner.passwordHash", "User.passwordHash", "Restaurant.kushkiPrivateKeyEnc", "DianConfig.certP12Enc"]),
    );
  });

  it("si un archivo a conservar no se puede leer (no por inexistente), el export falla", async () => {
    const readUpload = vi.fn(async () => {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    });
    await expect(buildArchive(input({ readUpload }))).rejects.toThrow("permission denied");
  });

  it("redacta sólo lo listado y anota qué quitó", () => {
    const redacted = new Set<string>();
    expect(redactRows("Order", [{ id: "o1" }], redacted)).toEqual([{ id: "o1" }]);
    expect(redactRows("User", [{ id: "u", passwordHash: "h" }, { id: "v", passwordHash: null }], redacted)).toEqual([
      { id: "u", passwordHash: null },
      { id: "v", passwordHash: null },
    ]);
    expect([...redacted]).toEqual(["User.passwordHash"]);
  });

  it("nombra la carpeta de un documento sin número por su id y no pisa carpetas repetidas", () => {
    const { files } = fiscalFiles({
      DianDocument: [
        { id: "x/../1", kind: "invoice", state: "error" },
        { id: "x/../1", kind: "invoice", state: "error" },
      ],
    });
    const folders = files.filter((f) => f.path.endsWith("document.json")).map((f) => f.path);
    expect(folders).toEqual(["fiscal/invoices/x_.._1/document.json", "fiscal/invoices/x_.._1-2/document.json"]);
  });
});
