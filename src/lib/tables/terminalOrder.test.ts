import { describe, expect, it } from "vitest";

import type { TableVisualState } from "@/lib/walkoutRisk";
import { sortTablesForSalon } from "./sortTables";
import {
  isTerminalPhonePaidHighlighted,
  sortTablesForTerminal,
  toSalonSortable,
  type TerminalSortable,
  type TerminalTableState,
} from "./terminalOrder";

/**
 * "Ingresé con usuario de datáfono y el orden de las mesas no está bien como
 * lo habíamos puesto para el admin, que las mesas activas están de primero."
 * El datáfono ordena con la regla del salón (sortTablesForSalon): acá se fija
 * la traducción de sus estados y el orden que resulta.
 */

type Card = TerminalSortable & { tableId: string };

function card(
  number: number,
  state: TerminalTableState,
  extra: Partial<Omit<Card, "number" | "state" | "tableId">> = {},
): Card {
  return { tableId: `t${number}`, number, label: null, state, ...extra };
}

/** Cuenta abierta con el estado visual que le calculó el salón. */
function open(
  number: number,
  state: Exclude<TerminalTableState, "free" | "paid">,
  visualState: TableVisualState,
  extra: Partial<Card> = {},
): Card {
  return card(number, state, { visualState, ...extra });
}

const numbers = (cards: readonly Card[]) => cards.map((c) => c.number);

const T0 = Date.parse("2026-11-13T20:00:00Z");
const min = (n: number) => n * 60_000;
const ago = (n: number) => new Date(T0 - min(n)).toISOString();

describe("sortTablesForTerminal", () => {
  it("el caso de la foto: pagada 1, abierta 2, cobrando 3, pagada 4 → abiertas y cobrando primero", () => {
    const cards = [
      card(1, "paid", { paidAt: ago(300) }),
      open(2, "occupied", "eating"),
      open(3, "charging", "needs_payment"),
      card(4, "paid", { paidAt: ago(200) }),
    ];
    expect(numbers(sortTablesForTerminal(cards))).toEqual([3, 2, 1, 4]);
  });

  it("el mismo caso sin estado visual calculado: se deduce del estado del datáfono", () => {
    const cards = [
      card(1, "paid"),
      card(2, "occupied"),
      card(3, "charging"),
      card(4, "paid"),
    ];
    expect(numbers(sortTablesForTerminal(cards))).toEqual([3, 2, 1, 4]);
  });

  it("ninguna pagada ni libre queda por encima de una cuenta abierta", () => {
    const cards = [
      card(1, "free"),
      card(2, "paid"),
      open(3, "occupied", "cooking"),
      card(4, "free"),
      open(5, "partial", "eating"),
      card(6, "paid"),
      open(7, "cash_requested", "needs_payment"),
      open(8, "terminal_requested", "needs_payment"),
      open(9, "charging", "eating"),
    ];
    const sorted = sortTablesForTerminal(cards);
    const firstEmpty = sorted.findIndex((c) => c.state === "free" || c.state === "paid");
    expect(sorted.slice(firstEmpty).every((c) => c.state === "free" || c.state === "paid")).toBe(true);
    // Pidieron cobro (por número) → abiertas sin urgencia (por número) →
    // pagadas y libres mezcladas por número.
    expect(numbers(sorted)).toEqual([7, 8, 3, 5, 9, 1, 2, 4, 6]);
  });

  it("dentro de las abiertas manda la urgencia del salón: fuga → cobro envejecido → cobro pedido → resto", () => {
    const cards = [
      open(1, "occupied", "eating"),
      open(2, "cash_requested", "needs_payment"),
      open(3, "terminal_requested", "needs_payment_urgent"),
      open(4, "occupied", "danger"),
      open(5, "partial", "ready_to_serve"),
      open(6, "occupied", "eating", { needsWaiter: true }),
    ];
    expect(numbers(sortTablesForTerminal(cards))).toEqual([4, 3, 2, 6, 1, 5]);
  });

  it("la mesa que acaba de pagar desde el celular va de primera mientras dure el resalte", () => {
    const cards = [
      open(1, "occupied", "eating"),
      card(2, "paid", { paidAt: ago(1), paidFromPhone: true }),
      open(3, "terminal_requested", "needs_payment"),
      card(4, "paid", { paidAt: ago(1), paidFromPhone: false }),
    ];
    const opts = { now: T0, phonePaidHighlightMinutes: 3 };
    expect(numbers(sortTablesForTerminal(cards, opts))).toEqual([2, 3, 1, 4]);
    expect(isTerminalPhonePaidHighlighted(cards[1], opts)).toBe(true);
    // La cobró alguien del equipo: no sube ni se resalta.
    expect(isTerminalPhonePaidHighlighted(cards[3], opts)).toBe(false);

    // Vencido el resalte (o apagado en el comercio) vuelve a su lugar.
    const later = { now: T0 + min(3), phonePaidHighlightMinutes: 3 };
    expect(numbers(sortTablesForTerminal(cards, later))).toEqual([3, 1, 2, 4]);
    expect(isTerminalPhonePaidHighlighted(cards[1], later)).toBe(false);
    const off = { now: T0, phonePaidHighlightMinutes: 0 };
    expect(numbers(sortTablesForTerminal(cards, off))).toEqual([3, 1, 2, 4]);
    // Sin opciones (orden clásico) tampoco se adelanta.
    expect(numbers(sortTablesForTerminal(cards))).toEqual([3, 1, 2, 4]);
  });

  it("es el MISMO orden que sortTablesForSalon sobre las mesas traducidas", () => {
    const cards = [
      card(12, "free"),
      open(11, "occupied", "eating"),
      card(10, "paid", { paidAt: ago(2), paidFromPhone: true }),
      open(9, "cash_requested", "needs_payment_urgent"),
      card(8, "paid", { paidAt: ago(40) }),
      open(7, "charging", "needs_payment"),
      open(6, "partial", "eating_at_risk"),
      open(5, "occupied", "danger"),
      card(4, "free"),
      open(3, "terminal_requested", "needs_payment"),
      card(2, "paid", { paidAt: ago(1), paidFromPhone: true }),
      open(1, "occupied", "cooking", { needsWaiter: true }),
    ];
    const opts = { now: T0, phonePaidHighlightMinutes: 3 };
    const salon = sortTablesForSalon(cards.map(toSalonSortable), opts);
    expect(numbers(sortTablesForTerminal(cards, opts))).toEqual(
      salon.map((s) => s.number),
    );
    expect(numbers(sortTablesForTerminal(cards, opts))).toEqual([
      2, 10, 5, 9, 1, 3, 7, 6, 11, 4, 8, 12,
    ]);
  });

  it("un refresco con las mismas mesas en otro orden deja la lista igual (sin saltos)", () => {
    const cards = [
      card(1, "paid"),
      open(2, "occupied", "eating"),
      open(3, "charging", "needs_payment"),
      card(4, "paid"),
      card(5, "free"),
      open(6, "cash_requested", "needs_payment"),
    ];
    const expected = [3, 6, 2, 1, 4, 5];
    expect(numbers(sortTablesForTerminal(cards))).toEqual(expected);
    expect(numbers(sortTablesForTerminal([...cards].reverse()))).toEqual(expected);
    expect(
      numbers(sortTablesForTerminal([cards[4], cards[1], cards[5], cards[0], cards[3], cards[2]])),
    ).toEqual(expected);
  });

  it("no muta la entrada y devuelve las mismas tarjetas", () => {
    const cards = [card(2, "paid"), open(1, "occupied", "eating")];
    const snapshot = [...cards];
    const sorted = sortTablesForTerminal(cards);
    expect(cards).toEqual(snapshot);
    expect(sorted[0]).toBe(cards[1]);
    expect(sorted[1]).toBe(cards[0]);
  });
});

