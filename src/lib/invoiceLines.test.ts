import { describe, expect, it } from "vitest";
import { groupInvoiceLines, invoiceLineKey } from "./invoiceLines";
import type { InvoiceSnapshot } from "./invoice";

type Item = InvoiceSnapshot["items"][number];

const bretana: Item = {
  qty: 1,
  name: "Bretaña",
  priceCents: 600_000,
  menuItemId: "mi-bretana",
  taxKind: null,
  taxPct: null,
  modifiers: [],
  notes: null,
};

const hamburguesa: Item = {
  qty: 1,
  name: "Hamburguesa",
  priceCents: 2_800_000,
  menuItemId: "mi-hamburguesa",
  taxKind: null,
  taxPct: null,
  modifiers: ["Término: Medio"],
  notes: null,
};

describe("groupInvoiceLines — cuándo junta", () => {
  it("dos Bretañas iguales ⇒ 1 línea × 2, con el importe de las dos", () => {
    const out = groupInvoiceLines([bretana, { ...bretana }]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ name: "Bretaña", qty: 2, totalCents: 1_200_000 });
  });

  it("las líneas que ya traen cantidad > 1 se SUMAN (2 + 3 = 5)", () => {
    const out = groupInvoiceLines([
      { ...bretana, qty: 2 },
      { ...bretana, qty: 3 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ qty: 5, totalCents: 3_000_000 });
  });

  it("conserva el orden de PRIMERA aparición", () => {
    const out = groupInvoiceLines([
      bretana,
      hamburguesa,
      { ...bretana },
      { ...hamburguesa },
    ]);
    expect(out.map((l) => [l.name, l.qty])).toEqual([
      ["Bretaña", 2],
      ["Hamburguesa", 2],
    ]);
  });

  it("el orden de los modificadores no importa, ni el de las opciones de un grupo", () => {
    const a = { ...hamburguesa, modifiers: ["Término: Medio", "Adición: Queso, Tocineta"] };
    const b = { ...hamburguesa, modifiers: ["Adición: Tocineta, Queso", "Término: Medio"] };
    const out = groupInvoiceLines([a, b]);
    expect(out).toHaveLength(1);
    expect(out[0].qty).toBe(2);
    // Lo que se muestra es la primera aparición tal cual.
    expect(out[0].modifiers).toEqual(["Término: Medio", "Adición: Queso, Tocineta"]);
  });

  it("mayúsculas y espacios de más en nombre, modificadores y nota no separan", () => {
    const out = groupInvoiceLines([
      { ...hamburguesa, notes: "Sin cebolla" },
      {
        ...hamburguesa,
        name: "  hamburguesa ",
        modifiers: ["término:  medio"],
        notes: "sin   cebolla ",
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ name: "Hamburguesa", notes: "Sin cebolla", qty: 2 });
  });

  it("un snapshot VIEJO (sólo qty, nombre y precio) se agrupa por nombre normalizado y precio", () => {
    const out = groupInvoiceLines([
      { qty: 1, name: "Limonada de coco", priceCents: 1_200_000 },
      { qty: 1, name: "Limonada de coco", priceCents: 1_200_000 },
    ]);
    expect(out).toEqual([
      { qty: 2, name: "Limonada de coco", priceCents: 1_200_000, totalCents: 2_400_000 },
    ]);
  });

  it("no muta la entrada", () => {
    const lines = [{ ...bretana }, { ...bretana }];
    groupInvoiceLines(lines);
    expect(lines.map((l) => l.qty)).toEqual([1, 1]);
  });
});

describe("groupInvoiceLines — cuándo NO junta", () => {
  it("mismo plato con modificadores distintos ⇒ 2 líneas", () => {
    const out = groupInvoiceLines([
      hamburguesa,
      { ...hamburguesa, modifiers: ["Término: Bien asado"] },
    ]);
    expect(out).toHaveLength(2);
    expect(out.map((l) => l.qty)).toEqual([1, 1]);
  });

  it("un modificador de más también separa (queso doble no es queso)", () => {
    const out = groupInvoiceLines([
      { ...hamburguesa, modifiers: ["Adición: Queso"] },
      { ...hamburguesa, modifiers: ["Adición: Queso", "Adición: Queso"] },
    ]);
    expect(out).toHaveLength(2);
  });

  it("mismo plato con precio distinto ⇒ 2 líneas (el papel no promedia)", () => {
    const out = groupInvoiceLines([bretana, { ...bretana, priceCents: 650_000 }]);
    expect(out).toHaveLength(2);
    expect(out.map((l) => l.totalCents)).toEqual([600_000, 650_000]);
  });

  it("nota distinta ⇒ 2 líneas; con nota y sin nota también", () => {
    expect(
      groupInvoiceLines([
        { ...hamburguesa, notes: "Sin cebolla" },
        { ...hamburguesa, notes: "Sin tomate" },
      ]),
    ).toHaveLength(2);
    expect(
      groupInvoiceLines([hamburguesa, { ...hamburguesa, notes: "Sin cebolla" }]),
    ).toHaveLength(2);
  });

  it("un plato del menú y una línea libre con el mismo nombre y precio no se juntan", () => {
    const libre: Item = {
      qty: 1,
      name: "Bretaña",
      priceCents: 600_000,
      menuItemId: null,
      taxKind: "iva",
      taxPct: 19,
    };
    expect(groupInvoiceLines([bretana, libre])).toHaveLength(2);
  });

  it("impuesto distinto ⇒ 2 líneas", () => {
    const servicio: Item = { qty: 1, name: "Servicio", priceCents: 100_000, taxKind: "iva", taxPct: 19 };
    expect(groupInvoiceLines([servicio, { ...servicio, taxPct: 5 }])).toHaveLength(2);
    expect(groupInvoiceLines([servicio, { ...servicio, taxKind: "inc", taxPct: 19 }])).toHaveLength(2);
  });

  it("distinto plato del menú con el mismo nombre (dos cartas) no se junta", () => {
    expect(
      groupInvoiceLines([bretana, { ...bretana, menuItemId: "mi-otra" }]),
    ).toHaveLength(2);
  });

  it("el mismo plato renombrado a mitad del servicio no se junta: una línea mentiría sobre la otra", () => {
    expect(
      groupInvoiceLines([bretana, { ...bretana, name: "Bretaña 330 ml" }]),
    ).toHaveLength(2);
  });
});

describe("invoiceLineKey", () => {
  it("'none' con un % suelto es la misma línea sin impuesto que 'none' con null", () => {
    const a: Item = { qty: 1, name: "Bono", priceCents: 5_000_000, taxKind: "none", taxPct: 8 };
    const b: Item = { ...a, taxPct: null };
    expect(invoiceLineKey(a)).toBe(invoiceLineKey(b));
  });
});

describe("los totales cuadran al centavo con el snapshot", () => {
  it("Σ de las líneas agrupadas = Σ qty × unitario del snapshot = subtotal", () => {
    // Una cuenta real de tres rondas: repetidos, cantidades > 1, un plato
    // con modificadores distintos, uno que cambió de precio y una línea
    // libre, con montos que no son redondos.
    const items: Item[] = [
      { ...bretana, priceCents: 612_345 },
      { ...hamburguesa, priceCents: 2_799_999 },
      { ...bretana, priceCents: 612_345, qty: 3 },
      { ...hamburguesa, priceCents: 2_799_999, modifiers: ["Término: Bien asado"] },
      { ...bretana, priceCents: 612_346 },
      { qty: 2, name: "Servicio de mesero", priceCents: 1_234_567, taxKind: "iva", taxPct: 19 },
      { ...hamburguesa, priceCents: 2_799_999 },
      { ...bretana, priceCents: 612_345, qty: 2 },
    ];
    const subtotalCents = items.reduce((s, i) => s + i.qty * i.priceCents, 0);
    const grouped = groupInvoiceLines(items);

    expect(grouped.length).toBeLessThan(items.length);
    expect(grouped.reduce((s, l) => s + l.totalCents, 0)).toBe(subtotalCents);
    expect(grouped.reduce((s, l) => s + l.qty, 0)).toBe(
      items.reduce((s, i) => s + i.qty, 0),
    );
    // Y cada grupo es exactamente (Σ qty) × unitario: nada se redondeó.
    for (const l of grouped) expect(l.totalCents).toBe(l.qty * l.priceCents);
    expect(grouped.map((l) => [l.name, l.qty, l.priceCents])).toEqual([
      ["Bretaña", 6, 612_345],
      ["Hamburguesa", 2, 2_799_999],
      ["Hamburguesa", 1, 2_799_999],
      ["Bretaña", 1, 612_346],
      ["Servicio de mesero", 2, 1_234_567],
    ]);
  });
});
