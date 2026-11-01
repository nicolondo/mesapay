import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Base en memoria con DOS comercios: lo que importa probar es que cada
 * acción toca sólo lo del comercio que se va a eliminar, sólo lo que tiene
 * una transición segura, y que deja auditoría.
 */
type Row = Record<string, unknown>;
const h = vi.hoisted(() => ({
  state: {
    orders: [] as Row[],
    payments: [] as Row[],
    links: [] as Row[],
    subs: [] as Row[],
    locks: [] as string[],
    tx: 0,
  },
  audit: vi.fn(),
  publish: vi.fn(),
  cancelSubscription: vi.fn(),
  getProvider: vi.fn(),
  kushkiMode: vi.fn(),
}));

function matches(row: Row, where: Row | undefined): boolean {
  for (const [key, cond] of Object.entries(where ?? {})) {
    if (key === "OR") {
      if (!(cond as Row[]).some((w) => matches(row, w))) return false;
      continue;
    }
    if (key === "order") {
      const order = h.state.orders.find((o) => o.id === row.orderId);
      if (!order || !matches(order, cond as Row)) return false;
      continue;
    }
    const value = row[key];
    if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
      const c = cond as { in?: unknown[]; notIn?: unknown[]; not?: unknown; gt?: Date };
      if (c.in && !c.in.includes(value)) return false;
      if (c.notIn && c.notIn.includes(value)) return false;
      if ("not" in c && value === c.not) return false;
      if (c.gt && !(value instanceof Date && value > c.gt)) return false;
      continue;
    }
    if (value !== cond) return false;
  }
  return true;
}

