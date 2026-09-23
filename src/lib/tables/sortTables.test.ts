import { describe, expect, it } from "vitest";

import type { TableVisualState } from "@/lib/walkoutRisk";
import {
  compareTableIdentity,
  salonRank,
  sortTablesForSalon,
  type SalonSortable,
} from "./sortTables";

/**
 * "Que salgan de primero las mesas que están activas y después en orden
 * las que están vacías." Activa = cuenta abierta (state "active"); dentro
 * de las activas, las que piden acción (cuenta pedida / mesero llamado /
 * riesgo de fuga) antes que las simplemente ocupadas.
 */

type Tile = SalonSortable & { id: string };

function free(number: number, label: string | null = null): Tile {
  return { id: `t${number}`, number, label, state: "free" };
}

function recentlyPaid(number: number): Tile {
  return { id: `t${number}`, number, label: null, state: "recently_paid" };
}

function active(
  number: number,
  visualState: TableVisualState = "eating",
  extra: { needsWaiter?: boolean; label?: string | null } = {},
): Tile {
  return {
    id: `t${number}`,
    number,
    label: extra.label ?? null,
    state: "active",
    visualState,
    order: { needsWaiter: extra.needsWaiter ?? false },
  };
}

const numbers = (tiles: readonly Tile[]) => tiles.map((t) => t.number);

describe("sortTablesForSalon", () => {
  it("mesas 1..12 con la 3 y la 7 activas → [3, 7, 1, 2, 4, …, 12]", () => {
    const tiles = Array.from({ length: 12 }, (_, i) => {
      const n = i + 1;
      return n === 3 || n === 7 ? active(n) : free(n);
    });
    expect(numbers(sortTablesForSalon(tiles))).toEqual([
      3, 7, 1, 2, 4, 5, 6, 8, 9, 10, 11, 12,
    ]);
  });

  it("no importa el orden de entrada: las activas suben y cada grupo queda por número", () => {
    const tiles = [free(9), active(4), free(1), active(12), free(5)];
    expect(numbers(sortTablesForSalon(tiles))).toEqual([4, 12, 1, 5, 9]);
  });

  it("una mesa con la cuenta pedida va antes que una simplemente ocupada", () => {
    const tiles = [
      active(2, "cooking"),
      active(5, "eating"),
      active(9, "needs_payment"),
      active(11, "ready_to_serve"),
    ];
    expect(numbers(sortTablesForSalon(tiles))).toEqual([9, 2, 5, 11]);
  });

  it("dentro de las urgentes: fuga > cuenta pedida envejecida > cuenta pedida", () => {
    const tiles = [
      active(1, "needs_payment"),
      active(2, "needs_payment_urgent"),
      active(3, "danger"),
      active(4, "eating_at_risk"),
    ];
    expect(numbers(sortTablesForSalon(tiles))).toEqual([3, 2, 1, 4]);
  });

  it("mesero llamado cuenta como pedido pendiente aunque el estado visual no lo diga", () => {
    const tiles = [
      active(1, "eating"),
      active(2, "eating", { needsWaiter: true }),
      active(3, "needs_payment"),
    ];
    // 2 (mesero llamado) empata en grupo con 3 (cuenta pedida) → por número.
    expect(numbers(sortTablesForSalon(tiles))).toEqual([2, 3, 1]);
  });

  it("las vacías van en orden numérico, recién pagadas incluidas", () => {
    const tiles = [free(10), recentlyPaid(2), free(1), recentlyPaid(7), free(3)];
    expect(numbers(sortTablesForSalon(tiles))).toEqual([1, 2, 3, 7, 10]);
  });

  it("el número manda sobre la etiqueta: 'Terraza' 12 va después de 'Barra' 3", () => {
    const tiles = [
      free(12, "Terraza"),
      free(3, "Barra"),
      active(8, "eating", { label: "Patio" }),
    ];
    expect(sortTablesForSalon(tiles).map((t) => t.label)).toEqual([
      "Patio",
      "Barra",
      "Terraza",
    ]);
  });

  it("no muta la lista de entrada", () => {
    const tiles = [free(2), active(1)];
    const copy = [...tiles];
    sortTablesForSalon(tiles);
    expect(tiles).toEqual(copy);
  });

  it("lista vacía → lista vacía", () => {
    expect(sortTablesForSalon([])).toEqual([]);
  });
});

describe("compareTableIdentity", () => {
  it("con el mismo número, las etiquetas se ordenan en alfabético natural", () => {
    const tiles = [
      free(1, "Barra 10"),
      free(1, "Barra 2"),
      free(1, "barra 1"),
      free(1, null),
    ];
    expect([...tiles].sort(compareTableIdentity).map((t) => t.label)).toEqual([
      null,
      "barra 1",
      "Barra 2",
      "Barra 10",
    ]);
  });
});

describe("salonRank", () => {
  it("libre y recién pagada comparten el último grupo", () => {
    expect(salonRank(free(1))).toBe(salonRank(recentlyPaid(2)));
    expect(salonRank(free(1))).toBeGreaterThan(salonRank(active(3)));
  });

  it("una activa sin estado visual es 'ocupada' a secas", () => {
    const t: SalonSortable = { number: 1, state: "active" };
    expect(salonRank(t)).toBe(salonRank(active(2, "eating")));
    expect(salonRank(t)).toBeGreaterThan(salonRank(active(3, "needs_payment")));
  });
});
