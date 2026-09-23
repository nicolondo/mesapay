import { describe, expect, it } from "vitest";
import {
  DEFAULT_TIP_PCT,
  buildPrebillData,
  isLiveItem,
  tipCentsFor,
  type PrebillOrder,
  type PrebillOrderItem,
  type PrebillRestaurant,
} from "./prebill";

/**
 * Qué dice la precuenta, en números. Lo que hay que blindar: que sólo
 * entren los ítems vivos (un plato cancelado o una ronda cancelada no se
 * cobran, así que no pueden salir en el papel), que el total se arme con
 * las mismas reglas que el cobro (descuento, impuesto sumado encima,
 * pagos parciales) y que la propina sugerida sea eso — una sugerencia
 * aparte, nunca sumada al total.
 */

const NOW = new Date("2026-09-18T19:41:00.000Z");

const restaurant: PrebillRestaurant = {
  name: "Donde Chucho",
  legalName: "Inversiones Chucho S.A.S.",
  taxId: "900.123.456-7",
  legalAddress: "Calle 12 #4-56",
  legalCity: "Medellín",
  legalPhone: "604 444 5566",
  salesTaxKind: "inc",
  salesTaxPct: 8,
};

const menuItem = (
  over: Partial<PrebillOrderItem> & { nameSnapshot: string },
): PrebillOrderItem => ({
  qty: 1,
  priceCentsSnapshot: 1_000_000,
  taxKind: null,
  taxPct: null,
  cancelledAt: null,
  round: { status: "placed" },
  ...over,
});

const order: PrebillOrder = {
  shortCode: "A4F2",
  orderType: "dineIn",
  pickupName: null,
  discountPct: null,
  discountCents: 0,
  table: { number: 7, label: null, kind: "standard" },
  items: [
    menuItem({
      qty: 2,
      nameSnapshot: "Bandeja paisa",
      priceCentsSnapshot: 2_450_000,
      modifierSelections: { term: "Medio" },
      menuItem: {
        modifiers: [
          { id: "term", label: "Término", type: "radio", opts: ["Medio", "Tres cuartos"] },
        ],
      },
      notes: "  sin cebolla ",
    }),
    menuItem({ nameSnapshot: "Limonada de coco", priceCentsSnapshot: 1_200_000 }),
  ],
  payments: [],
};

const build = (
  over: Partial<PrebillOrder> = {},
  rest: Partial<PrebillRestaurant> = {},
  opts: { waiterName?: string | null; tipPct?: number } = {},
) => buildPrebillData({ ...order, ...over }, { ...restaurant, ...rest }, { now: NOW, ...opts });

describe("tipCentsFor", () => {
  it("10% por defecto, redondeado al centavo", () => {
    expect(DEFAULT_TIP_PCT).toBe(10);
    expect(tipCentsFor(6_100_000)).toBe(610_000);
    expect(tipCentsFor(333)).toBe(33);
  });

  it("nada sobre cero o con porcentaje inválido", () => {
    expect(tipCentsFor(0)).toBe(0);
    expect(tipCentsFor(-100)).toBe(0);
    expect(tipCentsFor(1000, 0)).toBe(0);
  });
});

describe("buildPrebillData — ítems", () => {
  it("una línea por ítem vivo, con importe de línea, modificadores y nota", () => {
    const d = build();
    expect(d.lines).toEqual([
      {
        qty: 2,
        name: "Bandeja paisa",
        unitCents: 2_450_000,
        lineCents: 4_900_000,
        modifiers: ["Término: Medio"],
        notes: "sin cebolla",
        guestName: null,
      },
      {
        qty: 1,
        name: "Limonada de coco",
        unitCents: 1_200_000,
        lineCents: 1_200_000,
        modifiers: [],
        notes: null,
        guestName: null,
      },
    ]);
  });

  it("un plato cancelado y uno de una ronda cancelada NO salen ni suman", () => {
    const d = build({
      items: [
        ...order.items,
        menuItem({ nameSnapshot: "Postre", cancelledAt: new Date(), priceCentsSnapshot: 900_000 }),
        menuItem({ nameSnapshot: "Ronda caída", round: { status: "cancelled" }, priceCentsSnapshot: 900_000 }),
      ],
    });
    expect(d.lines.map((l) => l.name)).toEqual(["Bandeja paisa", "Limonada de coco"]);
    expect(d.grossSubtotalCents).toBe(6_100_000);
  });

  it("una línea libre sin ronda cargada se toma viva", () => {
    expect(isLiveItem(menuItem({ nameSnapshot: "Alquiler", round: null }))).toBe(true);
    expect(isLiveItem(menuItem({ nameSnapshot: "Alquiler", round: undefined }))).toBe(true);
    expect(isLiveItem(menuItem({ nameSnapshot: "x", cancelledAt: "2026-09-18T00:00:00Z" }))).toBe(false);
  });
});

