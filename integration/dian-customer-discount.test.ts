// Descuento del cliente en la factura electrónica, contra PostgreSQL real.
//
// La forma del caso reportado (cifras inventadas): cuenta de menú con INC 8 %
// incluido, subtotal $113.400, descuento del cliente 20 % = $22.680, propina
// $9.072. Antes la factura declaraba $105.000 + INC $8.400 = $113.400; ahora
// cada línea lleva su descuento y el documento declara lo cobrado. La DIAN
// no se llama nunca (sendBillSync es un mock); la base, la tirilla, el
// reclamo, el XML, el lector de la nota crédito y la revisión de impuestos
// son reales.
import { randomUUID } from "node:crypto";
import JSZip from "jszip";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../src/lib/db";

const scope = vi.hoisted(() => ({ restaurantId: "" }));
const dian = vi.hoisted(() => ({ sendBillSync: vi.fn(), getStatus: vi.fn() }));
vi.mock("../src/lib/dian/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/dian/config")>()),
  resolveEmisor: async () => ({
    ref: { kind: "restaurant", id: scope.restaurantId },
    legalName: "EMISOR DE PRUEBA S.A.S.",
    taxId: "900373076-5",
    addressLine: "Calle 1 # 2-3",
    cityName: "ENVIGADO",
    legalCityCode: "05266",
    resolution: null,
    resolutionFrom: 1,
    resolutionTo: 10000,
    resolutionNumber: "18760000001",
    resolutionValidFrom: "2025-06-26",
    resolutionValidTo: "2030-06-26",
    resolutionDate: "2025-06-26",
    invoicePrefix: "FEPR",
    contactEmail: "facturacion@example.test",
    invoiceNextNumber: 8000,
  }),
  loadDianConfig: async () => ({
    configId: "cfg-test",
    environment: "produccion",
    cert: {},
    softwareId: "soft-test",
    softwarePin: "0000",
    technicalKey: "clave-tecnica-de-prueba",
    testSetId: null,
  }),
}));
vi.mock("../src/lib/dian/xades", () => ({ signXmlDian: (xml: string) => xml }));
vi.mock("../src/lib/dian/soap", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/dian/soap")>()),
  sendBillSync: dian.sendBillSync,
  getStatus: dian.getStatus,
}));
vi.mock("../src/lib/dian/sendInvoiceEmail", () => ({ sendDianInvoiceEmail: vi.fn(async () => ({ ok: false, reason: "no_recipient" })) }));
vi.mock("../src/lib/print/invoiceQueue", () => ({
  printAcceptedDianInvoice: vi.fn(async () => undefined),
  enqueueInvoicePrintSafe: vi.fn(async () => undefined),
}));

import { issueSimpleInvoice } from "../src/lib/simpleInvoice";
import { emitDianInvoice } from "../src/lib/dian/emitInvoice";
import { parseAcceptedInvoiceXml } from "../src/lib/dian/creditNoteSource";
import { loadSaleTaxDocs } from "../src/lib/erp/reports/taxesQueries";
import { clearTaxesDrillCache, loadTaxesDrillBase, taxChecks } from "../src/lib/erp/reports/taxesDrillReport";
import type { InvoiceSnapshot } from "../src/lib/invoice";

const database = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
if (!["localhost", "127.0.0.1"].includes(database.hostname) || !/^\/mesapay_.*(?:test|validation)$/.test(database.pathname)) {
  throw new Error("Isolated local database required");
}

const PAID_AT = new Date("2026-10-20T18:00:00Z");
const ITEMS = [
  { nameSnapshot: "Bandeja paisa", priceCentsSnapshot: 4_200_000, qty: 1 },
  { nameSnapshot: "Ajiaco", priceCentsSnapshot: 3_200_000, qty: 1 },
  { nameSnapshot: "Limonada de coco", priceCentsSnapshot: 1_200_000, qty: 2 },
  { nameSnapshot: "Café", priceCentsSnapshot: 600_000, qty: 2 },
  { nameSnapshot: "Arepa de chócolo", priceCentsSnapshot: 340_000, qty: 1 },
];
const tenants: string[] = [];
let tableId: string;

async function paidOrder() {
  return db.order.create({ data: {
    restaurantId: scope.restaurantId, tableId, shortCode: randomUUID(), status: "paid", paidAt: PAID_AT,
    subtotalCents: 11_340_000, discountCents: 2_268_000, discountPct: 20, tipCents: 907_200, totalCents: 9_979_200,
    items: { create: ITEMS },
  } });
}

async function unzip(bytes: Uint8Array | null): Promise<string> {
  const z = await JSZip.loadAsync(bytes!);
  return Object.values(z.files)[0]!.async("string");
}

function legal(xml: string, tag: string): string {
  const block = xml.split("<cac:LegalMonetaryTotal>")[1]!.split("</cac:LegalMonetaryTotal>")[0]!;
  return block.match(new RegExp(`<cbc:${tag} currencyID="COP">([\\d.]+)<`))?.[1] ?? "";
}

beforeEach(async () => {
  vi.clearAllMocks();
  clearTaxesDrillCache();
  dian.sendBillSync.mockResolvedValue({ state: "accepted", statusCode: "00", errors: [], raw: "<ok/>" });
  const tenant = await db.restaurant.create({ data: {
    name: "Descuento DIAN", slug: `dian-desc-${randomUUID()}`, salesTaxKind: "inc", salesTaxPct: 8,
    enabledModules: ["einvoicing"], invoicePrefix: "FEPR", invoiceNextNumber: 8000,
  } });
  tenants.push(tenant.id);
  const table = await db.table.create({ data: { restaurantId: tenant.id, number: 1, qrToken: randomUUID() } });
  scope.restaurantId = tenant.id;
  tableId = table.id;
});

