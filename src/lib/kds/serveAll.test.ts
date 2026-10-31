import { describe, expect, it, vi } from "vitest";
import {
  buildServeAllRequest,
  canServeAll,
  collectServeAllTargets,
  isServeAllCandidate,
  type ServeAllBoardRound,
  type ServeAllCandidate,
} from "./serveAll";
import { observeItems } from "@/lib/kitchen/newOrderChime";

// staffAccess arrastra la sesión del servidor: se corta acá para poder leer
// la lista de roles de administración y compararla.
vi.mock("@/lib/activeRestaurant", () => ({ getActiveContext: vi.fn() }));
import { OPERATOR_ROLES } from "@/lib/staffAccess";

/**
 * «Servir todo»: lo que el tablero arma para mandar y lo que el servidor
 * acepta. Las páginas de cocina y bar ya filtran las rondas por estación y
 * sub-estación; el tablero sólo junta lo no servido de lo que tiene a la vista.
 */

function round(
  orderId: string,
  tableNumber: number,
  items: Array<[id: string, served?: boolean]>,
  orderType: "dineIn" | "pickup" = "dineIn",
): ServeAllBoardRound {
  return {
    order: { id: orderId, tableNumber, orderType },
    items: items.map(([id, served]) => ({ id, servedAt: served ? "2026-10-31T19:00:00Z" : null })),
  };
}

describe("canServeAll — sólo la administración del comercio", () => {
  it.each(["operator", "group_admin", "platform_admin"])("%s puede", (role) => {
    expect(canServeAll(role)).toBe(true);
  });

  it.each(["kitchen", "bar", "mesero", "terminal", "comercial", "gerente_comercial", "customer", "", null, undefined])(
    "%s no puede",
    (role) => {
      expect(canServeAll(role)).toBe(false);
    },
  );

  it("es exactamente el mismo conjunto que OPERATOR_ROLES (no se separan)", () => {
    const all = ["customer", "operator", "platform_admin", "terminal", "mesero", "kitchen", "bar", "group_admin", "comercial", "gerente_comercial"];
    expect(all.filter(canServeAll).sort()).toEqual([...OPERATOR_ROLES].sort());
  });
});

describe("collectServeAllTargets — lo pendiente que el tablero tiene a la vista", () => {
  it("junta lo no servido, sin repetidos, y cuenta pedidos y mesas", () => {
    const targets = collectServeAllTargets([
      round("o-1", 4, [["a"], ["b", true], ["c"]]),
      // Segunda ronda del mismo pedido / mesa.
      round("o-1", 4, [["d"]]),
      round("o-2", 7, [["e"]]),
      // Ya todo servido: no cuenta la mesa.
      round("o-3", 9, [["f", true]]),
    ]);
    expect(targets).toEqual({ itemIds: ["a", "c", "d", "e"], orderCount: 2, tableCount: 2, hasPickup: false });
  });

  it("deja afuera lo que ya se está sirviendo con un toque individual", () => {
    const targets = collectServeAllTargets([round("o-1", 4, [["a"], ["b"]])], new Set(["b"]));
    expect(targets.itemIds).toEqual(["a"]);
  });

  it("marca si hay pedidos para recoger (se habla de pedidos, no de mesas)", () => {
    const targets = collectServeAllTargets([round("o-1", 4, [["a"]]), round("o-p", -1, [["p"]], "pickup")]);
    expect(targets).toMatchObject({ orderCount: 2, tableCount: 1, hasPickup: true });
  });

  it("sin nada pendiente devuelve la lista vacía (el control no aparece)", () => {
    expect(collectServeAllTargets([round("o-1", 4, [["a", true]])]).itemIds).toEqual([]);
    expect(collectServeAllTargets([]).itemIds).toEqual([]);
  });

  it("servir todo (o revertirlo) no hace sonar el pitido de pedido nuevo", () => {
    const board = [round("o-1", 4, [["a"], ["b"]])];
    const ids = board.flatMap((r) => r.items.map((i) => i.id));
    const seen = observeItems(null, "", ids).seen;
    // Tras servir, el refresco saca los productos del tablero…
    const afterServe = observeItems(seen, "", []);
    expect(afterServe.chime).toBe(false);
    // …y si el servidor falló y vuelven a aparecer, ya estaban vistos.
    expect(observeItems(afterServe.seen, "", ids).chime).toBe(false);
  });
});

