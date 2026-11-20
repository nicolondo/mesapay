// Push a los meseros cuando la ronda del COMENSAL dispara un aviso «Revisar»:
// sólo por señales nacidas con esa ronda, con el detalle en el cuerpo.
import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ findUnique: vi.fn(), push: vi.fn() }));
vi.mock("./db", () => ({ db: { order: { findUnique: m.findUnique } } }));
vi.mock("./push", () => ({ sendPushToMeserosForTable: m.push }));
vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string, values?: Record<string, unknown>) =>
    `${key}${values ? JSON.stringify(values) : ""}`,
}));

import { notifyMeserosIfReviewNeeded } from "./orderReviewNotify";

const at = (hhmm: string) => new Date(`2026-11-18T${hhmm}:00-05:00`);
const row = (rounds: Array<{ placedAt: Date; status: string }>) => ({
  status: "placed",
  createdAt: at("13:00"),
  discountCents: 12_000,
  discountPct: 20,
  discountBillingCustomerId: "cust-1",
  discountAppliedAt: at("13:20"),
  reviewAckAt: null,
  table: { number: 7, kind: "standard" },
  discountBillingCustomer: { customerName: "Cliente Demo SAS" },
  rounds,
  payments: [{ status: "declined", createdAt: at("13:21") }],
});

beforeEach(() => vi.clearAllMocks());

it("la ronda del comensal que dispara el aviso manda push a los meseros de la mesa", async () => {
  m.findUnique.mockResolvedValue(row([{ placedAt: at("13:00"), status: "cancelled" }, { placedAt: at("18:30"), status: "placed" }]));
  await notifyMeserosIfReviewNeeded({ restaurantId: "r1", orderId: "o1", roundPlacedAt: at("18:30") });
  expect(m.push).toHaveBeenCalledWith("r1", 7, expect.objectContaining({
    title: 'pushTitle{"number":7}',
    tag: "review-o1",
    url: "/mesero/mesas",
  }));
  const body = m.push.mock.calls[0][2].body as string;
  expect(body).toContain("staleCustomerDiscount");
  expect(body).toContain("Cliente Demo SAS");
  expect(body).toContain("openSinceDeclined");
});

it("una señal vieja (disparada por otra ronda) no vuelve a mandar push", async () => {
  m.findUnique.mockResolvedValue(row([
    { placedAt: at("13:00"), status: "cancelled" },
    { placedAt: at("18:30"), status: "placed" },
    { placedAt: at("18:45"), status: "placed" },
  ]));
  await notifyMeserosIfReviewNeeded({ restaurantId: "r1", orderId: "o1", roundPlacedAt: at("18:45") });
  expect(m.push).not.toHaveBeenCalled();
});

it("nunca lanza: un error queda en el log", async () => {
  m.findUnique.mockRejectedValue(new Error("db down"));
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  await expect(notifyMeserosIfReviewNeeded({ restaurantId: "r1", orderId: "o1", roundPlacedAt: at("18:30") })).resolves.toBeUndefined();
  spy.mockRestore();
});
