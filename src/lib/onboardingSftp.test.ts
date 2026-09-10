import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  find: vi.fn(),
  siblings: vi.fn(),
  update: vi.fn(),
  upload: vi.fn(),
  read: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: { kushkiDocument: { findUnique: m.find, findMany: m.siblings, update: m.update } },
}));
vi.mock("@/lib/sftp", () => ({
  sftpConfigured: () => true,
  uploadFileToSftp: m.upload,
}));
vi.mock("fs/promises", () => ({ readFile: m.read }));
import {
  folderNameForRestaurant,
  fileNameForSftpDocument,
  deliverDocumentToSftp,
  deliverOnboardingManifest,
} from "./onboardingSftp";

beforeEach(() => {
  vi.resetAllMocks();
  m.siblings.mockResolvedValue([]);
  m.read.mockResolvedValue(Buffer.from("test document"));
  m.update.mockResolvedValue({});
  m.upload.mockResolvedValue(undefined);
  m.find.mockResolvedValue({
    id: "doc-123456",
    restaurantId: "merchant",
    kind: "rut",
    fileUrl: "/uploads/onboarding/test.pdf",
    fileName: "rut.pdf",
    mimeType: "application/pdf",
    sftpUploadedAt: null,
    restaurant: { legalName: "SON Y MELONA S.A.S.", taxId: "901944469-1" },
  });
});

describe("SFTP merchant folder names", () => {
  it.each(["901944469-1", "901.944.469 - 1", "901944469"])(
    "uses the requested format with NIT %s",
    (nit) => {
      expect(folderNameForRestaurant("SON Y MELONA S.A.S.", nit)).toBe(
        "SON Y MELONA SAS - 901944469",
      );
    },
  );
  it("removes accents and special characters while preserving word separation", () => {
    expect(
      folderNameForRestaurant("  Café & Compañía / S.A.S.  ", "901944469-1"),
    ).toBe("CAFE COMPANIA SAS - 901944469");
  });
  it.each([
    [null, "901944469"],
    ["Test", null],
    ["...", "901944469"],
    ["Test", "901944469-2"],
  ])("rejects incomplete or invalid identity %s / %s", (name, nit) => {
    expect(() => folderNameForRestaurant(name, nit)).toThrow();
  });
  it("retains the full NIT for long names", () => {
    expect(folderNameForRestaurant("A".repeat(300), "901944469-1")).toBe(
      "A".repeat(200) + " - 901944469",
    );
  });
  it("delivers documents and manifest into the same legal-name folder", async () => {
    await deliverDocumentToSftp("doc-123456");
    expect(
      await deliverOnboardingManifest("restaurant", {
        legalName: "SON Y MELONA S.A.S.",
        taxId: "901944469-1",
      }),
    ).toBe(true);
    expect(m.upload.mock.calls.map((c) => c[0].folder)).toEqual([
      "SON Y MELONA SAS - 901944469",
      "SON Y MELONA SAS - 901944469",
    ]);
  });
  it("uses validated submission identity when profile identity is not filled yet", async () => {
    m.find.mockResolvedValue({
      id: "doc-123456",
      kind: "rut",
      fileUrl: "/uploads/onboarding/test.pdf",
      fileName: "rut.pdf",
      mimeType: "application/pdf",
      sftpUploadedAt: null,
      restaurant: { legalName: null, taxId: null },
    });
    await deliverDocumentToSftp("doc-123456", {
      legalName: "SON Y MELONA S.A.S.",
      taxId: "901944469-1",
    });
    expect(m.upload.mock.calls[0][0].folder).toBe(
      "SON Y MELONA SAS - 901944469",
    );
  });
  it("keeps a document pending rather than inventing an unidentified folder", async () => {
    m.find.mockResolvedValue({
      id: "doc-123456",
      kind: "rut",
      fileUrl: "/uploads/onboarding/test.pdf",
      fileName: "rut.pdf",
      mimeType: "application/pdf",
      sftpUploadedAt: null,
      restaurant: { legalName: null, taxId: null },
    });
    await deliverDocumentToSftp("doc-123456");
    expect(m.upload).not.toHaveBeenCalled();
    expect(m.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          sftpError: "sftp_missing_legal_identity",
          sftpAttempts: { increment: 1 },
        },
      }),
    );
  });
});

