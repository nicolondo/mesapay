import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  auth: vi.fn(),
  docs: vi.fn(),
  restaurant: vi.fn(),
  update: vi.fn(),
  manifest: vi.fn(),
  deliver: vi.fn(),
}));
vi.mock("@/auth", () => ({ auth: m.auth }));
vi.mock("@/lib/activeRestaurant", () => ({
  getActiveRestaurantId: async () => "restaurant-test",
}));
vi.mock("@/lib/secureApi", () => ({ secureApi: (h: unknown) => h }));
vi.mock("@/lib/db", () => ({
  db: {
    kushkiDocument: { findMany: m.docs },
    restaurant: { findUnique: m.restaurant, update: m.update },
  },
}));
vi.mock("@/lib/onboardingSftp", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/onboardingSftp")>(),
  deliverOnboardingManifest: m.manifest,
  deliverPendingDocsToSftp: m.deliver,
}));
import { POST } from "./route";
const payload = {
  legalName: "SON Y MELONA S.A.S.",
  taxId: "901944469-1",
  contactEmail: "test@example.test",
  contactPhone: "3000000000",
  bankInfo: {
    bankName: "Bank",
    accountType: "ahorros",
    accountNumber: "123456",
    holderName: "SON Y MELONA S.A.S",
    holderDocType: "NIT",
    holderDocNumber: "901944469",
  },
};
const submit = (taxId = payload.taxId) =>
  POST(
    new Request("http://localhost/api/operator/onboarding/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, taxId }),
    }),
  );
beforeEach(() => {
  vi.resetAllMocks();
  m.auth.mockResolvedValue({ user: { role: "operator" } });
  m.docs.mockResolvedValue([
    {
      id: "document-id",
      kind: "cedula_rep_legal",
      fileName: "id.pdf",
      mimeType: "application/pdf",
    },
    { id: "document-bank", kind: "bank_cert", fileName: "bank.pdf", mimeType: "application/pdf" },
  ]);
  m.restaurant.mockResolvedValue({ country: "CO" });
  m.update.mockResolvedValue({});
  m.manifest.mockResolvedValue(false);
  m.deliver.mockResolvedValue({ configured: true, delivered: 0, total: 2 });
});
it("accepts the same NIT with and without DV but does not claim failed delivery is in review", async () => {
  const response = await submit();
  expect(response.status).toBe(200);
  expect((await response.json()).status).toBe("submitted");
  expect(m.manifest).toHaveBeenCalledWith(
    "restaurant-test",
    expect.objectContaining({ taxId: "901944469-1" }),
  );
  expect(m.update.mock.calls[0][0].data.kushkiOnboardingStatus).toBe(
    "submitted",
  );
});
it("marks in review only after documents and manifest are delivered", async () => {
  m.manifest.mockResolvedValue(true);
  m.deliver.mockResolvedValue({ configured: true, delivered: 2, total: 2 });
  expect((await (await submit()).json()).status).toBe("in_review");
});
it("does not send anything when the NIT or DV differs", async () => {
  expect((await submit("901944469-2")).status).toBe(400);
  expect(m.manifest).not.toHaveBeenCalled();
  expect(m.deliver).not.toHaveBeenCalled();
  expect(m.update).not.toHaveBeenCalled();
});