function table(rows: () => Row[]) {
  return {
    findMany: async ({ where, distinct }: { where?: Row; distinct?: string[] }) => {
      const found = rows().filter((r) => matches(r, where));
      if (!distinct) return found.map((r) => ({ ...r }));
      const seen = new Set<string>();
      return found.filter((r) => {
        const k = distinct.map((d) => String(r[d])).join("|");
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    },
    findFirst: async ({ where }: { where?: Row }) => rows().find((r) => matches(r, where)) ?? null,
    findUnique: async ({ where }: { where: Row }) => {
      const row = rows().find((r) => matches(r, where));
      return row ? { ...row, restaurant: { kushkiMode: row.kushkiMode ?? null } } : null;
    },
    updateMany: async ({ where, data }: { where?: Row; data: Row }) => {
      const hit = rows().filter((r) => matches(r, where));
      for (const r of hit) Object.assign(r, data);
      return { count: hit.length };
    },
    update: async ({ where, data }: { where: Row; data: Row }) => {
      const row = rows().find((r) => matches(r, where));
      if (!row) throw new Error("not found");
      Object.assign(row, data);
      return row;
    },
  };
}

vi.mock("@/lib/db", () => {
  const db: Record<string, unknown> = {
    order: table(() => h.state.orders),
    payment: table(() => h.state.payments),
    paymentLink: table(() => h.state.links),
    billingSubscription: table(() => h.state.subs),
    $queryRaw: async (_strings: TemplateStringsArray, orderId: string) => {
      h.state.locks.push(orderId);
      return [];
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      h.state.tx++;
      return fn(db);
    },
  };
  return { db };
});
vi.mock("@/lib/auditLog", () => ({ recordAuditEvent: h.audit }));
vi.mock("@/lib/events", () => ({ publishOrderEvent: h.publish }));
vi.mock("@/lib/payments/subscription", () => ({ getSubscriptionProvider: h.getProvider }));
vi.mock("@/lib/platformConfig", () => ({ getRestaurantKushkiMode: h.kushkiMode }));

import {
  cancelOpenPaymentLinks,
  cancelSubscriptionDebit,
  declinePendingPaymentRequests,
  describeSubscriptionCancelError,
} from "./resolve";

const actor = { id: "admin-1", email: "admin@mesapay.co", role: "platform_admin" };
const NOW = new Date("2026-10-31T12:00:00.000Z");
const statusOf = (rows: Row[], id: string) => rows.find((r) => r.id === id)?.status;

beforeEach(() => {
  vi.resetAllMocks();
  Object.assign(h.state, { orders: [], payments: [], links: [], subs: [], locks: [], tx: 0 });
  h.getProvider.mockResolvedValue({ cancelSubscription: h.cancelSubscription });
  h.kushkiMode.mockResolvedValue("sandbox");
  h.cancelSubscription.mockResolvedValue({ ok: true });
});

describe("anular cobros pendientes", () => {
  beforeEach(() => {
    h.state.orders.push(
      { id: "o1", restaurantId: "dani" },
      { id: "o2", restaurantId: "dani" },
      { id: "o3", restaurantId: "otro" },
    );
    h.state.payments.push(
      // Solicitudes del comensal de Dani: se declinan.
      { id: "p-cash", orderId: "o1", method: "cash", status: "pending" },
      { id: "p-ext", orderId: "o2", method: "external_terminal", status: "pending" },
      { id: "p-demo", orderId: "o2", method: "demo_cash", status: "pending" },
      // Plata en vuelo con un proveedor: NO se tocan.
      { id: "p-pse", orderId: "o1", method: "kushki_pse", status: "pending" },
      { id: "p-pos", orderId: "o2", method: "kushki_card_terminal", status: "pending" },
      { id: "p-card", orderId: "o2", method: "kushki_card", status: "pending" },
      // Ya resueltos: no se tocan.
      { id: "p-ok", orderId: "o1", method: "cash", status: "approved" },
      // De OTRO comercio: no se tocan.
      { id: "p-otro", orderId: "o3", method: "cash", status: "pending" },
    );
  });

  it("declina sólo las solicitudes pendientes de ESE comercio, una cuenta por transacción y bajo el lock", async () => {
    const result = await declinePendingPaymentRequests("dani", actor);
    expect(result).toEqual({ declined: 3 });
    for (const id of ["p-cash", "p-ext", "p-demo"]) expect(statusOf(h.state.payments, id)).toBe("declined");
    expect(statusOf(h.state.payments, "p-ok")).toBe("approved");
    expect(statusOf(h.state.payments, "p-otro")).toBe("pending");
    expect(h.state.locks).toEqual(["o1", "o2"]);
    expect(h.state.tx).toBe(2);
    expect(h.publish).toHaveBeenCalledWith("dani", { type: "order.updated", orderId: "o1" });
    expect(h.publish).toHaveBeenCalledWith("dani", { type: "order.updated", orderId: "o2" });
  });

  it("un pago con proveedor en vuelo no se toca", async () => {
    await declinePendingPaymentRequests("dani", actor);
    for (const id of ["p-pse", "p-pos", "p-card"]) expect(statusOf(h.state.payments, id)).toBe("pending");
  });

  it("deja auditoría con el admin como actor y los pagos declinados", async () => {
    await declinePendingPaymentRequests("dani", actor);
    expect(h.audit).toHaveBeenCalledTimes(1);
    const event = h.audit.mock.calls[0][0];
    expect(event).toMatchObject({
      kind: "restaurant.delete_blocker.payments_declined",
      restaurantId: "dani",
      actor: { userId: "admin-1", email: "admin@mesapay.co", role: "platform_admin" },
    });
    expect(new Set(event.diff.after.paymentIds)).toEqual(new Set(["p-cash", "p-ext", "p-demo"]));
  });

  it("sin solicitudes pendientes: no abre transacciones ni deja auditoría", async () => {
    h.state.payments = h.state.payments.filter((p) => !["p-cash", "p-ext", "p-demo"].includes(p.id as string));
    expect(await declinePendingPaymentRequests("dani", actor)).toEqual({ declined: 0 });
    expect(h.state.tx).toBe(0);
    expect(h.audit).not.toHaveBeenCalled();
  });
});

describe("anular links de pago", () => {
  beforeEach(() => {
    h.state.links.push(
      { id: "l-open", restaurantId: "dani", status: "pending", providerRef: null, expiresAt: null },
      { id: "l-later", restaurantId: "dani", status: "pending", providerRef: null, expiresAt: new Date("2026-11-30") },
      // PSE iniciado: el banco todavía puede aprobarlo.
      { id: "l-pse", restaurantId: "dani", status: "pending", providerRef: "pse-token", expiresAt: null },
      { id: "l-paid", restaurantId: "dani", status: "paid", providerRef: "tx-1", expiresAt: null },
      { id: "l-otro", restaurantId: "otro", status: "pending", providerRef: null, expiresAt: null },
    );
  });

  it("anula sólo los vigentes sin intento de pago de ESE comercio y deja auditoría", async () => {
    expect(await cancelOpenPaymentLinks("dani", actor, NOW)).toEqual({ cancelled: 2 });
    expect(statusOf(h.state.links, "l-open")).toBe("cancelled");
    expect(statusOf(h.state.links, "l-later")).toBe("cancelled");
    expect(statusOf(h.state.links, "l-pse")).toBe("pending");
    expect(statusOf(h.state.links, "l-paid")).toBe("paid");
    expect(statusOf(h.state.links, "l-otro")).toBe("pending");
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "restaurant.delete_blocker.payment_links_cancelled", restaurantId: "dani" }),
    );
  });
});

