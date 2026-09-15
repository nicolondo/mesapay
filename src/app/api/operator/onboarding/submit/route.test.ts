import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  auth: vi.fn(),
  docs: vi.fn(),
  restaurant: vi.fn(),
  update: vi.fn(),
  manifest: vi.fn(),
  workbook: vi.fn(),
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
  deliverOnboardingWorkbook: m.workbook,
  deliverPendingDocsToSftp: m.deliver,
}));
import { POST } from "./route";
const payload = {
  legalName: "SON Y MELONA S.A.S.",
  taxId: "901944469-1",
  contactEmail: "test@example.test",
  contactPhone: "3000000000",
  // Datos ficticios: ninguna persona real.
  legalRepName: "MARIA FERNANDA LOPEZ GOMEZ",
  legalRepDocNumber: "1020304050",
  bankInfo: {
    bankName: "Bank",
    accountType: "ahorros",
    accountNumber: "123456",
    holderName: "SON Y MELONA S.A.S",
    holderDocType: "NIT",
    holderDocNumber: "901944469",
  },
};
const submit = (overrides: Record<string, unknown> = {}) =>
  POST(
    new Request("http://localhost/api/operator/onboarding/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, ...overrides }),
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
  m.restaurant.mockResolvedValue({
    country: "CO",
    legalCity: "Envigado",
    legalAddress: "CR 6 24 A SUR 285 LC 104",
    city: null,
    address: null,
  });
  m.update.mockResolvedValue({});
  m.manifest.mockResolvedValue(false);
  m.workbook.mockResolvedValue(false);
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
it("marks in review only after documents, manifest and workbook are delivered", async () => {
  m.manifest.mockResolvedValue(true);
  m.workbook.mockResolvedValue(true);
  m.deliver.mockResolvedValue({ configured: true, delivered: 2, total: 2 });
  const body = await (await submit()).json();
  expect(body.status).toBe("in_review");
  expect(body.sftp.workbook).toBe(true);
  expect(m.update.mock.calls[0][0].data.kushkiOnboardingNotes).toBe(
    "SFTP: 2/2 docs + manifiesto ok + excel ok",
  );
});
it("stays submitted when the workbook could not be delivered", async () => {
  m.manifest.mockResolvedValue(true);
  m.deliver.mockResolvedValue({ configured: true, delivered: 2, total: 2 });
  const body = await (await submit()).json();
  expect(body.status).toBe("submitted");
  expect(body.sftp.workbook).toBe(false);
  expect(m.update.mock.calls[0][0].data.kushkiOnboardingNotes).toBe(
    "SFTP: 2/2 docs + manifiesto ok + excel falló",
  );
});
it("builds the Salesforce workbook from the legal identity, address and legal rep", async () => {
  await submit();
  expect(m.workbook).toHaveBeenCalledWith(
    "restaurant-test",
    expect.objectContaining({
      legalName: payload.legalName,
      taxId: payload.taxId,
      city: "Envigado",
      address: "CR 6 24 A SUR 285 LC 104",
      legalRepName: payload.legalRepName,
      legalRepDocNumber: payload.legalRepDocNumber,
      contactEmail: payload.contactEmail,
      contactPhone: payload.contactPhone,
    }),
  );
  expect(m.manifest).toHaveBeenCalledWith(
    "restaurant-test",
    expect.objectContaining({
      legalRepName: payload.legalRepName,
      legalRepDocNumber: payload.legalRepDocNumber,
    }),
  );
});
it("falls back to the operating city and address when the legal ones are empty", async () => {
  m.restaurant.mockResolvedValue({
    country: "CO",
    legalCity: null,
    legalAddress: null,
    city: "Medellín",
    address: "CL 10 20 30",
  });
  await submit();
  expect(m.workbook).toHaveBeenCalledWith(
    "restaurant-test",
    expect.objectContaining({ city: "Medellín", address: "CL 10 20 30" }),
  );
});
it("persists the legal representative on the restaurant", async () => {
  await submit();
  expect(m.update.mock.calls[0][0].data).toEqual(
    expect.objectContaining({
      legalRepName: payload.legalRepName,
      legalRepDocNumber: payload.legalRepDocNumber,
    }),
  );
});
it("rejects the submission without a legal representative and uploads nothing", async () => {
  expect((await submit({ legalRepName: undefined })).status).toBe(400);
  expect(m.manifest).not.toHaveBeenCalled();
  expect(m.workbook).not.toHaveBeenCalled();
  expect(m.deliver).not.toHaveBeenCalled();
  expect(m.update).not.toHaveBeenCalled();
});
it("does not send anything when the NIT or DV differs", async () => {
  expect((await submit({ taxId: "901944469-2" })).status).toBe(400);
  expect(m.manifest).not.toHaveBeenCalled();
  expect(m.workbook).not.toHaveBeenCalled();
  expect(m.deliver).not.toHaveBeenCalled();
  expect(m.update).not.toHaveBeenCalled();
});
