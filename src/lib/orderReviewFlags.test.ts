// «Revisar esta cuenta»: las tres señales, el caso del incidente y que una
// cuenta normal no avisa nada.
import { describe, expect, it } from "vitest";
import { LONG_IDLE_REOPEN_MS, orderReviewFlags, type ReviewFlagsInput } from "./orderReviewFlags";

const at = (hhmm: string) => new Date(`2026-11-18T${hhmm}:00-05:00`);

const base: ReviewFlagsInput = {
  status: "placed",
  tableNumber: 7,
  tableKind: "standard",
  discountCents: 0,
  discountPct: null,
  discountBillingCustomerId: null,
  discountAppliedAt: null,
  reviewAckAt: null,
  rounds: [],
  payments: [],
};

const kinds = (input: ReviewFlagsInput, opts?: { newRoundAt?: Date }) =>
  orderReviewFlags(input, opts).map((f) => f.kind);

describe("orderReviewFlags — el incidente", () => {
  // Ronda 1 → paso «Cliente» con 20 % → datáfono rechazado → cobro
  // abandonado → rondas canceladas → horas después, rondas nuevas.
  const incident: ReviewFlagsInput = {
    ...base,
    discountCents: 12_000,
    discountPct: 20,
    discountBillingCustomerId: "cust-1",
    discountAppliedAt: at("13:20"),
    rounds: [
      { placedAt: at("13:00"), status: "cancelled" },
      { placedAt: at("18:30"), status: "placed" },
      { placedAt: at("19:10"), status: "placed" },
    ],
    payments: [{ status: "declined", createdAt: at("13:21") }],
  };

  it("salta con las tres señales, cada una desde la ronda que la disparó", () => {
    expect(orderReviewFlags(incident)).toEqual([
      { kind: "stale_customer_discount", since: at("18:30") },
      { kind: "failed_charge_still_open", since: at("18:30") },
      { kind: "long_idle_reopened", since: at("18:30") },
    ]);
  });

  it("ANTES de montar la primera ronda nueva, el aviso al personal ya sale (newRoundAt)", () => {
    const beforeNewRounds = { ...incident, rounds: [{ placedAt: at("13:00"), status: "cancelled" }] };
    expect(kinds(beforeNewRounds)).toEqual([]);
    expect(kinds(beforeNewRounds, { newRoundAt: at("18:30") })).toEqual([
      "stale_customer_discount",
      "failed_charge_still_open",
      "long_idle_reopened",
    ]);
  });

  it("«Mantener» apaga las señales nacidas hasta ese instante", () => {
    expect(kinds({ ...incident, reviewAckAt: at("18:31") })).toEqual([]);
  });

  it("una señal NUEVA después del «Mantener» vuelve a avisar", () => {
    const later = {
      ...incident,
      reviewAckAt: at("18:31"),
      rounds: [...incident.rounds, { placedAt: at("21:40"), status: "placed" }],
    };
    expect(kinds(later)).toEqual(["long_idle_reopened"]);
  });

  it("quitar el descuento resuelve la señal 1 (sin origen ya no hay nada que revisar)", () => {
    expect(kinds({ ...incident, discountCents: 0, discountPct: null, discountBillingCustomerId: null, discountAppliedAt: null }))
      .toEqual(["failed_charge_still_open", "long_idle_reopened"]);
  });
});