describe("buildServeAllRequest — lo que el tablero manda", () => {
  it("el bar manda su sub-estación activa", () => {
    expect(buildServeAllRequest("bar", "Cocteles", ["a", "b"])).toEqual({
      station: "bar",
      barSubStation: "Cocteles",
      itemIds: ["a", "b"],
    });
  });

  it("el bar en «Todo el bar» no manda sub-estación", () => {
    expect(buildServeAllRequest("bar", null, ["a"]).barSubStation).toBeNull();
    expect(buildServeAllRequest("bar", "", ["a"]).barSubStation).toBeNull();
    expect(buildServeAllRequest("bar", undefined, ["a"]).barSubStation).toBeNull();
  });

  it("la cocina nunca manda sub-estación", () => {
    expect(buildServeAllRequest("kitchen", "Cocteles", ["a"])).toEqual({
      station: "kitchen",
      barSubStation: null,
      itemIds: ["a"],
    });
  });

  it("de la lista del tablero al cuerpo: sólo lo pendiente de la sub-estación que se ve", () => {
    // La página del bar ya filtró las rondas a "Cocteles".
    const cocteles = [round("o-1", 4, [["mojito"], ["margarita", true]]), round("o-2", 5, [["negroni"]])];
    const { itemIds } = collectServeAllTargets(cocteles);
    expect(buildServeAllRequest("bar", "Cocteles", itemIds)).toEqual({
      station: "bar",
      barSubStation: "Cocteles",
      itemIds: ["mojito", "negroni"],
    });
  });
});

describe("isServeAllCandidate — lo que el servidor acepta", () => {
  const base: ServeAllCandidate = {
    id: "i",
    orderId: "o",
    roundId: "rd",
    station: "kitchen",
    servedAt: null,
    cancelledAt: null,
    order: { restaurantId: "r-1" },
    round: { status: "in_kitchen" },
    menuItem: { category: { barSubStation: null } },
  };
  const kitchen = { restaurantId: "r-1", station: "kitchen" as const, barSubStation: null };

  it("acepta un pendiente de la estación y del comercio", () => {
    expect(isServeAllCandidate(base, kitchen)).toBe(true);
    for (const status of ["placed", "ready"]) {
      expect(isServeAllCandidate({ ...base, round: { status } }, kitchen)).toBe(true);
    }
  });

  it("rechaza otro comercio, otra estación, servido, cancelado o cortesía", () => {
    expect(isServeAllCandidate({ ...base, order: { restaurantId: "r-2" } }, kitchen)).toBe(false);
    expect(isServeAllCandidate({ ...base, station: "bar" }, kitchen)).toBe(false);
    expect(isServeAllCandidate({ ...base, servedAt: new Date() }, kitchen)).toBe(false);
    expect(isServeAllCandidate({ ...base, cancelledAt: new Date() }, kitchen)).toBe(false);
  });

  it("rechaza lo que no está en una ronda viva del tablero (líneas libres, rondas servidas o canceladas)", () => {
    expect(isServeAllCandidate({ ...base, roundId: null, round: null }, kitchen)).toBe(false);
    expect(isServeAllCandidate({ ...base, round: { status: "served" } }, kitchen)).toBe(false);
    expect(isServeAllCandidate({ ...base, round: { status: "cancelled" } }, kitchen)).toBe(false);
  });

  it("en el bar con sub-estación usa la sub-estación ACTUAL de la categoría", () => {
    const bar = { ...base, station: "bar" };
    const scope = { restaurantId: "r-1", station: "bar" as const, barSubStation: "Cocteles" };
    expect(isServeAllCandidate({ ...bar, menuItem: { category: { barSubStation: "Cocteles" } } }, scope)).toBe(true);
    expect(isServeAllCandidate({ ...bar, menuItem: { category: { barSubStation: "Cafetería" } } }, scope)).toBe(false);
    expect(isServeAllCandidate({ ...bar, menuItem: null }, scope)).toBe(false);
    // Sin sub-estación activa: todo el bar.
    expect(isServeAllCandidate(bar, { ...scope, barSubStation: null })).toBe(true);
  });
});