describe("toSalonSortable", () => {
  it("libre → free; pagada → recently_paid con su pago", () => {
    expect(toSalonSortable(card(3, "free", { label: "Terraza" }))).toEqual({
      number: 3,
      label: "Terraza",
      state: "free",
    });
    expect(
      toSalonSortable(card(4, "paid", { paidAt: ago(1), paidFromPhone: true })),
    ).toEqual({
      number: 4,
      label: null,
      state: "recently_paid",
      paidAt: ago(1),
      paidFromPhone: true,
    });
  });

  it("toda cuenta abierta es `active`, con el estado visual del salón si viene", () => {
    const states: Exclude<TerminalTableState, "free" | "paid">[] = [
      "occupied",
      "partial",
      "charging",
      "terminal_requested",
      "cash_requested",
    ];
    for (const state of states) {
      expect(toSalonSortable(open(1, state, "danger"))).toMatchObject({
        state: "active",
        visualState: "danger",
      });
    }
  });

  it("sin estado visual: con pago pendiente cuenta como cobro pedido; si no, sin urgencia", () => {
    expect(toSalonSortable(card(1, "terminal_requested")).visualState).toBe("needs_payment");
    expect(toSalonSortable(card(1, "cash_requested")).visualState).toBe("needs_payment");
    expect(toSalonSortable(card(1, "charging")).visualState).toBe("needs_payment");
    expect(toSalonSortable(card(1, "occupied")).visualState).toBe("eating");
    expect(toSalonSortable(card(1, "partial")).visualState).toBe("eating");
  });

  it("el mesero llamado viaja en `order.needsWaiter`", () => {
    expect(toSalonSortable(card(1, "occupied", { needsWaiter: true })).order).toEqual({
      needsWaiter: true,
    });
    expect(toSalonSortable(card(1, "occupied")).order).toEqual({ needsWaiter: false });
  });
});