describe("SFTP readable document names", () => {
  it.each([
    ["rut", "RUT"],
    ["bank_cert", "Certificacion bancaria"],
    ["camara_comercio", "Camara de comercio"],
    ["cedula_rep_legal", "Cedula del representante legal"],
    ["origen_fondos", "Certificacion de origen de fondos"],
    ["estados_financieros", "Estados financieros"],
    ["estatutos", "Estatutos de la sociedad"],
    ["other", "Documento adicional"],
  ] as const)("labels %s in Spanish", (kind, label) => {
    expect(
      fileNameForSftpDocument({
        id: "doc-123456",
        kind,
        mimeType: "application/pdf",
      }),
    ).toBe(`${label}.pdf`);
  });
  it.each([
    ["image/jpeg", "jpg"],
    ["image/jpg", "jpg"],
    ["image/png", "png"],
    ["image/webp", "webp"],
  ])("preserves file format %s", (mimeType, extension) => {
    expect(
      fileNameForSftpDocument({ id: "doc-123456", kind: "rut", mimeType }),
    ).toBe(`RUT.${extension}`);
  });
  it("excludes all document identifiers from the generated name", () => {
    const name = (id: string) =>
      fileNameForSftpDocument({ id, kind: "rut", mimeType: "application/pdf" });
    expect(name("first-123456")).toBe("RUT.pdf");
    expect(name("second-123456")).toBe("RUT.pdf");
    expect(name("first-123456")).toBe(name("first-123456"));
  });
  it("rejects unsafe identities and unsupported formats", () => {
    expect(() =>
      fileNameForSftpDocument({
        id: "../bad",
        kind: "rut",
        mimeType: "application/pdf",
      }),
    ).toThrow();
    expect(() =>
      fileNameForSftpDocument({
        id: "doc",
        kind: "rut",
        mimeType: "text/html",
      }),
    ).toThrow();
  });
  it("uploads with the readable name and retains the delivery marker", async () => {
    await deliverDocumentToSftp("doc-123456");
    expect(m.upload).toHaveBeenCalledWith(
      expect.objectContaining({ fileName: "RUT.pdf" }),
    );
    expect(m.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ sftpUploadedAt: expect.any(Date) }),
      }),
    );
  });
  it("does not resend previously delivered documents on a retry", async () => {
    m.find.mockResolvedValue({ sftpUploadedAt: new Date() });
    await deliverDocumentToSftp("doc-123456");
    expect(m.upload).not.toHaveBeenCalled();
  });
});

// Multiple uploads are retained locally; a plain filename must never silently
// collapse two distinct documents during retries or a bulk onboarding submit.
it("keeps conflicting documents pending without overwriting either", async () => {
  m.siblings.mockResolvedValue([
    { id: "doc-123456", kind: "rut", mimeType: "application/pdf" },
    { id: "another-doc", kind: "rut", mimeType: "application/pdf" },
  ]);
  await deliverDocumentToSftp("doc-123456");
  expect(m.upload).not.toHaveBeenCalled();
  expect(m.update).toHaveBeenCalledWith(expect.objectContaining({
    data: { sftpError: "sftp_document_name_conflict", sftpAttempts: { increment: 1 } },
  }));
});
it("does not upload a manifest that assigns two documents to the same name", async () => {
  expect(await deliverOnboardingManifest("merchant", {
    legalName: "SON Y MELONA S.A.S.", taxId: "901944469-1",
    documents: [{ fileName: "RUT.pdf" }, { fileName: "RUT.pdf" }],
  })).toBe(false);
  expect(m.upload).not.toHaveBeenCalled();
});
