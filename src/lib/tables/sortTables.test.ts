import { describe, expect, it } from "vitest";

import type { TableVisualState } from "@/lib/walkoutRisk";
import {
  compareTableIdentity,
  isPhonePaidHighlighted,
  isSalonTableActive,
  mostUrgentVisualState,
  salonRank,
  sortTablesForSalon,
  sortTablesInSalonOrder,
  type SalonSortable,
  type SalonSortOptions,
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

/**
 * "Cuando una mesa acaba de pagar directamente desde el móvil quiero que
 * salga en verde de primera en la lista por los siguientes 3 minutos."
 */
describe("sortTablesForSalon — mesa que acaba de pagar desde el celular", () => {
  const T0 = Date.parse("2026-11-02T20:00:00Z");
  const min = (n: number) => n * 60_000;
  const opts = { now: T0, phonePaidHighlightMinutes: 3 };

  function phonePaid(number: number, paidAgoMin: number): Tile {
    return {
      id: `t${number}`,
      number,
      label: null,
      state: "recently_paid",
      paidAt: new Date(T0 - min(paidAgoMin)).toISOString(),
      paidFromPhone: true,
    };
  }
  function staffPaid(number: number, paidAgoMin: number): Tile {
    return { ...phonePaid(number, paidAgoMin), paidFromPhone: false };
  }

  it("va de primera, antes incluso que una mesa en riesgo de fuga", () => {
    const tiles = [free(1), active(2, "danger"), active(3, "needs_payment"), phonePaid(9, 1)];
    expect(numbers(sortTablesForSalon(tiles, opts))).toEqual([9, 2, 3, 1]);
  });

  it("varias: la más reciente primero; el resto del orden no cambia", () => {
    const tiles = [free(1), phonePaid(4, 2), active(6, "eating"), phonePaid(2, 0.5), free(3)];
    expect(numbers(sortTablesForSalon(tiles, opts))).toEqual([2, 4, 6, 1, 3]);
  });

  it("al vencer los minutos vuelve a su sitio entre las vacías", () => {
    const tiles = [free(5), active(2), phonePaid(9, 3), phonePaid(1, 2.9)];
    expect(numbers(sortTablesForSalon(tiles, opts))).toEqual([1, 2, 5, 9]);
    // Diez segundos después la 1 también venció.
    expect(
      numbers(sortTablesForSalon(tiles, { ...opts, now: T0 + 10_000 })),
    ).toEqual([2, 1, 5, 9]);
  });

  it("una recién pagada que cobró el mesero no sube aunque sea de hace un minuto", () => {
    const tiles = [free(5), active(2), staffPaid(1, 1)];
    expect(numbers(sortTablesForSalon(tiles, opts))).toEqual([2, 1, 5]);
  });

  it("con 0 minutos (apagado) o sin opciones, nadie se adelanta", () => {
    const tiles = [active(2), phonePaid(1, 0)];
    expect(numbers(sortTablesForSalon(tiles, { ...opts, phonePaidHighlightMinutes: 0 }))).toEqual([2, 1]);
    expect(numbers(sortTablesForSalon(tiles))).toEqual([2, 1]);
  });

  it("respeta los minutos del comercio (ventana larga)", () => {
    const tiles = [active(2), phonePaid(1, 12)];
    expect(numbers(sortTablesForSalon(tiles, { ...opts, phonePaidHighlightMinutes: 15 }))).toEqual([1, 2]);
  });

  it("isPhonePaidHighlighted es lo mismo que el grid usa para pintar de verde fuerte", () => {
    expect(isPhonePaidHighlighted(phonePaid(1, 1), opts)).toBe(true);
    expect(isPhonePaidHighlighted(phonePaid(1, 3), opts)).toBe(false);
    expect(isPhonePaidHighlighted(staffPaid(1, 1), opts)).toBe(false);
    expect(isPhonePaidHighlighted(phonePaid(1, 1), undefined)).toBe(false);
    expect(isPhonePaidHighlighted(free(1), opts)).toBe(false);
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

/**
 * "Que no se desaparezcan de su ubicación original para poderlas ver en
 * orden también": la lista completa de la vista de tarjetas usa el orden
 * natural, el sitio de siempre de cada mesa.
 */
describe("sortTablesInSalonOrder", () => {
  it("por número, con las ocupadas en su sitio", () => {
    const tiles = [free(5), active(2, "danger"), free(1), active(9, "needs_payment")];
    expect(numbers(sortTablesInSalonOrder(tiles))).toEqual([1, 2, 5, 9]);
  });

  it("no adelanta a la que acaba de pagar desde el celular", () => {
    const tiles = [
      free(1),
      { id: "t9", number: 9, label: null, state: "recently_paid" as const, paidFromPhone: true, paidAt: new Date() },
      free(3),
    ];
    expect(numbers(sortTablesInSalonOrder(tiles))).toEqual([1, 3, 9]);
  });

  it("de empate por número desempata la etiqueta, como el orden del salón", () => {
    const tiles = [
      active(1, "eating", { label: "Barra 10" }),
      free(1, "Barra 2"),
      free(1, "barra 1"),
    ];
    expect(sortTablesInSalonOrder(tiles).map((t) => t.label)).toEqual([
      "barra 1",
      "Barra 2",
      "Barra 10",
    ]);
  });

  it("no muta la entrada y aguanta la lista vacía", () => {
    const tiles = [free(3), free(1)];
    sortTablesInSalonOrder(tiles);
    expect(numbers(tiles)).toEqual([3, 1]);
    expect(sortTablesInSalonOrder([])).toEqual([]);
  });
});

/** Quién va en la sección «Activas (N)» de arriba. */
describe("isSalonTableActive", () => {
  const T0 = Date.parse("2026-11-24T20:00:00Z");
  const opts: SalonSortOptions = { now: T0, phonePaidHighlightMinutes: 3 };

  it("las de cuenta abierta sí; libres y recién pagadas no", () => {
    expect(isSalonTableActive(active(1))).toBe(true);
    expect(isSalonTableActive(active(2, "danger"))).toBe(true);
    expect(isSalonTableActive(free(3))).toBe(false);
    expect(isSalonTableActive(recentlyPaid(4))).toBe(false);
  });

  it("la que acaba de pagar desde el celular acompaña a las activas mientras dure el resalte", () => {
    const phonePaid: SalonSortable = {
      number: 9,
      label: null,
      state: "recently_paid",
      paidFromPhone: true,
      paidAt: new Date(T0 - 60_000).toISOString(),
    };
    expect(isSalonTableActive(phonePaid, opts)).toBe(true);
    // Vencido el resalte vuelve a ser una recién pagada cualquiera.
    expect(isSalonTableActive(phonePaid, { ...opts, now: T0 + 4 * 60_000 })).toBe(false);
    // Y sin `opts` nadie se adelanta (orden clásico).
    expect(isSalonTableActive(phonePaid)).toBe(false);
  });

  it("marca exactamente a las que sortTablesForSalon adelanta", () => {
    const tiles = [free(1), active(2), free(3), active(4, "needs_payment")];
    const ordered = sortTablesForSalon(tiles);
    const lifted = ordered.filter((t) => isSalonTableActive(t));
    expect(numbers(lifted)).toEqual(numbers(ordered.slice(0, lifted.length)));
    expect(numbers(lifted)).toEqual([4, 2]);
  });
});

/**
 * Con la sección «Activas» plegada no se ven las tarjetas: el encabezado
 * insinúa con el tono de la mesa más urgente. Es el mismo orden de
 * precedencia con el que esa mesa iría de primera.
 */
describe("mostUrgentVisualState", () => {
  it("devuelve el estado de la que iría de primera", () => {
    const tiles = [active(1, "eating"), active(2, "needs_payment"), active(3, "danger")];
    expect(mostUrgentVisualState(tiles)).toBe("danger");
    expect(mostUrgentVisualState(sortTablesForSalon(tiles))).toBe("danger");
  });

  it("respeta la precedencia entre los tres niveles de urgencia", () => {
    expect(mostUrgentVisualState([active(1, "needs_payment"), active(2, "needs_payment_urgent")]))
      .toBe("needs_payment_urgent");
    expect(mostUrgentVisualState([active(1, "eating"), active(2, "needs_payment")]))
      .toBe("needs_payment");
  });

  it("ocupadas sin urgencia no insinúan nada", () => {
    expect(mostUrgentVisualState([active(1, "eating"), active(2, "cooking")])).toBeNull();
    expect(mostUrgentVisualState([active(1, "ready_to_serve")])).toBeNull();
  });

  it("un mesero llamado cuenta como cobro pedido, aunque el estado visual no lo diga", () => {
    expect(mostUrgentVisualState([active(1, "eating", { needsWaiter: true })]))
      .toBe("needs_payment");
  });

  it("libres y recién pagadas no cuentan, ni la del celular", () => {
    const phonePaid: SalonSortable = {
      number: 9,
      label: null,
      state: "recently_paid",
      paidFromPhone: true,
      paidAt: new Date().toISOString(),
    };
    expect(mostUrgentVisualState([free(1), recentlyPaid(2), phonePaid])).toBeNull();
    expect(mostUrgentVisualState([])).toBeNull();
  });
});