describe("cancelar el débito automático", () => {
  const activeSub = () => ({
    id: "sub-1",
    restaurantId: "dani",
    status: "active",
    kushkiSubscriptionId: "ks-1",
    kushkiMode: "sandbox",
    canceledAt: null,
  });

  it("llama a la misma función de Kushki que la ruta del operador, marca cancelada y audita", async () => {
    h.state.subs.push(activeSub());
    expect(await cancelSubscriptionDebit("dani", actor)).toEqual({ ok: true, alreadyCanceled: false, providerUnknown: false });
    expect(h.kushkiMode).toHaveBeenCalledWith({ kushkiMode: "sandbox" });
    expect(h.getProvider).toHaveBeenCalledWith("sandbox");
    expect(h.cancelSubscription).toHaveBeenCalledWith({ subscriptionId: "ks-1" });
    expect(h.state.subs[0]).toMatchObject({ status: "canceled" });
    expect(h.state.subs[0].canceledAt).toBeInstanceOf(Date);
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "subscription.cancel", restaurantId: "dani", actor: expect.objectContaining({ userId: "admin-1" }) }),
    );
  });

  it("si Kushki falla, NO la marca cancelada, no audita y devuelve el error legible", async () => {
    h.state.subs.push(activeSub());
    h.cancelSubscription.mockRejectedValue(
      Object.assign(new Error("kushki 400 on https://api-uat.kushkipagos.com/x"), {
        status: 400,
        body: JSON.stringify({ code: "K004", message: "Subscription not found" }),
        url: "https://api-uat.kushkipagos.com/x",
      }),
    );
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await cancelSubscriptionDebit("dani", actor);
    expect(result).toEqual({ ok: false, error: "provider_rejected", detail: "HTTP 400 · K004 · Subscription not found" });
    expect(h.state.subs[0].status).toBe("active");
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("ya cancelada (o sin suscripción): no llama a Kushki", async () => {
    h.state.subs.push({ ...activeSub(), status: "canceled" });
    expect(await cancelSubscriptionDebit("dani", actor)).toEqual({ ok: true, alreadyCanceled: true, providerUnknown: false });
    expect(await cancelSubscriptionDebit("nadie", actor)).toEqual({ ok: true, alreadyCanceled: true, providerUnknown: false });
    expect(h.cancelSubscription).not.toHaveBeenCalled();
  });

  it("sin id de Kushki: sólo se marca cancelada", async () => {
    h.state.subs.push({ ...activeSub(), kushkiSubscriptionId: null });
    expect(await cancelSubscriptionDebit("dani", actor)).toEqual({ ok: true, alreadyCanceled: false, providerUnknown: false });
    expect(h.cancelSubscription).not.toHaveBeenCalled();
    expect(h.state.subs[0].status).toBe("canceled");
  });

  describe("Kushki no reconoce la suscripción (K012 / 404): se marca cancelada sólo en MESAPAY", () => {
    // Forma de KushkiHttpError (status + body), como lo lanza el cliente real.
    const kushkiError = (status: number, body: string) =>
      Object.assign(new Error(`kushki ${status} on https://api.kushkipagos.com/x`), {
        status,
        body,
        url: "https://api.kushkipagos.com/x",
      });

    it("K012 (id de suscripción no válida) → cancelada, auditada con el motivo y distinguida con providerUnknown", async () => {
      // El caso real: suscripción creada en sandbox, cuenta de cobro hoy en producción.
      h.state.subs.push(activeSub());
      h.cancelSubscription.mockRejectedValue(
        kushkiError(400, JSON.stringify({ code: "K012", message: "ID de suscripción no válida." })),
      );
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const result = await cancelSubscriptionDebit("dani", actor);
      expect(result).toEqual({ ok: true, alreadyCanceled: false, providerUnknown: true });
      expect(h.cancelSubscription).toHaveBeenCalledWith({ subscriptionId: "ks-1" });
      expect(h.state.subs[0]).toMatchObject({ status: "canceled" });
      expect(h.state.subs[0].canceledAt).toBeInstanceOf(Date);
      expect(h.audit).toHaveBeenCalledTimes(1);
      const event = h.audit.mock.calls[0][0];
      expect(event).toMatchObject({
        kind: "subscription.cancel",
        restaurantId: "dani",
        target: { type: "billing_subscription", id: "ks-1" },
        actor: { userId: "admin-1", email: "admin@mesapay.co", role: "platform_admin" },
      });
      expect(event.summary).toContain("Kushki no reconocía la suscripción");
      expect(event.summary).toContain("K012");
      expect(event.summary).toContain("cancelada en MESAPAY");
      expect(warn).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ restaurantId: "dani", subscriptionId: "ks-1" }),
      );
    });

    it("HTTP 404 → igual que K012", async () => {
      h.state.subs.push(activeSub());
      h.cancelSubscription.mockRejectedValue(kushkiError(404, "Not Found"));
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      expect(await cancelSubscriptionDebit("dani", actor)).toEqual({ ok: true, alreadyCanceled: false, providerUnknown: true });
      expect(h.state.subs[0].status).toBe("canceled");
      expect(h.audit).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "subscription.cancel", summary: expect.stringContaining("HTTP 404") }),
      );
    });

    it("cualquier OTRO rechazo (p. ej. K001) sigue siendo fallo: no se marca cancelada ni se audita", async () => {
      h.state.subs.push(activeSub());
      h.cancelSubscription.mockRejectedValue(
        kushkiError(400, JSON.stringify({ code: "K001", message: "Cuerpo de la petición inválido." })),
      );
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      expect(await cancelSubscriptionDebit("dani", actor)).toEqual({
        ok: false,
        error: "provider_rejected",
        detail: "HTTP 400 · K001 · Cuerpo de la petición inválido.",
      });
      expect(h.state.subs[0].status).toBe("active");
      expect(h.audit).not.toHaveBeenCalled();
    });
  });

  it("traduce los fallos a códigos, sin mandar la URL ni mensajes internos", () => {
    expect(describeSubscriptionCancelError(new Error("billing_not_configured: falta la clave privada"))).toEqual({
      error: "billing_not_configured",
    });
    expect(describeSubscriptionCancelError(Object.assign(new Error("x"), { status: 502, body: "<html>" }))).toEqual({
      error: "provider_rejected",
      detail: "HTTP 502",
    });
    expect(describeSubscriptionCancelError(new Error("fetch failed"))).toEqual({ error: "provider_unavailable" });
    expect(describeSubscriptionCancelError("raro")).toEqual({ error: "provider_unavailable" });
  });
});
