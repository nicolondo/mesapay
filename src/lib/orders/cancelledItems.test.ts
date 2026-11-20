import { describe, expect, it } from "vitest";
import {
  buildCancelledItems,
  cancellationEmails,
  isCancelledLine,
  liveLinesSignature,
  type CancelledItemSourceItem,
  type CancelledItemSourceRound,
} from "./cancelledItems";

const at = (hhmm: string) => new Date(`2026-11-19T${hhmm}:00.000Z`);

function item(overrides: Partial<CancelledItemSourceItem> & { id: string }): CancelledItemSourceItem {
  return {
    roundId: "r1",
    nameSnapshot: `Plato ${overrides.id}`,
    qty: 1,
    priceCentsSnapshot: 1_000_000,
    cancelledAt: null,
    cancelledByEmail: null,
    cancellationReason: null,
    cancellationKind: null,
    ...overrides,
  };
}

function round(overrides: Partial<CancelledItemSourceRound> & { id: string; seq: number }): CancelledItemSourceRound {
  return {
    status: "served",
    cancelledAt: null,
    cancelledByEmail: null,
    cancellationReason: null,
    ...overrides,
  };
}

const staff = [
  { email: "camila@demo.test", name: "Camila" },
  { email: "cocina@demo.test", name: "Cocina" },
  { email: "sin-nombre@demo.test", name: "  " },
];

describe("buildCancelledItems", () => {
  it("lista los platos sueltos y los de una ronda cancelada entera, por hora", () => {
    const rounds = [
      round({ id: "r1", seq: 1 }),
      round({
        id: "r2",
        seq: 2,
        status: "cancelled",
        cancelledAt: at("20:10"),
        cancelledByEmail: "cocina@demo.test",
        cancellationReason: "Ingrediente faltante",
      }),
    ];
    const items = [
      item({ id: "vivo", roundId: "r1" }),
      item({
        id: "suelto",
        roundId: "r1",
        nameSnapshot: "Lomito",
        qty: 2,
        priceCentsSnapshot: 3_200_000,
        cancelledAt: at("20:30"),
        cancelledByEmail: "camila@demo.test",
        cancellationReason: "Cliente cambió de opinión",
        cancellationKind: "cancel",
      }),
      item({ id: "ronda-a", roundId: "r2", nameSnapshot: "Limonada" }),
      item({ id: "ronda-b", roundId: "r2", nameSnapshot: "Patacones", qty: 3, priceCentsSnapshot: 900_000 }),
    ];

    const list = buildCancelledItems({ items, rounds, staff });

    expect(list.map((row) => row.id)).toEqual(["ronda-a", "ronda-b", "suelto"]);
    expect(list[0]).toEqual({
      id: "ronda-a",
      name: "Limonada",
      qty: 1,
      amountCents: 1_000_000,
      cancelledAt: at("20:10").toISOString(),
      kind: "round",
      roundSeq: 2,
      reason: "Ingrediente faltante",
      actor: { type: "staff", name: "Cocina", email: "cocina@demo.test" },
    });
    expect(list[1].amountCents).toBe(2_700_000);
    expect(list[2]).toMatchObject({
      kind: "cancel",
      roundSeq: 1,
      amountCents: 6_400_000,
      cancelledAt: at("20:30").toISOString(),
      reason: "Cliente cambió de opinión",
      actor: { type: "staff", name: "Camila" },
    });
  });

  it("distingue «no cobrado» y trata el tipo vacío (filas viejas) como cancelado", () => {
    const list = buildCancelledItems({
      items: [
        item({ id: "comp", cancelledAt: at("21:00"), cancellationKind: "comp", cancelledByEmail: "camila@demo.test" }),
        item({ id: "viejo", cancelledAt: at("20:00"), cancellationKind: null, cancelledByEmail: "camila@demo.test" }),
      ],
      rounds: [round({ id: "r1", seq: 1 })],
      staff,
    });
    expect(list.map((row) => [row.id, row.kind])).toEqual([["viejo", "cancel"], ["comp", "comp"]]);
  });

  it("vale la cancelación que pasó primero entre la del plato y la de su ronda", () => {
    const rounds = [
      // Ronda cancelada a las 20:00; a las 21:00 se canceló la cuenta completa,
      // que estampa también los platos de esta ronda.
      round({ id: "r1", seq: 1, status: "cancelled", cancelledAt: at("20:00"), cancelledByEmail: "cocina@demo.test", cancellationReason: "Sin gas" }),
      // Se canceló el último plato vivo de la ronda: la ronda queda estampada
      // con la misma hora y es el plato el que manda.
      round({ id: "r2", seq: 2, status: "cancelled", cancelledAt: at("20:45"), cancelledByEmail: "camila@demo.test", cancellationReason: "Demora excesiva" }),
    ];
    const list = buildCancelledItems({
      items: [
        item({ id: "a", roundId: "r1", cancelledAt: at("21:00"), cancelledByEmail: "camila@demo.test", cancellationReason: "Orden completa cancelada", cancellationKind: "cancel" }),
        item({ id: "b", roundId: "r2", cancelledAt: at("20:45"), cancelledByEmail: "camila@demo.test", cancellationReason: "Demora excesiva", cancellationKind: "comp" }),
      ],
      rounds,
      staff,
    });
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ id: "a", kind: "round", cancelledAt: at("20:00").toISOString(), reason: "Sin gas", actor: { type: "staff", name: "Cocina" } });
    expect(list[1]).toMatchObject({ id: "b", kind: "comp", cancelledAt: at("20:45").toISOString() });
  });

  it("resuelve el nombre por correo y cae al correo cuando no puede", () => {
    const list = buildCancelledItems({
      items: [
        item({ id: "1", cancelledAt: at("20:01"), cancelledByEmail: " Camila@Demo.test " }),
        item({ id: "2", cancelledAt: at("20:02"), cancelledByEmail: "sin-nombre@demo.test" }),
        item({ id: "3", cancelledAt: at("20:03"), cancelledByEmail: "otro-comercio@demo.test" }),
        item({ id: "4", cancelledAt: at("20:04"), cancelledByEmail: null }),
        item({ id: "5", cancelledAt: at("20:05"), cancelledByEmail: "   " }),
      ],
      rounds: [round({ id: "r1", seq: 1 })],
      staff,
    });
    expect(list.map((row) => row.actor)).toEqual([
      { type: "staff", name: "Camila", email: "Camila@Demo.test" },
      { type: "email", email: "sin-nombre@demo.test" },
      { type: "email", email: "otro-comercio@demo.test" },
      { type: "unknown" },
      { type: "unknown" },
    ]);
  });

  it("incluye los cargos sin ronda y deja al final lo que no tiene hora", () => {
    const list = buildCancelledItems({
      items: [
        item({ id: "sin-hora", roundId: "r9" }),
        item({ id: "cargo", roundId: null, nameSnapshot: "Alquiler del salón", cancelledAt: at("19:00"), cancellationReason: "  " }),
      ],
      rounds: [round({ id: "r9", seq: 9, status: "cancelled", cancelledAt: null })],
      staff: [],
    });
    expect(list.map((row) => [row.id, row.roundSeq, row.cancelledAt])).toEqual([
      ["cargo", null, at("19:00").toISOString()],
      ["sin-hora", 9, null],
    ]);
    expect(list[0].reason).toBeNull();
  });

  it("nada de lo cancelado suma al total: vivos y cancelados se reparten sin cruzarse", () => {
    const rounds = [
      round({ id: "r1", seq: 1 }),
      round({ id: "r2", seq: 2, status: "cancelled", cancelledAt: at("20:10") }),
    ];
    const roundsById = new Map(rounds.map((r) => [r.id, r]));
    const items = [
      item({ id: "vivo-1", roundId: "r1", priceCentsSnapshot: 2_000_000 }),
      item({ id: "vivo-2", roundId: "r1", qty: 2, priceCentsSnapshot: 500_000 }),
      item({ id: "suelto", roundId: "r1", priceCentsSnapshot: 4_000_000, cancelledAt: at("20:20") }),
      item({ id: "de-ronda", roundId: "r2", priceCentsSnapshot: 8_000_000 }),
    ];
    const live = items.filter((i) => !isCancelledLine(i, i.roundId ? roundsById.get(i.roundId) : null));
    const liveTotal = live.reduce((sum, i) => sum + i.priceCentsSnapshot * i.qty, 0);
    const cancelled = buildCancelledItems({ items, rounds, staff: [] });

    expect(liveTotal).toBe(3_000_000);
    expect(cancelled.map((row) => row.id).sort()).toEqual(["de-ronda", "suelto"]);
    expect(live.map((i) => i.id).some((id) => cancelled.some((row) => row.id === id))).toBe(false);
    expect(live.length + cancelled.length).toBe(items.length);
  });

  it("sin platos cancelados devuelve una lista vacía", () => {
    expect(
      buildCancelledItems({ items: [item({ id: "vivo" })], rounds: [round({ id: "r1", seq: 1 })], staff }),
    ).toEqual([]);
  });
});

