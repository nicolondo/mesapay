import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { getEmailTranslator } from "@/lib/emailIntl";

const m = vi.hoisted(() => ({
  session: null as null | { user: { id: string; role: string; restaurantId?: string } },
  activeId: "r1",
  order: vi.fn(), restaurant: vi.fn(), payment: vi.fn(), invoiceRequest: vi.fn(),
}));
vi.mock("@/auth", () => ({ auth: async () => m.session }));
vi.mock("@/lib/staffAccess", () => ({
  OPERATOR_ROLES: ["operator", "platform_admin", "group_admin"],
  staffForRestaurant: async (id: string, roles: string[]) => id === m.activeId && roles.includes(m.session?.user.role ?? "") ? m.session : null,
}));
vi.mock("@/lib/db", () => ({ db: {
  order: { findUnique: m.order }, restaurant: { findUnique: m.restaurant },
  payment: { findUnique: m.payment }, invoiceRequest: { findFirst: m.invoiceRequest },
} }));
vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("not_found"); },
  redirect: (href: string) => { throw new Error(`redirect:${href}`); },
  useRouter: () => ({}),
}));
vi.mock("next-intl/server", () => ({ getTranslations: async (namespace: string) => (await getEmailTranslator("es", namespace)).t }));
vi.mock("@/lib/simpleInvoice", () => ({ invoiceUrlFor: (id: string) => `/factura/${id}` }));
vi.mock("./DoneLive", () => ({ DoneLive: () => null }));
vi.mock("./InvoiceRequestPanel", () => ({ InvoiceRequestPanel: () => null }));

import TerminalPage from "../terminal/page";
import { terminalReturnHref } from "../terminal/TerminalWait";
import PayDone from "./page";
import MeseroDone from "@/app/mesero/cobrar/[orderId]/done/page";

const tenant = { id: "r1", slug: "sample", name: "Test restaurant", serviceMode: "table" };
const now = new Date();
function order(overrides = {}) {
  return {
    id: "o1", restaurantId: "r1", restaurant: tenant, status: "paying",
    subtotalCents: 10_000, taxCents: 800, discountCents: 1_000, totalCents: 10_200, tipCents: 400,
    shortCode: "ABC123", customerEmail: null, simpleInvoiceEmail: null, simpleInvoice: null,
    table: { number: 1, kind: "table" }, rounds: [], items: [],
    payments: [{ id: "p1", amountCents: 4_400, tipCents: 400, status: "approved", method: "cash", createdAt: now }],
    ...overrides,
  };
}
const params = () => Promise.resolve({ slug: "sample", orderId: "o1" });
const done = (op?: string) => PayDone({ params: params(), searchParams: Promise.resolve({ op }) });
const waiterDone = () => MeseroDone({ params: Promise.resolve({ orderId: "o1" }) });

beforeEach(() => {
  vi.clearAllMocks();
  m.session = { user: { id: "u1", role: "operator", restaurantId: "r1" } };
  m.activeId = "r1";
  m.order.mockResolvedValue(order());
  m.restaurant.mockResolvedValue(tenant);
  m.payment.mockResolvedValue({ id: "p1", orderId: "o1", method: "kushki_card_terminal", amountCents: 4_400, status: "pending" });
  m.invoiceRequest.mockResolvedValue(null);
});

