import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  session: null as null | { user: { id: string; role: string; restaurantId?: string } },
  activeId: "r1", tenant: vi.fn(), order: vi.fn(), invoiceRequest: vi.fn(), customers: vi.fn(), device: vi.fn(), sync: vi.fn(),
}));
vi.mock("@/auth", () => ({ auth: async () => m.session }));
vi.mock("@/lib/activeRestaurant", () => ({ getActiveContext: async () => m.session ? { restaurantId: m.activeId, session: m.session } : null }));
vi.mock("@/lib/db", () => ({ db: {
  restaurant: { findUnique: m.tenant }, order: { findUnique: m.order },
  invoiceRequest: { findFirst: m.invoiceRequest }, billingCustomer: { count: m.customers },
} }));
vi.mock("@/lib/meseroDevice", () => ({ getAssignedDevice: m.device }));
vi.mock("@/lib/orderTotals", () => ({ syncOrderSubtotalFromLiveItems: m.sync }));
vi.mock("@/lib/platformConfig", () => ({ getRestaurantKushkiMode: async () => "mock" }));
vi.mock("@/lib/billing/countries", () => ({ getCurrencyForCountry: async () => "COP" }));
vi.mock("@/lib/customerCredit", () => ({ loadCustomerCreditSummary: vi.fn() }));
vi.mock("next-intl/server", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("not_found"); } }));
vi.mock("./PayClient", () => ({ PayClient: () => null }));
import { PayFlow } from "./PayFlow";

const approved = { id: "cash-part", method: "cash", status: "approved", amountCents: 3300, tipCents: 300 };
const pending = { id: "card-part", method: "external_terminal", status: "pending", amountCents: 8580, tipCents: 780, cashTenderCents: null, createdAt: new Date() };
beforeEach(() => {
  vi.clearAllMocks();
  m.session = { user: { id: "u1", role: "operator", restaurantId: "r1" } }; m.activeId = "r1";
  m.tenant.mockResolvedValue({ id: "r1", slug: "sample", country: "CO", serviceMode: "table", enabledModules: [], compEnabled: false });
  m.order.mockResolvedValue({
    id: "o1", restaurantId: "r1", shortCode: "TEST", subtotalCents: 10000, taxCents: 1900, discountCents: 1000, discountPct: 10,
    status: "paying", table: { id: "t1", number: 1, kind: "table" }, items: [], payments: [approved, pending], simpleInvoiceEmail: null,
  });
  m.invoiceRequest.mockResolvedValue(null); m.customers.mockResolvedValue(0); m.device.mockResolvedValue(null);
});
const flow = (op = "1") => PayFlow({ slug: "sample", orderId: "o1", op });

describe("shared checkout staff scope", () => {
  it.each(["operator", "platform_admin", "group_admin", "mesero"])("allows %s acting on this restaurant and preserves tax in the balance", async (role) => {
    m.session = { user: { id: "u1", role, restaurantId: "r1" } };
    const page = await flow();
    expect(page.props).toMatchObject({
      operatorMode: true, subtotalCents: 10900, paidCents: 3300, paidTipCents: 300,
      approvedPayments: [{ id: "cash-part", method: "cash", amountCents: 3300, tipCents: 300 }],
      pendingPayments: [{ id: "card-part" }],
    });
    expect(m.device).toHaveBeenCalledWith("u1", "r1");
  });

  it("does not expose staff data to another restaurant's operator visiting with a guest QR", async () => {
    m.activeId = "other"; m.session = { user: { id: "other-user", role: "operator", restaurantId: "other" } };
    const page = await flow();
    expect(page.props).toMatchObject({ operatorMode: false, approvedPayments: [], pendingPayments: [], customerStepEnabled: false, creditEnabled: false });
    expect(m.customers).not.toHaveBeenCalled();
    expect(m.device).not.toHaveBeenCalled();
  });

  it.each([null, "kitchen", "bar", "terminal"])("does not turn op=1 into collector UI for %s", async (role) => {
    m.session = role ? { user: { id: "u1", role, restaurantId: "r1" } } : null;
    expect((await flow()).props).toMatchObject({ operatorMode: false, approvedPayments: [], pendingPayments: [] });
  });

  it("keeps an authenticated operator in the diner flow without the explicit staff flag", async () => {
    expect((await flow("0")).props).toMatchObject({ operatorMode: false, approvedPayments: [], pendingPayments: [] });
    expect(m.customers).not.toHaveBeenCalled();
  });
});