describe("buildPrebillData — totales", () => {
  it("una cuenta simple: subtotal = total = pendiente, sin descuento ni impuesto encima", () => {
    const d = build();
    expect(d.grossSubtotalCents).toBe(6_100_000);
    expect(d.discountCents).toBe(0);
    expect(d.netSubtotalCents).toBe(6_100_000);
    expect(d.taxOnTopCents).toBe(0);
    expect(d.totalCents).toBe(6_100_000);
    expect(d.paidCents).toBe(0);
    expect(d.outstandingCents).toBe(6_100_000);
  });

  it("el impuesto embebido de los platos es informativo: base + impuesto = subtotal, no se suma", () => {
    const d = build();
    // Por línea, como la factura: 4.900.000×8/108 y 1.200.000×8/108.
    expect(d.embeddedTax).toEqual({
      kind: "inc",
      pct: 8,
      taxCents: 362_963 + 88_889,
      baseCents: 6_100_000 - (362_963 + 88_889),
    });
    expect(d.totalCents).toBe(6_100_000);
  });

  it("comercio sin impuesto ⇒ sin fila de impuesto embebido", () => {
    expect(build({}, { salesTaxKind: "none", salesTaxPct: 0 }).embeddedTax).toBeNull();
    expect(build({}, { salesTaxKind: "raro", salesTaxPct: 8 }).embeddedTax).toBeNull();
  });

  it("el descuento del comensal se re-deriva del % sobre el subtotal vivo y baja el total", () => {
    const d = build({ discountPct: 10, discountCents: 1 });
    expect(d.discountPct).toBe(10);
    expect(d.discountCents).toBe(610_000);
    expect(d.netSubtotalCents).toBe(5_490_000);
    expect(d.totalCents).toBe(5_490_000);
  });

  it("sin % pactado, el monto persistido vale pero nunca supera el subtotal", () => {
    expect(build({ discountPct: null, discountCents: 300_000 }).discountCents).toBe(300_000);
    expect(build({ discountPct: null, discountCents: 99_000_000 }).discountCents).toBe(6_100_000);
  });

  it("el impuesto de una línea libre se SUMA encima y sí entra al total", () => {
    const d = build({
      items: [
        ...order.items,
        menuItem({
          nameSnapshot: "Alquiler del salón",
          priceCentsSnapshot: 10_000_000,
          taxKind: "iva",
          taxPct: 19,
          round: null,
        }),
      ],
    });
    expect(d.grossSubtotalCents).toBe(16_100_000);
    expect(d.taxOnTop).toEqual({ inc: 0, iva: 1_900_000 });
    expect(d.taxOnTopCents).toBe(1_900_000);
    expect(d.totalCents).toBe(18_000_000);
    // La línea libre no aporta al impuesto embebido de los platos.
    expect(d.embeddedTax?.taxCents).toBe(362_963 + 88_889);
  });

  it("los pagos APROBADOS bajan lo pendiente por su porción de comida; los pendientes no", () => {
    const d = build({
      payments: [
        { status: "approved", amountCents: 2_200_000, tipCents: 200_000 },
        { status: "pending", amountCents: 1_000_000, tipCents: 0 },
      ],
    });
    expect(d.paidCents).toBe(2_000_000);
    expect(d.outstandingCents).toBe(4_100_000);
    expect(d.totalCents).toBe(6_100_000);
  });

  it("lo pendiente nunca es negativo", () => {
    const d = build({
      payments: [{ status: "approved", amountCents: 9_000_000, tipCents: 0 }],
    });
    expect(d.outstandingCents).toBe(0);
  });
});

describe("buildPrebillData — propina sugerida", () => {
  it("10% de lo PENDIENTE, aparte del total", () => {
    const d = build({
      payments: [{ status: "approved", amountCents: 2_000_000, tipCents: 0 }],
    });
    expect(d.suggestedTipPct).toBe(10);
    expect(d.suggestedTipCents).toBe(410_000);
    expect(d.totalWithTipCents).toBe(4_100_000 + 410_000);
    expect(d.totalCents).toBe(6_100_000);
  });

  it("acepta otro porcentaje", () => {
    const d = build({}, {}, { tipPct: 15 });
    expect(d.suggestedTipCents).toBe(915_000);
  });

  it("cuenta ya cubierta ⇒ sin propina sugerida", () => {
    const d = build({
      payments: [{ status: "approved", amountCents: 6_100_000, tipCents: 0 }],
    });
    expect(d.suggestedTipCents).toBe(0);
    expect(d.totalWithTipCents).toBe(0);
  });
});

