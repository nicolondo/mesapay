// Confirmación de una factura leída con IA cuyo documento trae líneas
// DUPLICADAS legítimas (el mismo artículo impreso dos veces), cantidades
// decimales, tarifas de IVA mezcladas y una diferencia de 1 centavo por el
// redondeo del emisor. Caso real (anonimizado): la factura de un mayorista
// con 25 líneas no se podía guardar — crear dos veces el mismo insumo nuevo
// chocaba con el índice único (restaurantId, name) y el operador solo veía
// «No se pudo guardar. Intenta de nuevo.»
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../src/lib/db";
import { POST as confirmInvoice } from "../src/app/api/operator/purchase-invoices/[id]/confirm/route";

const scope = vi.hoisted(() => ({ restaurantId: "" }));
vi.mock("../src/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("../src/auth", () => ({ auth: async () => ({ user: { role: "operator" } }) }));
vi.mock("../src/lib/activeRestaurant", () => ({ getActiveRestaurantId: async () => scope.restaurantId }));

const url = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
if (!["127.0.0.1", "localhost"].includes(url.hostname) || !/^\/mesapay_.*(?:test|validation)$/.test(url.pathname)) {
  throw new Error("Isolated local database required");
}

let tenantIds: string[] = [];

beforeEach(async () => {
  const r = await db.restaurant.create({
    data: {
      name: "Compra duplicada validation",
      slug: `compra-dup-${randomUUID()}`,
      enabledModules: ["purchasing", "inventory"],
      purchaseIvaDeductible: false,
    },
  });
  tenantIds = [...tenantIds, r.id];
  scope.restaurantId = r.id;
});

afterAll(async () => {
  await db.stockMovement.deleteMany({ where: { restaurantId: { in: tenantIds } } });
  await db.purchaseOrder.deleteMany({ where: { restaurantId: { in: tenantIds } } });
  await db.restaurant.deleteMany({ where: { id: { in: tenantIds } } });
  await db.$disconnect();
});

/** Línea nueva (insumo por crear) como la arma la revisión de la factura. */
function newLine(
  name: string,
  fields: { qtyBase: number; expectedCostCents: number; taxPct: number; expectedTaxCents: number; measure?: "mass" | "volume" | "count" },
) {
  return {
    ingredientId: null,
    newIngredientName: name,
    newIngredientMeasureKind: fields.measure ?? "count",
    qtyBase: fields.qtyBase,
    expectedCostCents: fields.expectedCostCents,
    taxPct: fields.taxPct,
    expectedTaxCents: fields.expectedTaxCents,
    expectedIncCents: 0,
  };
}

// Las 25 líneas del caso real, anonimizadas y con los MISMOS centavos: el
// neto por línea es «total con IVA − IVA impreso». Suma de netos 113.304.641
// (un centavo MÁS que el subtotal impreso 113.304.640), IVA 13.650.859 y
// total a pagar 126.955.500 — exactamente el TOTAL impreso por el emisor.
function invoiceLines() {
  return [
    newLine("Servilletas cafetería A 100u", { qtyBase: 1, expectedCostCents: 277_311, taxPct: 19, expectedTaxCents: 52_689 }),
    newLine("Jamón tajado 2500g", { qtyBase: 1, expectedCostCents: 4_717_647, taxPct: 19, expectedTaxCents: 896_353 }),
    // Artículo impreso DOS veces con montos idénticos (líneas 3/4 del caso).
    newLine("Fríjol blanco 3000g", { qtyBase: 1, expectedCostCents: 6_620_000, taxPct: 0, expectedTaxCents: 0 }),
    newLine("Fríjol blanco 3000g", { qtyBase: 1, expectedCostCents: 6_620_000, taxPct: 0, expectedTaxCents: 0 }),
    newLine("Maíz pira 1000g", { qtyBase: 1, expectedCostCents: 460_000, taxPct: 0, expectedTaxCents: 0 }),
    newLine("Maíz pira 1000g", { qtyBase: 1, expectedCostCents: 460_000, taxPct: 0, expectedTaxCents: 0 }),
    newLine("Refresco en polvo 450g", { qtyBase: 1, expectedCostCents: 631_933, taxPct: 19, expectedTaxCents: 120_067 }),
    newLine("Refresco en polvo 450g", { qtyBase: 1, expectedCostCents: 631_933, taxPct: 19, expectedTaxCents: 120_067 }),
    newLine("Bebida energizante 473ml", { qtyBase: 1, expectedCostCents: 574_790, taxPct: 19, expectedTaxCents: 109_210 }),
    newLine("Guantes multiuso talla L 50u", { qtyBase: 1, expectedCostCents: 6_302_521, taxPct: 19, expectedTaxCents: 1_197_479 }),
    newLine("Aceitunas deshuesadas 1000g", { qtyBase: 1, expectedCostCents: 2_689_076, taxPct: 19, expectedTaxCents: 510_924 }),
    newLine("Servilletas cafetería B 100u", { qtyBase: 12, expectedCostCents: 2_319_328, taxPct: 19, expectedTaxCents: 440_672 }),
    newLine("Aceitunas manzanilla 1000g", { qtyBase: 1, expectedCostCents: 1_848_740, taxPct: 19, expectedTaxCents: 351_260 }),
    newLine("Alcaparras en vinagre 1000g", { qtyBase: 1, expectedCostCents: 2_016_135, taxPct: 19, expectedTaxCents: 383_065 }),
    newLine("Alcaparras en vinagre 1000g", { qtyBase: 1, expectedCostCents: 2_016_135, taxPct: 19, expectedTaxCents: 383_065 }),
    newLine("Papel aluminio 300m", { qtyBase: 1, expectedCostCents: 7_394_958, taxPct: 19, expectedTaxCents: 1_405_042 }),
    newLine("Lavaloza líquido 20l", { qtyBase: 4, expectedCostCents: 32_235_294, taxPct: 19, expectedTaxCents: 6_124_706 }),
    newLine("Lavaloza líquido 10l", { qtyBase: 1, expectedCostCents: 4_781_513, taxPct: 19, expectedTaxCents: 908_487 }),
    newLine("Esponjillas 12u", { qtyBase: 1, expectedCostCents: 613_445, taxPct: 19, expectedTaxCents: 116_555 }),
    newLine("Esponjillas 12u", { qtyBase: 1, expectedCostCents: 613_445, taxPct: 19, expectedTaxCents: 116_555 }),
    newLine("Mentas 200u", { qtyBase: 1, expectedCostCents: 1_411_765, taxPct: 19, expectedTaxCents: 268_235 }),
    // Tarifa reducida (5 %) duplicada (líneas 22/23 del caso).
    newLine("Salchichón cervecero 1500g", { qtyBase: 1, expectedCostCents: 1_464_286, taxPct: 5, expectedTaxCents: 73_214 }),
    newLine("Salchichón cervecero 1500g", { qtyBase: 1, expectedCostCents: 1_464_286, taxPct: 5, expectedTaxCents: 73_214 }),
    // Cantidades DECIMALES (5,71 kg y 3,56 kg) en unidad base (gramos),
    // mismo artículo dos veces con montos distintos (líneas 24/25 del caso).
    newLine("Tocineta de cerdo kg", { qtyBase: 5_710, expectedCostCents: 15_474_540, taxPct: 0, expectedTaxCents: 0, measure: "mass" }),
    newLine("Tocineta de cerdo kg", { qtyBase: 3_560, expectedCostCents: 9_665_560, taxPct: 0, expectedTaxCents: 0, measure: "mass" }),
  ];
}

const PRINTED_TOTAL_CENTS = 126_955_500;

async function confirm(body: Record<string, unknown>, extraction: { invoiceTotalCents?: number } = {}) {
  const upload = await db.purchaseInvoiceUpload.create({
    data: { restaurantId: scope.restaurantId, fileUrl: "/uploads/validation-only.pdf", status: "pending", extraction },
  });
  const response = await confirmInvoice(
    new Request(`http://localhost/api/operator/purchase-invoices/${upload.id}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: upload.id }) },
  );
  return { response, uploadId: upload.id };
}

function fullBody(mode: "draft" | "receive", fields: Record<string, unknown> = {}) {
  return {
    supplierId: null,
    newSupplierName: "Mayorista Norte validation",
    newSupplierNit: "900000000-1",
    lines: invoiceLines(),
    mode,
    supplierInvoiceNumber: `18FT-${randomUUID().slice(0, 8)}`,
    incCents: 0,
    retefuenteCents: 0,
    reteIvaCents: 0,
    reteIcaCents: 0,
    roundingCents: 0,
    possibleDuplicate: "check",
    ...fields,
  };
}

describe("supplier invoice with legitimately duplicated lines", () => {
  it("saves the 25-line invoice as a draft, creating each repeated new ingredient once", async () => {
    const { response, uploadId } = await confirm(fullBody("draft"), { invoiceTotalCents: PRINTED_TOTAL_CENTS });
    expect(response.status).toBe(201);
    const { order } = await response.json();
    const saved = await db.purchaseOrder.findUniqueOrThrow({ where: { id: order.id }, include: { items: true } });
    expect(saved.status).toBe("draft");
    expect(saved.items).toHaveLength(25);
    // El neto total a pagar conserva el centavo aceptado del caso real.
    const payable = saved.items.reduce((sum, item) => sum + item.expectedCostCents + (item.expectedTaxCents ?? 0), 0);
    expect(payable).toBe(PRINTED_TOTAL_CENTS);
    // Un solo insumo por nombre repetido, con las dos líneas apuntándole.
    const frijoles = await db.ingredient.findMany({ where: { restaurantId: scope.restaurantId, name: "Fríjol blanco 3000g" } });
    expect(frijoles).toHaveLength(1);
    expect(saved.items.filter((item) => item.ingredientId === frijoles[0]!.id)).toHaveLength(2);
    const tocinetas = await db.ingredient.findMany({ where: { restaurantId: scope.restaurantId, name: "Tocineta de cerdo kg" } });
    expect(tocinetas).toHaveLength(1);
    expect(tocinetas[0]!.measureKind).toBe("mass");
    const upload = await db.purchaseInvoiceUpload.findUniqueOrThrow({ where: { id: uploadId } });
    expect(upload.status).toBe("confirmed");
    expect(upload.purchaseOrderId).toBe(order.id);
  });

  it("saves the same invoice with «crear y recibir», entering the decimal quantities into stock", async () => {
    const { response } = await confirm(fullBody("receive", { invoiceDueAt: null }), { invoiceTotalCents: PRINTED_TOTAL_CENTS });
    expect(response.status).toBe(201);
    const { order } = await response.json();
    const saved = await db.purchaseOrder.findUniqueOrThrow({ where: { id: order.id }, include: { items: true } });
    expect(saved.status).toBe("received");
    const tocineta = await db.ingredient.findFirstOrThrow({ where: { restaurantId: scope.restaurantId, name: "Tocineta de cerdo kg" } });
    const received = saved.items
      .filter((item) => item.ingredientId === tocineta.id)
      .reduce((sum, item) => sum + item.receivedQtyBase, 0);
    expect(received).toBe(5_710 + 3_560); // 5,71 kg + 3,56 kg en gramos
  });

  it("requires the explicit confirmation when the payable differs from the printed total, and honors it", async () => {
    // Total impreso SIN el redondeo del emisor: difiere 1 centavo del pagar.
    const printed = { invoiceTotalCents: PRINTED_TOTAL_CENTS - 1 };
    const rejected = await confirm(fullBody("draft"), printed);
    expect(rejected.response.status).toBe(409);
    expect((await rejected.response.json()).error).toBe("totals_unconfirmed");
    // La carga sigue pendiente: nada quedó creado a medias.
    const pending = await db.purchaseInvoiceUpload.findUniqueOrThrow({ where: { id: rejected.uploadId } });
    expect(pending.status).toBe("pending");
    expect(await db.ingredient.count({ where: { restaurantId: scope.restaurantId } })).toBe(0);

    const accepted = await confirm(fullBody("draft", { acknowledgedDifferences: true }), printed);
    expect(accepted.response.status).toBe(201);
  });

  it("reuses an existing active ingredient instead of crashing on its unique name", async () => {
    const existing = await db.ingredient.create({
      data: { restaurantId: scope.restaurantId, name: "Fríjol blanco 3000g", measureKind: "count" },
    });
    const { response } = await confirm(fullBody("draft"), { invoiceTotalCents: PRINTED_TOTAL_CENTS });
    expect(response.status).toBe(201);
    const { order } = await response.json();
    const saved = await db.purchaseOrder.findUniqueOrThrow({ where: { id: order.id }, include: { items: true } });
    expect(saved.items.filter((item) => item.ingredientId === existing.id)).toHaveLength(2);
    expect(await db.ingredient.count({ where: { restaurantId: scope.restaurantId, name: "Fríjol blanco 3000g" } })).toBe(1);
  });

  it("answers with a specific error when the new name belongs to an archived ingredient", async () => {
    await db.ingredient.create({
      data: { restaurantId: scope.restaurantId, name: "Fríjol blanco 3000g", measureKind: "count", active: false },
    });
    const { response, uploadId } = await confirm(fullBody("draft"), { invoiceTotalCents: PRINTED_TOTAL_CENTS });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("ingredient_archived");
    const pending = await db.purchaseInvoiceUpload.findUniqueOrThrow({ where: { id: uploadId } });
    expect(pending.status).toBe("pending");
  });

  it("answers with a specific error when the new name exists with another measure", async () => {
    // Con otra medida, la cantidad base (gramos vs unidades) no es la misma:
    // hay que elegir el insumo existente en la revisión, no adivinar.
    await db.ingredient.create({
      data: { restaurantId: scope.restaurantId, name: "Tocineta de cerdo kg", measureKind: "count" },
    });
    const { response } = await confirm(fullBody("draft"), { invoiceTotalCents: PRINTED_TOTAL_CENTS });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("ingredient_name_taken");
  });

  it("reuses an existing active supplier with the same name instead of crashing", async () => {
    const supplier = await db.supplier.create({
      data: { restaurantId: scope.restaurantId, name: "Mayorista Norte validation" },
    });
    const { response } = await confirm(fullBody("draft"), { invoiceTotalCents: PRINTED_TOTAL_CENTS });
    expect(response.status).toBe(201);
    const { order } = await response.json();
    expect((await db.purchaseOrder.findUniqueOrThrow({ where: { id: order.id } })).supplierId).toBe(supplier.id);
    expect(await db.supplier.count({ where: { restaurantId: scope.restaurantId } })).toBe(1);
  });

  it("answers with a specific error when the supplier name belongs to an archived supplier", async () => {
    await db.supplier.create({
      data: { restaurantId: scope.restaurantId, name: "Mayorista Norte validation", active: false },
    });
    const { response } = await confirm(fullBody("draft"), { invoiceTotalCents: PRINTED_TOTAL_CENTS });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("supplier_archived");
  });
});