describe("orderReviewFlags — cada señal por separado", () => {
  it("1. descuento de cliente con una ronda montada DESPUÉS de aplicarlo", () => {
    const input = {
      ...base,
      discountCents: 5_000,
      discountPct: 10,
      discountBillingCustomerId: "cust-1",
      discountAppliedAt: at("20:00"),
      rounds: [{ placedAt: at("19:30"), status: "served" }],
    };
    expect(kinds(input)).toEqual([]);
    expect(kinds({ ...input, rounds: [...input.rounds, { placedAt: at("20:05"), status: "placed" }] }))
      .toEqual(["stale_customer_discount"]);
    // Una ronda cancelada después no cuenta.
    expect(kinds({ ...input, rounds: [...input.rounds, { placedAt: at("20:05"), status: "cancelled" }] })).toEqual([]);
  });

  it("1. el descuento del comensal (sin origen de cliente) nunca avisa", () => {
    expect(kinds({
      ...base,
      discountCents: 5_000,
      discountPct: 10,
      rounds: [{ placedAt: at("19:30"), status: "served" }, { placedAt: at("20:05"), status: "placed" }],
    })).toEqual([]);
  });

  it("2. cobro rechazado + ronda nueva después; con un pago aprobado no", () => {
    const input = {
      ...base,
      rounds: [{ placedAt: at("19:30"), status: "served" }, { placedAt: at("20:10"), status: "placed" }],
      payments: [{ status: "declined", createdAt: at("20:00") }],
    };
    expect(kinds(input)).toEqual(["failed_charge_still_open"]);
    expect(kinds({ ...input, payments: [...input.payments, { status: "approved", createdAt: at("20:01") }] })).toEqual([]);
    // Rechazo SIN rondas después: nada (el personal sigue cobrando).
    expect(kinds({ ...input, rounds: [input.rounds[0]] })).toEqual([]);
  });

  it("3. ronda tras ≥ 2 h sin rondas activas; un hueco menor no", () => {
    const input = {
      ...base,
      rounds: [
        { placedAt: at("12:00"), status: "served" },
        { placedAt: new Date(at("12:00").getTime() + LONG_IDLE_REOPEN_MS - 60_000), status: "placed" },
      ],
    };
    expect(kinds(input)).toEqual([]);
    expect(kinds({ ...input, rounds: [input.rounds[0], { placedAt: new Date(at("12:00").getTime() + LONG_IDLE_REOPEN_MS), status: "placed" }] }))
      .toEqual(["long_idle_reopened"]);
  });

  it("3. si todas las rondas anteriores están canceladas, cuenta desde la primera", () => {
    const rounds = [
      { placedAt: at("12:00"), status: "cancelled" },
      { placedAt: at("13:55"), status: "cancelled" },
    ];
    expect(kinds({ ...base, rounds: [...rounds, { placedAt: at("14:30"), status: "placed" }] })).toEqual(["long_idle_reopened"]);
    // Cancelar y volver a pedir enseguida no es «otro grupo».
    expect(kinds({ ...base, rounds: [{ placedAt: at("14:00"), status: "cancelled" }, { placedAt: at("14:05"), status: "placed" }] }))
      .toEqual([]);
  });
});

describe("orderReviewFlags — no salta donde no debe", () => {
  const busy: ReviewFlagsInput = {
    ...base,
    rounds: [
      { placedAt: at("19:00"), status: "served" },
      { placedAt: at("19:40"), status: "served" },
      { placedAt: at("20:30"), status: "placed" },
    ],
  };

  it("una cuenta normal (rondas seguidas, sin rechazos ni descuento de cliente) no avisa", () => {
    expect(kinds(busy)).toEqual([]);
    expect(kinds(busy, { newRoundAt: at("21:00") })).toEqual([]);
  });

  it("primera ronda de una cuenta nueva: nada que comparar", () => {
    expect(kinds(base, { newRoundAt: at("21:00") })).toEqual([]);
  });

  it("cuentas pagadas o canceladas, pickup y facturas manuales quedan fuera", () => {
    const incidentLike = { ...busy, rounds: [{ placedAt: at("12:00"), status: "served" }, { placedAt: at("18:00"), status: "placed" }] };
    expect(kinds(incidentLike)).toEqual(["long_idle_reopened"]);
    expect(kinds({ ...incidentLike, status: "paid" })).toEqual([]);
    expect(kinds({ ...incidentLike, status: "cancelled" })).toEqual([]);
    expect(kinds({ ...incidentLike, tableNumber: -1 })).toEqual([]);
    expect(kinds({ ...incidentLike, tableKind: "manual" })).toEqual([]);
    expect(kinds({ ...incidentLike, tableKind: "pickup" })).toEqual([]);
  });
});