describe("buildPrebillData — identidad y destino", () => {
  it("razón social si está, si no el nombre comercial", () => {
    expect(build().businessName).toBe("Inversiones Chucho S.A.S.");
    expect(build({}, { legalName: null }).businessName).toBe("Donde Chucho");
    expect(build({}, { legalName: "  " }).businessName).toBe("Donde Chucho");
  });

  it("mesa física con su etiqueta", () => {
    expect(build({ table: { number: 7, label: "Terraza", kind: "standard" } }).destination).toEqual({
      kind: "table",
      number: 7,
      label: "Terraza",
    });
  });

  it("pedido para recoger lleva el nombre de quien recoge", () => {
    expect(
      build({ orderType: "pickup", pickupName: "Ana", table: { number: -1, label: null, kind: "pickup" } })
        .destination,
    ).toEqual({ kind: "pickup", name: "Ana" });
  });

  it("factura manual: nada de 'Mesa -100'", () => {
    expect(
      build({ table: { number: -100, label: "Factura manual", kind: "manual" } }).destination,
    ).toEqual({ kind: "manual", label: "Factura manual" });
  });

  it("mesero si se conoce, recortado; vacío ⇒ null", () => {
    expect(build({}, {}, { waiterName: " Carlos " }).waiterName).toBe("Carlos");
    expect(build({}, {}, { waiterName: "  " }).waiterName).toBeNull();
    expect(build().waiterName).toBeNull();
  });

  it("la fecha es la de emisión que se le pasa", () => {
    expect(build().issuedAt).toBe(NOW);
    expect(build().shortCode).toBe("A4F2");
  });
});

describe("buildPrebillData — artículos repetidos AGRUPADOS", () => {
  const bretana = (over: Partial<PrebillOrderItem> = {}) =>
    menuItem({
      nameSnapshot: "Bretaña",
      menuItemId: "mi-bretana",
      priceCentsSnapshot: 600_000,
      ...over,
    });

  it("tres Bretañas de tres rondas son UNA línea '3x', con el importe de las tres", () => {
    const d = build({ items: [bretana(), order.items[1], bretana(), bretana({ qty: 1 })] });
    expect(d.lines.map((l) => [l.name, l.qty, l.unitCents, l.lineCents])).toEqual([
      ["Bretaña", 3, 600_000, 1_800_000],
      ["Limonada de coco", 1, 1_200_000, 1_200_000],
    ]);
  });

  it("los totales no cambian: Σ de las líneas agrupadas = subtotal bruto al centavo", () => {
    const items = [
      bretana({ priceCentsSnapshot: 612_345 }),
      bretana({ priceCentsSnapshot: 612_345, qty: 2 }),
      bretana({ priceCentsSnapshot: 612_346 }),
      menuItem({ nameSnapshot: "Servicio", priceCentsSnapshot: 1_234_567, taxKind: "iva", taxPct: 19 }),
      bretana({ priceCentsSnapshot: 612_345 }),
    ];
    const d = build({ items });
    const gross = items.reduce((s, i) => s + i.qty * i.priceCentsSnapshot, 0);
    expect(d.lines).toHaveLength(3);
    expect(d.grossSubtotalCents).toBe(gross);
    expect(d.lines.reduce((s, l) => s + l.lineCents, 0)).toBe(gross);
  });

  it("mismo plato con otro término, o con nota distinta, NO se agrupa", () => {
    const term = {
      modifiers: [
        { id: "term", label: "Término", type: "radio", opts: ["Medio", "Tres cuartos"] },
      ],
    };
    const d = build({
      items: [
        bretana({ modifierSelections: { term: "Medio" }, menuItem: term }),
        bretana({ modifierSelections: { term: "Tres cuartos" }, menuItem: term }),
        bretana({ modifierSelections: { term: "Medio" }, menuItem: term, notes: "bien fría" }),
        bretana({ modifierSelections: { term: "Medio" }, menuItem: term }),
      ],
    });
    expect(d.lines.map((l) => [l.qty, l.modifiers, l.notes])).toEqual([
      [2, ["Término: Medio"], null],
      [1, ["Término: Tres cuartos"], null],
      [1, ["Término: Medio"], "bien fría"],
    ]);
  });

  it("el comensal no separa, pero el grupo sólo conserva su nombre si es de todos", () => {
    const d = build({
      items: [
        bretana({ guestName: "Ana" }),
        bretana({ guestName: "Luis" }),
        menuItem({ nameSnapshot: "Limonada de coco", guestName: "Ana" }),
        menuItem({ nameSnapshot: "Limonada de coco", guestName: " Ana " }),
      ],
    });
    expect(d.lines.map((l) => [l.name, l.qty, l.guestName])).toEqual([
      ["Bretaña", 2, null],
      ["Limonada de coco", 2, "Ana"],
    ]);
  });
});
