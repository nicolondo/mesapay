import { describe, it, expect } from "vitest";
import { buildCustomerRows, customerListWheres } from "./customerLink";

const users = [
  { id: "u_marcela", name: "Marcela Hincapié", email: "m@x.com", cedula: "1037614518" },
  { id: "u_ana", name: "Ana", email: "ana@x.com", cedula: null },
  { id: "u_beto", name: "Beto", email: "beto@x.com", cedula: null },
  { id: "u_carlos", name: null, email: "carlos@x.com", cedula: null },
];

describe("customerListWheres", () => {
  it("SIEMPRE filtra por restaurante en las TRES consultas", () => {
    // Este test es el guardarraíl del aislamiento entre restaurantes. La
    // cuenta del comensal es global (un correo = una persona en toda la
    // plataforma), así que si a cualquiera de estos where se le cayera el
    // restaurantId, el restaurante A vería comensales del B. Si alguien lo
    // quita, esto falla.
    const w = customerListWheres("rest_A");
    expect(w.paidOrders.restaurantId).toBe("rest_A");
    expect(w.discounts.restaurantId).toBe("rest_A");
    expect(w.links.restaurantId).toBe("rest_A");
    expect(Object.keys(w.paidOrders)).toContain("restaurantId");
    expect(Object.keys(w.discounts)).toContain("restaurantId");
    expect(Object.keys(w.links)).toContain("restaurantId");
  });

  it("el consumo que se suma es solo el facturado", () => {
    // El total de la lista es plata cobrada. Una cuenta abierta todavía no
    // es consumo y no puede inflar el ranking.
    const w = customerListWheres("rest_A");
    expect(w.paidOrders.status).toBe("paid");
    expect(w.paidOrders.customerId).toEqual({ not: null });
  });
});

describe("buildCustomerRows", () => {
  it("lista al comensal que se registró aquí aunque no haya pedido nada", () => {
    // El caso que motivó el feature: cuenta creada desde la carta del
    // restaurante, cero pedidos. Antes no aparecía y no se le podía
    // habilitar un descuento sin saberse la cédula de memoria.
    const rows = buildCustomerRows({
      users,
      spend: [],
      discounts: [],
      links: [{ userId: "u_marcela", source: "signup" }],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("u_marcela");
    expect(rows[0].orders).toBe(0);
    expect(rows[0].totalCents).toBe(0);
    expect(rows[0].origins).toEqual(["signup"]);
  });

  it("lista al que el operador agregó a mano", () => {
    const rows = buildCustomerRows({
      users,
      spend: [],
      discounts: [],
      links: [{ userId: "u_marcela", source: "added" }],
    });
    expect(rows[0].origins).toEqual(["added"]);
  });

  it("lista al que solo tiene un descuento pactado", () => {
    // Darle un descuento también vincula: es lo que el operador va a hacer
    // al final de todos modos.
    const rows = buildCustomerRows({
      users,
      spend: [],
      discounts: [{ userId: "u_ana", percent: 15, active: true }],
      links: [],
    });
    expect(rows[0].id).toBe("u_ana");
    expect(rows[0].discountPct).toBe(15);
    expect(rows[0].origins).toEqual(["discount"]);
  });

  it("un descuento apagado sigue siendo vínculo pero no muestra porcentaje", () => {
    const rows = buildCustomerRows({
      users,
      spend: [],
      discounts: [{ userId: "u_ana", percent: 15, active: false }],
      links: [],
    });
    expect(rows[0].origins).toEqual(["discount"]);
    expect(rows[0].discountPct).toBeNull();
  });

  it("no duplica a quien llega por varios orígenes a la vez", () => {
    const rows = buildCustomerRows({
      users,
      spend: [{ userId: "u_ana", orders: 3, totalCents: 90_000 }],
      discounts: [{ userId: "u_ana", percent: 10, active: true }],
      links: [{ userId: "u_ana", source: "added" }],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].origins).toEqual(["orders", "discount", "added"]);
    expect(rows[0].orders).toBe(3);
    expect(rows[0].discountPct).toBe(10);
  });

  it("ordena por consumo y deja al final, por nombre, a los que no han pedido", () => {
    const rows = buildCustomerRows({
      users,
      spend: [
        { userId: "u_beto", orders: 1, totalCents: 20_000 },
        { userId: "u_ana", orders: 2, totalCents: 80_000 },
      ],
      discounts: [],
      links: [
        { userId: "u_marcela", source: "signup" },
        { userId: "u_carlos", source: "added" },
      ],
    });
    // Ana (80k) → Beto (20k) → los de total 0 por nombre: Carlos (sin
    // nombre, cae al correo) antes que Marcela.
    expect(rows.map((r) => r.id)).toEqual([
      "u_ana",
      "u_beto",
      "u_carlos",
      "u_marcela",
    ]);
  });

  it("no lista a un comensal que no tiene ningún vínculo con el restaurante", () => {
    // El aislamiento entre restaurantes se sostiene acá: `users` es solo el
    // lote de identidades para pintar las filas — quién ENTRA lo deciden
    // los tres orígenes, y esos ya vienen filtrados por restaurante. Si
    // esta función listara a `users`, cada restaurante vería la base de
    // comensales de los demás.
    const rows = buildCustomerRows({
      users, // cuatro comensales de la plataforma…
      spend: [{ userId: "u_ana", orders: 1, totalCents: 10_000 }],
      discounts: [],
      links: [],
    });
    // …y solo entra el que consumió en ESTE restaurante.
    expect(rows.map((r) => r.id)).toEqual(["u_ana"]);
  });

  it("omite al comensal sin identidad en vez de pintar una fila fantasma", () => {
    const rows = buildCustomerRows({
      users,
      spend: [],
      discounts: [],
      links: [{ userId: "u_borrado", source: "added" }],
    });
    expect(rows).toEqual([]);
  });
});
