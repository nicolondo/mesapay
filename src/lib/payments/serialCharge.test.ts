import { describe, expect, it } from "vitest";
import {
  createSerialPlan,
  parseSerialPlan,
  reconcileSerialPlan,
  serialEqualPartCents,
  serialRemainingParts,
  withApprovedNow,
  withChargeLaunched,
  withSplitCount,
  type SerialPlan,
} from "./serialCharge";

const approved = (id: string, amountCents = 10_000, tipCents = 0) => ({
  id,
  amountCents,
  tipCents,
});

describe("serialEqualPartCents", () => {
  it("divide el saldo real entre las partes que faltan", () => {
    // $100.000 entre 4 → $25.000 la primera.
    expect(serialEqualPartCents(10_000_000, 4, 0)).toBe(2_500_000);
    // Cobrada 1 de 4, el saldo (3 partes) se divide entre 3, no entre 4.
    expect(serialEqualPartCents(7_500_000, 4, 1)).toBe(2_500_000);
  });

  it("la última parte cobra EXACTO el saldo (sin dejar $1 por redondeo)", () => {
    // $100.001 entre 3: 33.334 + 33.334 → la última se lleva 33.333 exactos.
    const total = 10_000_100;
    const p1 = serialEqualPartCents(total, 3, 0);
    const p2 = serialEqualPartCents(total - p1, 3, 1);
    const p3 = serialEqualPartCents(total - p1 - p2, 3, 2);
    expect(p1 + p2 + p3).toBe(total);
    expect(p3).toBe(total - p1 - p2);
  });

  it("las partes van al peso entero (el datáfono cobra pesos enteros)", () => {
    // $100.000 entre 3: $33.333 + $33.333 y la última $33.334 exacta.
    const total = 10_000_000;
    const p1 = serialEqualPartCents(total, 3, 0);
    expect(p1 % 100).toBe(0);
    const p2 = serialEqualPartCents(total - p1, 3, 1);
    expect(p2 % 100).toBe(0);
    const p3 = serialEqualPartCents(total - p1 - p2, 3, 2);
    expect(p1 + p2 + p3).toBe(total);
  });

  it("si el saldo cambió (otro pagó a la vez), las partes se ajustan solas", () => {
    // Plan de 2; antes de cobrar la parte 1, un comensal abonó $40.000 desde
    // su celular: la parte sale del saldo real.
    expect(serialEqualPartCents(6_000_000, 2, 0)).toBe(3_000_000);
    // Y la última parte del plan se lleva el resto exacto.
    expect(serialEqualPartCents(2_345_601, 2, 1)).toBe(2_345_601);
  });

  it("nunca cobra más que el saldo ni acepta partes imposibles", () => {
    expect(serialEqualPartCents(100, 20, 19)).toBe(100);
    expect(serialEqualPartCents(0, 4, 2)).toBe(0);
    expect(serialEqualPartCents(-50, 4, 0)).toBe(0);
  });
});

