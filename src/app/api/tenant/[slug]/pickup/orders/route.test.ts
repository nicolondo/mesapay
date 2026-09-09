import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Mismo agujero que en /pay, versión cara: pickup es PREPAGO, así que un
 * `demo_card` creaba la orden ya en `paid` y la mandaba a cocina. Sin
 * gate, cualquiera con el link público de recogida comía gratis.
 *
 * El test prueba lo mismo que en /pay: en producción, cero escrituras.
 */

const h = vi.hoisted(() => {
  const writes: string[] = [];
  const record = (label: string) =>
    vi.fn(async () => {
      writes.push(label);
      return { id: `${label}-id` };
    });
  const db = {
    restaurant: {
      findUnique: vi.fn(async () => ({
        id: "rest-1",
        slug: "chefburger",
        pickupEnabled: true,
        pickupHours: null,
        pickupMaxEtaMinutes: null,
        kushkiMerchantId: null,
        country: "CO",
        hasBar: false,
        barSubStations: [] as string[],
      })),
    },
    // Primera lectura del camino "feliz": si el gate corta, no se llama.
    table: { findUnique: vi.fn(async () => null) },
    menuItem: { findMany: vi.fn(async () => []) },
    order: { create: record("order.create") },
    round: { create: record("round.create") },
    orderItem: { create: record("orderItem.create"), findMany: vi.fn(async () => []) },
    payment: { create: record("payment.create") },
    $transaction: vi.fn(async () => {
      writes.push("$transaction");
      return { order: { id: "order-1", shortCode: "P-1234", locale: "es" } };
    }),
  };
  return { writes, db };
});

vi.mock("@/lib/db", () => ({ db: h.db }));
vi.mock("@/lib/dinerSession", () => ({ getDiner: vi.fn(async () => null) }));
vi.mock("@/lib/events", () => ({ publishOrderEvent: vi.fn() }));
vi.mock("@/lib/mailer", () => ({ welcomeIfFirstTime: vi.fn(async () => {}) }));
vi.mock("@/lib/pickupEta", () => ({ computeEtaMinutes: vi.fn(async () => 15) }));
vi.mock("@/lib/billing/countries", () => ({
  getCurrencyForCountry: vi.fn(async () => "COP"),
}));
vi.mock("@/lib/platformConfig", () => ({
  getRestaurantKushkiMode: vi.fn(async () => "mock"),
}));
vi.mock("@/lib/payments", () => ({
  getPaymentProvider: vi.fn(),
  getRestaurantPrivateKey: vi.fn(async () => null),
}));
vi.mock("next-intl/server", () => ({ getLocale: vi.fn(async () => "es") }));

async function post(
  method: string,
  environment: { NODE_ENV: string; MESAPAY_ALLOW_DEMO_PAYMENTS?: string },
) {
  vi.resetModules();
  vi.stubEnv("DATABASE_URL", "postgresql://u:p@localhost:5432/test");
  vi.stubEnv("MESAPAY_ALLOW_DEMO_PAYMENTS", undefined);
  vi.stubEnv("NODE_ENV", environment.NODE_ENV);
  if (environment.MESAPAY_ALLOW_DEMO_PAYMENTS != null) {
    vi.stubEnv(
      "MESAPAY_ALLOW_DEMO_PAYMENTS",
      environment.MESAPAY_ALLOW_DEMO_PAYMENTS,
    );
  }
  const { POST } = await import("./route");
  const res = await POST(
    new Request("http://localhost/api/tenant/chefburger/pickup/orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tableId: "table-pickup",
        pickupName: "Nico",
        pickupPhone: "+57 3001234567",
        method,
        items: [{ menuItemId: "item-1", qty: 1 }],
      }),
    }),
    { params: Promise.resolve({ slug: "chefburger" }) },
  );
  return { res, json: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  h.writes.length = 0;
  vi.clearAllMocks();
  h.db.restaurant.findUnique.mockResolvedValue({
    id: "rest-1",
    slug: "chefburger",
    pickupEnabled: true,
    pickupHours: null,
    pickupMaxEtaMinutes: null,
    kushkiMerchantId: null,
    country: "CO",
    hasBar: false,
    barSubStations: [],
  });
  h.db.table.findUnique.mockResolvedValue(null);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/tenant/[slug]/pickup/orders — gate de pagos demo", () => {
  for (const method of ["demo_card", "demo_nequi"]) {
    it(`en producción rechaza ${method} sin crear orden ni pago`, async () => {
      const { res, json } = await post(method, { NODE_ENV: "production" });

      expect(res.status).toBe(403);
      expect(json.error).toBe("demo_payments_disabled");
      expect(h.writes).toEqual([]);
      expect(h.db.$transaction).not.toHaveBeenCalled();
      // Cortamos antes de la primera lectura del camino feliz.
      expect(h.db.table.findUnique).not.toHaveBeenCalled();
    });
  }

  it("en desarrollo el gate no interfiere — el request sigue su curso", async () => {
    const { res } = await post("demo_card", { NODE_ENV: "development" });

    // Falla más adelante (la mesa de pickup está mockeada como
    // inexistente), pero lo que importa es que NO fue el gate quien
    // cortó: llegamos a la validación de mesa.
    expect(res.status).not.toBe(403);
    expect(h.db.table.findUnique).toHaveBeenCalled();
  });
});

vi.mock("@/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));

vi.mock("@/lib/guestAccess", () => ({ grantGuestAccess: vi.fn() }));
