import { describe, expect, it } from "vitest";

import { resolveOpenDetail, type DetailResolvable } from "./openDetail";

/**
 * La ficha de mesa cuelga de la MESA + LA CUENTA, no de la tarjeta que la
 * abrió. Dos cosas dependen de eso: que una mesa dibujada en varios sitios
 * (sección «Activas», lista completa, dentro o fuera del plano del mapa)
 * no esconda su ficha al cambiar de sitio, y que la ficha no reaparezca
 * sola cuando la mesa abre OTRA cuenta.
 */

type Tile = DetailResolvable & { number: number };

const free = (id: string, number: number): Tile => ({ id, number, state: "free" });
const paid = (id: string, number: number): Tile => ({
  id,
  number,
  state: "recently_paid",
});
const active = (id: string, number: number, orderId: string): Tile => ({
  id,
  number,
  state: "active",
  order: { id: orderId },
});

describe("resolveOpenDetail", () => {
  const tiles = [free("t1", 1), active("t2", 2, "o2"), paid("t3", 3)];

  it("sin selección no hay ficha", () => {
    expect(resolveOpenDetail(null, tiles)).toBeNull();
  });

  it("la mesa con su cuenta viva abre la ficha", () => {
    expect(resolveOpenDetail({ tableId: "t2", orderId: "o2" }, tiles)).toBe(tiles[1]);
  });

  it("no depende de dónde esté dibujada la mesa: la lista es la misma", () => {
    // Mismas mesas en otro orden (la sección «Activas» va antes que la
    // lista completa, y el mapa las reparte entre el plano y «Fuera del
    // mapa»): la ficha abierta es la misma.
    const reordered = [tiles[1], tiles[2], tiles[0]];
    expect(resolveOpenDetail({ tableId: "t2", orderId: "o2" }, reordered)).toBe(tiles[1]);
  });

  it("al terminar la cuenta la ficha se va", () => {
    const afterPaying = [free("t1", 1), paid("t2", 2), paid("t3", 3)];
    expect(resolveOpenDetail({ tableId: "t2", orderId: "o2" }, afterPaying)).toBeNull();
  });

  it("la cuenta SIGUIENTE de esa mesa no revive la ficha", () => {
    const nextParty = [free("t1", 1), active("t2", 2, "o9"), paid("t3", 3)];
    expect(resolveOpenDetail({ tableId: "t2", orderId: "o2" }, nextParty)).toBeNull();
  });

  it("si la mesa desaparece del salón no hay ficha", () => {
    expect(resolveOpenDetail({ tableId: "t2", orderId: "o2" }, [free("t1", 1)])).toBeNull();
  });

  it("una mesa libre o recién pagada nunca abre ficha", () => {
    expect(resolveOpenDetail({ tableId: "t1", orderId: "o1" }, tiles)).toBeNull();
    expect(resolveOpenDetail({ tableId: "t3", orderId: "o3" }, tiles)).toBeNull();
  });
});