describe("cancellationEmails", () => {
  it("junta los correos de platos y rondas canceladas sin repetir", () => {
    expect(
      cancellationEmails(
        [{ cancelledByEmail: "camila@demo.test" }, { cancelledByEmail: "CAMILA@demo.test" }, { cancelledByEmail: null }],
        [
          { status: "cancelled", cancelledByEmail: " cocina@demo.test " },
          // Una ronda viva no aporta correo aunque tuviera uno viejo.
          { status: "served", cancelledByEmail: "nadie@demo.test" },
        ],
      ),
    ).toEqual(["camila@demo.test", "cocina@demo.test"]);
  });
});

describe("liveLinesSignature", () => {
  const rounds = [{ id: "r1", status: "placed", items: [{ id: "a" }, { id: "b" }] }];
  it("cambia cuando un plato sale de la ficha o cambia el estado de su ronda", () => {
    const base = liveLinesSignature(rounds, [{ id: "l1" }]);
    expect(liveLinesSignature([{ ...rounds[0], items: [{ id: "a" }] }], [{ id: "l1" }])).not.toBe(base);
    expect(liveLinesSignature([{ ...rounds[0], status: "cancelled" }], [{ id: "l1" }])).not.toBe(base);
    expect(liveLinesSignature(rounds, [])).not.toBe(base);
    expect(liveLinesSignature(structuredClone(rounds), [{ id: "l1" }])).toBe(base);
  });
});
