import { describe, expect, it } from "vitest";

import { salonVisualStateOf, type SalonOrderSignals } from "./salonVisualState";

/**
 * Estado visual de una cuenta abierta — el que ordena las mesas activas en el
 * salón del admin y en el datáfono. Umbral del comercio: 20 minutos (pedidos
 * explícitos: urgente a los 5, riesgo a los 10; comieron y no pagan: 20).
 */

const NOW = new Date("2026-11-13T20:00:00Z");
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);
const opts = { dangerMinutes: 20, now: NOW };

const served = (minutes: number) => ({
  servedAt: ago(minutes),
  cancelledAt: null,
  kitchenStatus: "served",
});
const cooking = () => ({ servedAt: null, cancelledAt: null, kitchenStatus: "in_kitchen" });
const ready = () => ({ servedAt: null, cancelledAt: null, kitchenStatus: "ready" });

const pending = (minutes: number, providerRef: string | null = null) => ({
  status: "pending",
  providerRef,
  createdAt: ago(minutes),
  settledAt: null,
});
const approved = (minutes: number) => ({
  status: "approved",
  providerRef: "ref",
  createdAt: ago(minutes),
  settledAt: ago(minutes),
});

function order(extra: Partial<SalonOrderSignals> = {}): SalonOrderSignals {
  return {
    outstandingCents: 50_000_00,
    items: [served(2)],
    payments: [],
    needsWaiter: false,
    waiterCalledAt: null,
    ...extra,
  };
}

describe("salonVisualStateOf", () => {
  it("cocinando / listo para servir / comiendo, sin urgencia", () => {
    expect(salonVisualStateOf(order({ items: [cooking()] }), opts).visualState).toBe("cooking");
    expect(salonVisualStateOf(order({ items: [served(1), ready()] }), opts).visualState).toBe(
      "ready_to_serve",
    );
    expect(salonVisualStateOf(order(), opts).visualState).toBe("eating");
  });

  it("un pago pendiente SIN providerRef es un cobro pedido; envejecido, urgente; más, riesgo", () => {
    expect(salonVisualStateOf(order({ payments: [pending(1)] }), opts).visualState).toBe(
      "needs_payment",
    );
    expect(salonVisualStateOf(order({ payments: [pending(6)] }), opts).visualState).toBe(
      "needs_payment_urgent",
    );
    const aged = salonVisualStateOf(order({ payments: [pending(11)] }), opts);
    expect(aged.visualState).toBe("danger");
    expect(aged.risk).toMatchObject({ level: "danger", reason: "request", agingMinutes: 11 });
  });

  it("un pago pendiente CON providerRef ya está en vuelo: no es un pedido esperando", () => {
    const state = salonVisualStateOf(
      order({ items: [cooking()], payments: [pending(30, "kushki-123")] }),
      opts,
    );
    expect(state.visualState).toBe("cooking");
    expect(state.risk.level).toBe("none");
  });

  it("el mesero llamado cuenta como pedido pendiente", () => {
    expect(
      salonVisualStateOf(order({ needsWaiter: true, waiterCalledAt: ago(1) }), opts).visualState,
    ).toBe("needs_payment");
    expect(
      salonVisualStateOf(order({ needsWaiter: true, waiterCalledAt: ago(7) }), opts).visualState,
    ).toBe("needs_payment_urgent");
  });

  it("comieron y no pagan: a los 10 min en riesgo leve, a los 20 riesgo de fuga", () => {
    expect(salonVisualStateOf(order({ items: [served(12)] }), opts).visualState).toBe(
      "eating_at_risk",
    );
    const walkout = salonVisualStateOf(order({ items: [served(25)] }), opts);
    expect(walkout.visualState).toBe("danger");
    expect(walkout.risk).toMatchObject({ level: "danger", reason: "served" });
  });

  it("un pago aprobado posterior reinicia el reloj (están pagando, no fugando)", () => {
    const state = salonVisualStateOf(
      order({ items: [served(25)], payments: [approved(40), approved(3)] }),
      opts,
    );
    expect(state.visualState).toBe("eating");
    expect(state.risk.level).toBe("none");
  });

  it("sin saldo pendiente no hay riesgo aunque lleven rato servidos", () => {
    const state = salonVisualStateOf(order({ outstandingCents: 0, items: [served(60)] }), opts);
    expect(state.risk.level).toBe("none");
    expect(state.visualState).toBe("eating");
  });

  it("los ítems cancelados no cuentan como cocina ni como servido", () => {
    const state = salonVisualStateOf(
      order({
        items: [served(1), { servedAt: null, cancelledAt: ago(5), kitchenStatus: "in_kitchen" }],
      }),
      opts,
    );
    expect(state.visualState).toBe("eating");
  });
});