afterAll(async () => {
  await db.auditEvent.deleteMany({ where: { restaurantId: { in: tenants } } });
  await db.restaurant.deleteMany({ where: { id: { in: tenants } } });
  await db.$disconnect();
});

describe("cuenta pagada con descuento del cliente", () => {
  it("tirilla neta, XML con el descuento en cada línea, nota crédito que la lee neta y reportes netos", async () => {
    const order = await paidOrder();
    const issued = await issueSimpleInvoice({ tenantId: scope.restaurantId, orderId: order.id });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    expect(issued.snapshot).toMatchObject({
      embeddedTaxCents: 672_000,
      embeddedBaseCents: 8_400_000,
      discountInLines: { allowanceCents: 2_100_000 },
      totalCents: 9_979_200,
    });

    const r = await emitDianInvoice({ simpleInvoiceId: issued.invoiceId, restaurantId: scope.restaurantId });
    expect(r.outcome).toBe("accepted");
    const doc = await db.dianDocument.findUniqueOrThrow({ where: { simpleInvoiceId: issued.invoiceId } });
    const xml = await unzip(doc.xmlZip);
    expect(legal(xml, "LineExtensionAmount")).toBe("84000.00");
    expect(legal(xml, "TaxExclusiveAmount")).toBe("84000.00");
    expect(legal(xml, "TaxInclusiveAmount")).toBe("90720.00");
    expect(legal(xml, "AllowanceTotalAmount")).toBe("0.00");
    expect(legal(xml, "PayableAmount")).toBe("90720.00");
    expect(xml.split("<cac:AllowanceCharge>")).toHaveLength(ITEMS.length + 1);

    // La nota crédito se reconstruye desde ese XML: lo máximo es lo cobrado.
    const source = parseAcceptedInvoiceXml(xml);
    expect(source.totals).toMatchObject({ lineExtensionCents: 8_400_000, taxIncCents: 672_000, payableCents: 9_072_000 });

    // Impuestos del período: la base y el INC netos, sin nada «de más».
    const [sale] = await loadSaleTaxDocs(scope.restaurantId, new Date("2026-10-01T05:00:00Z"), new Date("2026-11-01T05:00:00Z"));
    expect(sale).toMatchObject({ baseCents: 8_400_000, taxCents: 672_000 });
    expect(sale!.undeclaredDiscount).toBeUndefined();
  });
});

describe("facturas con descuento emitidas antes del arreglo", () => {
  /** Snapshot como lo congelaba la versión anterior: base e INC del precio de lista, sin la marca. */
  async function oldInvoice(number: number, docState: string) {
    const order = await paidOrder();
    const issued = await issueSimpleInvoice({ tenantId: scope.restaurantId, orderId: order.id });
    if (!issued.ok) throw new Error("no invoice");
    const old = { ...issued.snapshot, embeddedTaxCents: 840_000, embeddedBaseCents: 10_500_000 } as InvoiceSnapshot;
    delete old.discountInLines;
    await db.simpleInvoice.update({ where: { id: issued.invoiceId }, data: { snapshot: old as unknown as object, invoiceNumber: number } });
    await db.dianDocument.create({ data: {
      restaurantId: scope.restaurantId, orderId: order.id, simpleInvoiceId: issued.invoiceId, kind: "invoice",
      state: docState, attempts: docState === "accepted" ? 1 : 0, ...(docState === "accepted" ? { cufe: "c".repeat(96) } : {}),
    } });
    return issued.invoiceId;
  }

  it("la aceptada con el precio de lista aparece en «Revisar antes de declarar» con la base y el INC de más", async () => {
    const id = await oldInvoice(8101, "accepted");
    const base = await loadTaxesDrillBase(scope.restaurantId, { desde: "2026-10-01", hasta: "2026-10-31" });
    const check = taxChecks(base).find((c) => c.key === "descuentoSinDeclarar")!;
    expect(check).toMatchObject({ count: 1, amountCents: 168_000, params: { baseCents: 2_100_000, discountCents: 2_268_000 } });
    expect(check.rows[0]).toMatchObject({ docId: id, baseCents: 2_100_000, amountCents: 168_000 });
    // Su historia no cambia: los documentos del período siguen con lo que declaró.
    const [sale] = await loadSaleTaxDocs(scope.restaurantId, new Date("2026-10-01T05:00:00Z"), new Date("2026-11-01T05:00:00Z"));
    expect(sale).toMatchObject({ baseCents: 10_500_000, taxCents: 840_000 });
    expect((await db.simpleInvoice.findUniqueOrThrow({ where: { id } })).snapshot).not.toHaveProperty("discountInLines");
  });

  it("una sin aceptar se envía con el descuento en las líneas y su tirilla pasa a decir lo mismo", async () => {
    const id = await oldInvoice(8102, "to_send");
    const r = await emitDianInvoice({ simpleInvoiceId: id, restaurantId: scope.restaurantId });
    expect(r.outcome).toBe("accepted");
    const inv = await db.simpleInvoice.findUniqueOrThrow({ where: { id }, include: { dianDocument: true } });
    expect(inv.snapshot).toMatchObject({ embeddedTaxCents: 672_000, embeddedBaseCents: 8_400_000, discountInLines: { allowanceCents: 2_100_000 } });
    expect(legal(await unzip(inv.dianDocument!.xmlZip), "PayableAmount")).toBe("90720.00");
    const base = await loadTaxesDrillBase(scope.restaurantId, { desde: "2026-10-01", hasta: "2026-10-31" });
    expect(taxChecks(base).find((c) => c.key === "descuentoSinDeclarar")!.count).toBe(0);
  });
});