describe("reconcileSerialPlan", () => {
  const base = (): SerialPlan =>
    withChargeLaunched(createSerialPlan("equal", 4, ["previo"]), {
      paymentId: "p1",
      method: "kushki_card_terminal",
    });

  it("la parte en vuelo aprobada avanza el plan y recuerda el método", () => {
    const { plan, events } = reconcileSerialPlan(
      base(),
      [approved("previo"), approved("p1", 2_500_000)],
      [],
    );
    expect(plan.partsDone).toBe(1);
    expect(plan.inFlight).toBeNull();
    expect(plan.lastMethod).toBe("kushki_card_terminal");
    expect(events).toEqual([
      {
        kind: "approved",
        partIndex: 1,
        splitCount: 4,
        guest: null,
        amountCents: 2_500_000,
        method: "kushki_card_terminal",
      },
    ]);
    // Lo ya contado no vuelve a disparar eventos.
    const again = reconcileSerialPlan(plan, [approved("previo"), approved("p1")], []);
    expect(again.plan).toBe(plan);
    expect(again.events).toEqual([]);
  });

  it("en vuelo que no está ni aprobado ni pendiente = rechazo: la parte queda para reintentar", () => {
    const { plan, events } = reconcileSerialPlan(base(), [approved("previo")], []);
    expect(plan.partsDone).toBe(0);
    expect(plan.inFlight).toBeNull();
    // El método queda recordado para «Reintentar» con un toque.
    expect(plan.lastMethod).toBe("kushki_card_terminal");
    expect(events).toEqual([
      { kind: "declined", method: "kushki_card_terminal", guest: null },
    ]);
  });

  it("en vuelo todavía pendiente (incluido sin confirmar): se sigue esperando, sin eventos", () => {
    const { plan, events } = reconcileSerialPlan(base(), [approved("previo")], ["p1"]);
    expect(plan.inFlight?.paymentId).toBe("p1");
    expect(events).toEqual([]);
  });

  it("un pago ajeno (otro pagó a la vez) ajusta y avisa discreto, sin consumir partes", () => {
    const { plan, events } = reconcileSerialPlan(
      base(),
      [approved("previo"), approved("ajeno", 4_000_000)],
      ["p1"],
    );
    expect(plan.partsDone).toBe(0);
    expect(plan.accountedPaymentIds).toContain("ajeno");
    expect(events).toEqual([{ kind: "balance_changed", amountCents: 4_000_000 }]);
  });

  it("aprobado nuestro + pago ajeno en el mismo refresh: el avance manda", () => {
    const { plan, events } = reconcileSerialPlan(
      base(),
      [approved("previo"), approved("p1", 2_500_000), approved("ajeno", 1_000_000)],
      [],
    );
    expect(plan.partsDone).toBe(1);
    expect(events[0].kind).toBe("approved");
    expect(events[1]).toEqual({ kind: "balance_changed", amountCents: 1_000_000 });
  });

  it("modo individual: el aprobado marca pagado al comensal", () => {
    const launched = withChargeLaunched(createSerialPlan("mine", 2, []), {
      paymentId: "p9",
      method: "cash",
      guest: "Ana",
    });
    const { plan, events } = reconcileSerialPlan(launched, [approved("p9")], []);
    expect(plan.guestsPaid).toEqual(["Ana"]);
    expect(events[0]).toMatchObject({ kind: "approved", guest: "Ana" });
  });
});

describe("withApprovedNow (efectivo del staff, Bre-B a la vista)", () => {
  it("avanza en el acto y la reconciliación no lo cuenta dos veces", () => {
    const plan0 = createSerialPlan("equal", 2, []);
    const { plan, event } = withApprovedNow(plan0, {
      paymentId: "cash1",
      method: "cash",
      amountCents: 5_000_000,
    });
    expect(plan.partsDone).toBe(1);
    expect(event).toMatchObject({ kind: "approved", partIndex: 1, splitCount: 2 });
    const again = reconcileSerialPlan(plan, [approved("cash1")], []);
    expect(again.events).toEqual([]);
  });
});

describe("withSplitCount / serialRemainingParts", () => {
  it("no deja menos partes que las ya cobradas + 1", () => {
    const plan = {
      ...createSerialPlan("equal", 4, []),
      partsDone: 3,
    };
    expect(withSplitCount(plan, 2).splitCount).toBe(4);
    expect(withSplitCount(plan, 6).splitCount).toBe(6);
    expect(serialRemainingParts(plan)).toBe(1);
  });
});

describe("parseSerialPlan", () => {
  it("restaura un plan guardado tal cual", () => {
    const plan = withChargeLaunched(createSerialPlan("equal", 3, ["a"]), {
      paymentId: "p1",
      method: "external_terminal",
    });
    expect(parseSerialPlan(JSON.stringify(plan))).toEqual(plan);
  });

  it("rechaza basura, versiones raras y números imposibles", () => {
    expect(parseSerialPlan(null)).toBeNull();
    expect(parseSerialPlan("")).toBeNull();
    expect(parseSerialPlan("{no json")).toBeNull();
    expect(parseSerialPlan(JSON.stringify({ mode: "total" }))).toBeNull();
    expect(parseSerialPlan(JSON.stringify({ mode: "equal", splitCount: 1, partsDone: 0 }))).toBeNull();
    expect(parseSerialPlan(JSON.stringify({ mode: "equal", splitCount: 4, partsDone: 5 }))).toBeNull();
    expect(
      parseSerialPlan(
        JSON.stringify({ mode: "equal", splitCount: 4, partsDone: 1, inFlight: { paymentId: 7, method: "cash" } }),
      ),
    ).toMatchObject({ inFlight: null });
  });
});
