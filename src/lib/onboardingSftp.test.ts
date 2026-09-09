import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  find: vi.fn(),
  update: vi.fn(),
  upload: vi.fn(),
  read: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: { kushkiDocument: { findUnique: m.find, update: m.update } },
}));
vi.mock("@/lib/sftp", () => ({
  sftpConfigured: () => true,
  uploadFileToSftp: m.upload,
}));
vi.mock("fs/promises", () => ({ readFile: m.read }));
import {
  folderNameForRestaurant,
  deliverDocumentToSftp,
  deliverOnboardingManifest,
} from "./onboardingSftp";

beforeEach(() => {
  vi.resetAllMocks();
  m.read.mockResolvedValue(Buffer.from("test document"));
  m.update.mockResolvedValue({});
  m.upload.mockResolvedValue(undefined);
  m.find.mockResolvedValue({
    id: "doc-123456",
    kind: "rut",
    fileUrl: "/uploads/onboarding/test.pdf",
    fileName: "rut.pdf",
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
