import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  session: null as null | { user: { id: string; role: string; restaurantId?: string } },
  activeId: "r1", tenant: vi.fn(), order: vi.fn(), invoiceRequest: vi.fn(), customers: vi.fn(), sync: vi.fn(),
  claims: vi.fn(), terminalAvailable: true,
  devices: [{ id: "kd-1", label: "Caja" }] as Array<{ id: string; label: string }>,
}));
vi.mock("@/auth", () => ({ auth: async () => m.session }));
vi.mock("@/lib/activeRestaurant", () => ({ getActiveContext: async () => m.session ? { restaurantId: m.activeId, session: m.session } : null }));
vi.mock("@/lib/db", () => ({ db: {
  restaurant: { findUnique: m.tenant }, order: { findUnique: m.order },
  invoiceRequest: { findFirst: m.invoiceRequest }, billingCustomer: { count: m.customers },
  financialOperation: { findMany: m.claims },
} }));
vi.mock("@/lib/payments/terminalAvailability", () => ({
  kushkiTerminalAvailability: async () =>
    m.terminalAvailable ? { available: true, devices: m.devices } : { available: false, reason: "no_device" },
}));
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
  m.invoiceRequest.mockResolvedValue(null); m.customers.mockResolvedValue(0);
  m.claims.mockResolvedValue([]); m.terminalAvailable = true; m.devices = [{ id: "kd-1", label: "Caja" }];
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
    // Los datáfonos son del comercio: el staff recibe la lista para elegir,
    // sin depender de a quién estuviera "asignado".
    expect(page.props.terminalDevices).toEqual([{ id: "kd-1", label: "Caja" }]);
  });

  it("does not expose staff data to another restaurant's operator visiting with a guest QR", async () => {
    m.activeId = "other"; m.session = { user: { id: "other-user", role: "operator", restaurantId: "other" } };
    const page = await flow();
    expect(page.props).toMatchObject({ operatorMode: false, approvedPayments: [], pendingPayments: [], customerStepEnabled: false, creditEnabled: false });
    expect(m.customers).not.toHaveBeenCalled();
    expect(page.props.terminalDevices).toEqual([]);
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

describe("datáfono Kushki en el cobro del staff", () => {
  const smart = { id: "smart", method: "kushki_card_terminal", status: "pending", amountCents: 8580, tipCents: 780, cashTenderCents: null, providerRef: null, reconciliationRequired: false, createdAt: new Date() };
  const withSmart = () => m.order.mockResolvedValue({
    id: "o1", restaurantId: "r1", shortCode: "TEST", subtotalCents: 10000, taxCents: 0, discountCents: 0, discountPct: null,
    status: "paying", table: { id: "t1", number: 1, kind: "table" }, items: [], payments: [smart], simpleInvoiceEmail: null,
  });

  it("sin enviar al equipo: la pantalla la recibe como solicitud (replaceable) y sin pushedAt", async () => {
    withSmart();
    const page = await flow();
    expect(page.props.pendingPayments).toEqual([expect.objectContaining({ id: "smart", replaceable: true, pushedAt: null })]);
  });

  it("ya enviado (reclamo terminal:<id>): en vuelo, con la hora del envío para la cuenta regresiva", async () => {
    withSmart();
    const pushedAt = new Date("2026-10-31T18:30:00Z");
    m.claims.mockResolvedValue([{ paymentId: "smart", createdAt: pushedAt }]);
    const page = await flow();
    expect(page.props.pendingPayments).toEqual([
      expect.objectContaining({ id: "smart", replaceable: false, pushedAt: pushedAt.toISOString() }),
    ]);
  });

  it.each([
    ["operator", true],
    ["platform_admin", true],
    ["group_admin", true],
    ["mesero", false],
  ])("«Resolver cobro» para %s: %s", async (role, expected) => {
    m.session = { user: { id: "u1", role, restaurantId: "r1" } };
    expect((await flow()).props.canResolveTerminal).toBe(expected);
  });

  it("el botón del datáfono Kushki sólo sale si el comercio puede empujar el cobro", async () => {
    expect((await flow()).props.kushkiTerminalAvailable).toBe(true);
    m.terminalAvailable = false;
    expect((await flow()).props.kushkiTerminalAvailable).toBe(false);
  });
});

describe("a qué datáfono va el cobro del staff", () => {
  it("con varios datáfonos disponibles, el staff recibe todos (para elegir), no el primero", async () => {
    m.devices = [{ id: "kd-caja", label: "Caja" }, { id: "kd-terraza", label: "Terraza" }];
    expect((await flow()).props.terminalDevices).toEqual(m.devices);
  });

  it("el comensal no elige datáfono: su solicitud queda en Salón", async () => {
    expect((await flow("0")).props.terminalDevices).toEqual([]);
  });

  it("si el datáfono no está disponible, no hay lista (y el botón no sale)", async () => {
    m.terminalAvailable = false;
    expect((await flow()).props).toMatchObject({ terminalDevices: [], kushkiTerminalAvailable: false });
  });
});
