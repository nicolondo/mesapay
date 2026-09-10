import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  manifest: vi.fn(),
  pending: vi.fn(),
  update: vi.fn(),
  docs: [
    {
      id: "document-bank",
      kind: "bank_cert",
      mimeType: "application/pdf",
      fileName: "WhatsApp-Scan-ORIGINAL-BANCO.pdf",
    },
    {
      id: "document-id",
      kind: "cedula_rep_legal",
      mimeType: "image/jpeg",
      fileName: "FOTO-ORIGINAL-CEDULA.png",
    },
  ],
}));
vi.mock("@/lib/secureApi", () => ({ secureApi: (fn: unknown) => fn }));
vi.mock("@/auth", () => ({
  auth: async () => ({ user: { id: "operator", role: "operator" } }),
}));
vi.mock("@/lib/activeRestaurant", () => ({
  getActiveRestaurantId: async () => "merchant",
}));
vi.mock("@/lib/db", () => ({
  db: {
    kushkiDocument: { findMany: async () => m.docs },
    restaurant: {
      findUnique: async () => ({ country: "CO" }),
      update: m.update,
    },
  },
}));
vi.mock("@/lib/onboardingSftp", async (importOriginal) => {
  const original = await importOriginal<typeof import("./onboardingSftp")>();
  return {
    ...original,
    deliverOnboardingManifest: m.manifest,
    deliverPendingDocsToSftp: m.pending,
  };
});
import { POST } from "@/app/api/operator/onboarding/submit/route";
import { fileNameForSftpDocument } from "./onboardingSftp";
beforeEach(() => {
  vi.clearAllMocks();
  m.manifest.mockResolvedValue(true);
  m.pending.mockResolvedValue({ configured: true, delivered: 2, total: 2 });
});
it("sends the same generated names as the SFTP files and never the original upload names", async () => {
  const response = await POST(
    new Request("https://example.test/api/operator/onboarding/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        legalName: "Fixture SAS",
        taxId: "901944469-1",
        contactEmail: "fixture@example.test",
        contactPhone: "3001234567",
        bankInfo: {
          bankName: "Fixture",
          accountType: "ahorros",
          accountNumber: "12345678",
          holderName: "Fixture SAS",
          holderDocType: "NIT",
          holderDocNumber: "901944469",
        },
      }),
    }),
  );
  expect(response.status).toBe(200);
  const manifest = m.manifest.mock.calls[0][1];
  expect(manifest.documents).toEqual([
    {
      kind: "bank_cert",
      fileName: fileNameForSftpDocument({
        id: "document-bank",
        kind: "bank_cert",
        mimeType: "application/pdf",
      }),
      mimeType: "application/pdf",
    },
    {
      kind: "cedula_rep_legal",
      fileName: fileNameForSftpDocument({
        id: "document-id",
        kind: "cedula_rep_legal",
        mimeType: "image/jpeg",
      }),
      mimeType: "image/jpeg",
    },
  ]);
  expect(JSON.stringify(manifest)).not.toContain("ORIGINAL");
  expect(JSON.stringify(manifest)).not.toContain("WhatsApp");
});