describe("terminal return after a partial payment", () => {
  it.each(["operator", "platform_admin", "group_admin"])("preserves staff checkout for %s", async (role) => {
    m.session = { user: { id: "u1", role } };
    const page = await TerminalPage({ params: params(), searchParams: Promise.resolve({ pid: "p1", op: "1" }) });
    expect(page.props).toMatchObject({ initialOrderStatus: "paying", continueHref: "/t/sample/pay/o1?op=1", retryHref: "/t/sample/pay/o1?op=1&declined=1" });
  });

  it("keeps a waiter inside the PWA for another method or a declined card", async () => {
    m.session = { user: { id: "u1", role: "mesero", restaurantId: "r1" } };
    const page = await TerminalPage({ params: params(), searchParams: Promise.resolve({ pid: "p1", op: "1" }) });
    expect(page.props).toMatchObject({ continueHref: "/mesero/cobrar/o1", retryHref: "/mesero/cobrar/o1?declined=1", doneHref: "/mesero/cobrar/o1/done" });
  });

  it.each([null, "kitchen", "bar"])("does not turn op=1 into staff access for %s", async (role) => {
    m.session = role ? { user: { id: "u1", role } } : null;
    const page = await TerminalPage({ params: params(), searchParams: Promise.resolve({ pid: "p1", op: "1" }) });
    expect(page.props.continueHref).toBeUndefined();
    expect(page.props.doneHref).toBe("/t/sample/pay/o1/done?pid=p1");
  });

  it("does not enable staff return links for another active restaurant", async () => {
    m.activeId = "other";
    const page = await TerminalPage({ params: params(), searchParams: Promise.resolve({ pid: "p1", op: "1" }) });
    expect(page.props.continueHref).toBeUndefined();
  });

  it("uses the fresh order status returned with the approved payment", () => {
    expect(terminalReturnHref("approved", "paying", "/done", "/continue", "/retry")).toBe("/continue");
    expect(terminalReturnHref("approved", "paid", "/done", "/continue", "/retry")).toBe("/done");
    expect(terminalReturnHref("approved", "paying", "/done", undefined, "/retry")).toBe("/done");
    expect(terminalReturnHref("pending", "paying", "/done", "/continue", "/retry")).toBeNull();
  });

  it.each(["declined", "refunded"] as const)("uses the scoped retry for %s", (status) => {
    expect(terminalReturnHref(status, "paying", "/done", "/continue", "/retry")).toBe("/retry");
  });
});

describe("direct done pages for partially paid accounts", () => {
  it("keeps op=1 on the operator continuation and includes added tax in the remainder", async () => {
    const html = renderToStaticMarkup(await done("1"));
    expect(html).toContain('href="/t/sample/pay/o1?op=1"');
    expect(html).toContain("Pago recibido");
    expect(html).toContain("$58");
    expect(html).not.toContain("Cuenta pagada");
  });

  it("keeps a waiter continuation in /mesero even when done was reached through /t", async () => {
    m.session = { user: { id: "u1", role: "mesero", restaurantId: "r1" } };
    expect(renderToStaticMarkup(await done("1"))).toContain('href="/mesero/cobrar/o1"');
  });

  it("leaves guest continuation in the guest flow", async () => {
    m.session = null;
    const html = renderToStaticMarkup(await done("1"));
    expect(html).toContain('href="/t/sample/pay/o1"');
    expect(html).not.toContain("op=1");
    expect(html).not.toContain("Cobro realizado");
  });

  it("does not present a partially paid counter order as paid", async () => {
    m.restaurant.mockResolvedValue({ ...tenant, serviceMode: "counter" });
    const html = renderToStaticMarkup(await done("1"));
    expect(html).toContain("Pago recibido");
    expect(html).toContain('href="/t/sample/pay/o1?op=1"');
    expect(html).not.toContain("Pedido pagado");
  });

  it("shows the actual approved amount, remainder and continue action in waiter done", async () => {
    m.session = { user: { id: "u1", role: "mesero", restaurantId: "r1" } };
    const html = renderToStaticMarkup(await waiterDone());
    expect(html).toContain("Pago recibido");
    expect(html).toContain("$44");
    expect(html).toContain("$58");
    expect(html).toContain("Falta");
    expect(html).toContain('href="/mesero/cobrar/o1"');
    expect(html).not.toContain("Cobro realizado");
  });

  it("keeps the completed waiter screen after the final payment", async () => {
    m.session = { user: { id: "u1", role: "mesero", restaurantId: "r1" } };
    m.order.mockResolvedValue(order({ status: "paid", payments: [{ id: "p1", status: "approved", amountCents: 10_200, tipCents: 400 }] }));
    const html = renderToStaticMarkup(await waiterDone());
    expect(html).toContain("Cobro realizado");
    expect(html).not.toContain('href="/mesero/cobrar/o1"');
  });

  it("rejects another restaurant before showing billing data", async () => {
    m.activeId = "other";
    await expect(waiterDone()).rejects.toThrow("not_found");
    expect(m.invoiceRequest).not.toHaveBeenCalled();
  });
});
