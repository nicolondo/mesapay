import { describe, expect, it } from "vitest";

import { terminalChargeState } from "./terminalCharge";

/**
 * «Cobrar» desde la ficha de la mesa del datáfono: cuándo se ofrece y, si
 * no, por qué (los mismos bloqueos que el cobro del staff en el servidor).
 */
const request = (method: string, amountCents: number, tipCents = 0) => ({
  method,
  amountCents,
  tipCents,
  replaceable: true,
});
const flying = (method: string, amountCents: number, tipCents = 0) => ({
  method,
  amountCents,
  tipCents,
  replaceable: false,
});

describe("terminalChargeState", () => {
  it("cuenta abierta sin que nadie pidiera pagar: se puede cobrar", () => {
    expect(terminalChargeState({ paid: false, outstandingCents: 50_000_00, pending: [] })).toEqual({
      canCharge: true,
      block: null,
      inFlight: null,
    });
  });

  it("pagada o sin saldo: nada que cobrar", () => {
    expect(terminalChargeState({ paid: true, outstandingCents: 0, pending: [] }).block).toBe("paid");
    expect(terminalChargeState({ paid: false, outstandingCents: 0, pending: [] })).toMatchObject({
      canCharge: false,
      block: "nothing_outstanding",
    });
  });

  it("una solicitud (efectivo, datáfono propio, datáfono sin enviar) no bloquea", () => {
    const state = terminalChargeState({
      paid: false,
      outstandingCents: 40_000_00,
      pending: [
        request("cash", 40_000_00),
        request("external_terminal", 44_000_00, 4_000_00),
        request("kushki_card_terminal", 44_000_00, 4_000_00),
      ],
    });
    expect(state).toEqual({ canCharge: true, block: null, inFlight: null });
  });

  it("un cobro ya enviado al datáfono por todo el saldo: hay que esperar su resultado", () => {
    expect(
      terminalChargeState({
        paid: false,
        outstandingCents: 40_000_00,
        pending: [flying("kushki_card_terminal", 44_000_00, 4_000_00)],
      }),
    ).toEqual({
      canCharge: false,
      block: "terminal_in_flight",
      inFlight: { kind: "terminal", amountCents: 44_000_00 },
    });
  });

  it("un pago en línea del comensal en curso por todo el saldo: hay que esperar", () => {
    expect(
      terminalChargeState({
        paid: false,
        outstandingCents: 40_000_00,
        pending: [flying("kushki_pse", 40_000_00)],
      }),
    ).toMatchObject({ canCharge: false, block: "online_in_flight", inFlight: { kind: "online" } });
  });

  it("si lo que está en vuelo cubre sólo una parte, se cobra el resto (y se avisa)", () => {
    expect(
      terminalChargeState({
        paid: false,
        outstandingCents: 40_000_00,
        pending: [flying("kushki_card", 11_000_00, 1_000_00)],
      }),
    ).toEqual({
      canCharge: true,
      block: null,
      inFlight: { kind: "online", amountCents: 11_000_00 },
    });
  });

  it("un peso de diferencia por redondeo cuenta como cubierto", () => {
    expect(
      terminalChargeState({
        paid: false,
        outstandingCents: 40_000_01,
        pending: [flying("kushki_card_terminal", 40_000_00)],
      }).block,
    ).toBe("terminal_in_flight");
  });
});
