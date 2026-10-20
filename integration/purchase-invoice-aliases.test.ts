import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PurchaseInvoiceExtraction } from "../src/lib/anthropic";
import { db } from "../src/lib/db";
import { POST as uploadInvoice } from "../src/app/api/operator/purchase-invoices/route";
import { GET as readInvoice, DELETE as discardInvoice } from "../src/app/api/operator/purchase-invoices/[id]/route";
import { POST as confirmInvoice } from "../src/app/api/operator/purchase-invoices/[id]/confirm/route";
import { createBackup, restoreSnapshot, type SnapshotData } from "../src/lib/backups";
import { normalizeInvoiceAlias } from "../src/lib/erp/invoiceMatch";

const scope = vi.hoisted(() => ({
  restaurantId: "", extraction: null as PurchaseInvoiceExtraction | null,
  extract: vi.fn(),
}));
vi.mock("../src/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("../src/auth", () => ({ auth: async () => ({ user: { role: "operator" } }) }));
vi.mock("../src/lib/activeRestaurant", () => ({ getActiveRestaurantId: async () => scope.restaurantId }));
vi.mock("../src/lib/anthropic", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/lib/anthropic")>(),
  extractPurchaseInvoice: scope.extract,
}));

const dbUrl = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
if (!["127.0.0.1", "localhost"].includes(dbUrl.hostname) || !/^\/mesapay_.*(?:test|validation)$/.test(dbUrl.pathname)) {
  throw new Error("Isolated local database required");
}

const tenantIds: string[] = [];
let owner: Awaited<ReturnType<typeof tenant>>;
let foreign: Awaited<ReturnType<typeof tenant>>;
let uploadDir = "";
const previousUploadDir = process.env.UPLOAD_DIR;

async function tenant() {
  const restaurant = await db.restaurant.create({
    data: { name: "Invoice alias validation", slug: `invoice-alias-${randomUUID()}`, enabledModules: ["purchasing", "inventory"] },
  });
  tenantIds.push(restaurant.id);
  const supplier = await db.supplier.create({ data: { restaurantId: restaurant.id, name: "Supplier Central", taxId: "9011234567" } });
  const guessed = await db.ingredient.create({ data: { restaurantId: restaurant.id, name: "Gordons", measureKind: "count" } });
  const selected = await db.ingredient.create({ data: { restaurantId: restaurant.id, name: "Ginebra de la casa", measureKind: "volume" } });
  return { restaurant, supplier, guessed, selected };
}

function extraction(descriptions = ["GORDONS DRY 700ML", "OTHER SOURCE PRODUCT"]): PurchaseInvoiceExtraction {
  return {
    documentType: "factura", supplierName: owner.supplier.name, supplierNit: owner.supplier.taxId,
    supplierInvoiceNumber: "ALIAS-VALIDATION", issueDate: "2026-10-20", currency: "COP",
    lines: descriptions.map((description) => ({
      description, quantity: 2, unit: "und", unitPriceCents: 10000, lineTotalCents: 20000, taxPct: "5", confidence: 0.9,
    })),
    invoiceSubtotalCents: null, invoiceTaxCents: null, invoiceTotalCents: null, invoiceIncCents: null,
    retefuenteCents: null, reteIvaCents: null, reteIcaCents: null, confidence: 0.9,
  };
}

async function pending(descriptions?: string[]) {
  return db.purchaseInvoiceUpload.create({
    data: { restaurantId: owner.restaurant.id, fileUrl: "/uploads/alias-validation.pdf", extraction: extraction(descriptions) },
  });
}

function line(overrides: Record<string, unknown> = {}) {
  return { ingredientId: owner.selected.id, qtyBase: 1400, expectedCostCents: 20000, taxPct: 5, sourceLineIndex: 0, rememberMatch: true, ...overrides };
}

function confirm(id: string, lines = [line()], overrides: Record<string, unknown> = {}) {
  return confirmInvoice(new Request(`http://localhost/api/operator/purchase-invoices/${id}/confirm`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ supplierId: owner.supplier.id, mode: "draft", lines, ...overrides }),
  }), { params: Promise.resolve({ id }) });
}

function read(id: string, supplierId?: string) {
  const query = supplierId === undefined ? "" : `?supplierId=${encodeURIComponent(supplierId)}`;
  return readInvoice(new Request(`http://localhost/api/operator/purchase-invoices/${id}${query}`), { params: Promise.resolve({ id }) });
}

async function alias(description = "GORDONS DRY 700ML", ingredientId = owner.selected.id, supplierId = owner.supplier.id) {
  return db.supplierInvoiceAlias.create({
    data: { supplierId, ingredientId, sourceDescription: description, normalizedDescription: normalizeInvoiceAlias(description) },
  });
}

beforeAll(async () => {
  uploadDir = await mkdtemp(path.join(tmpdir(), "mesapay-alias-upload-"));
  process.env.UPLOAD_DIR = uploadDir;
});
beforeEach(async () => {
  owner = await tenant();
  foreign = await tenant();
  scope.restaurantId = owner.restaurant.id;
  scope.extract.mockReset().mockImplementation(async () => scope.extraction);
  scope.extraction = extraction();
});
afterAll(async () => {
  await db.stockMovement.deleteMany({ where: { restaurantId: { in: tenantIds } } });
  await db.purchaseOrder.deleteMany({ where: { restaurantId: { in: tenantIds } } });
  await db.restaurant.deleteMany({ where: { id: { in: tenantIds } } });
  await db.$disconnect();
  if (previousUploadDir === undefined) delete process.env.UPLOAD_DIR;
  else process.env.UPLOAD_DIR = previousUploadDir;
  if (uploadDir) await rm(uploadDir, { recursive: true, force: true });
});

describe("confirmed supplier invoice aliases", () => {
  it("stores original server-side descriptions only after confirmation and reuses them on fresh reads", async () => {
    const upload = await pending();
    expect((await (await read(upload.id)).json()).match.lines[0].ingredient.ingredient.id).toBe(owner.guessed.id);
    expect(await db.supplierInvoiceAlias.count({ where: { supplierId: owner.supplier.id } })).toBe(0);
    const response = await confirm(upload.id, [line({ description: "FORGED CLIENT DESCRIPTION", sourceDescription: "FORGED CLIENT SOURCE" })]);
    expect(response.status).toBe(201);
    const saved = await db.supplierInvoiceAlias.findMany({ where: { supplierId: owner.supplier.id } });
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      ingredientId: owner.selected.id, sourceDescription: "GORDONS DRY 700ML", normalizedDescription: "gordons dry 700ml",
    });
    const next = await pending();
    const result = await (await read(next.id)).json();
    expect(result.match.lines[0]).toMatchObject({ matchSource: "alias", sourceLineIndex: 0, ingredient: { ingredient: { id: owner.selected.id } } });
    expect(scope.extract).not.toHaveBeenCalled();
    expect((await (await read(upload.id)).json()).match).toBeNull();
  });

  it("also applies stored aliases during upload after normalization, without another AI call", async () => {
    await alias();
    const raw = extraction();
    scope.extraction = { ...raw, lines: [{ ...raw.lines[0], description: " " }, ...raw.lines] };
    const form = new FormData();
    form.set("file", new File(["%PDF synthetic test only"], "fixture.pdf", { type: "application/pdf" }));
    const response = await uploadInvoice(new Request("http://localhost/api/operator/purchase-invoices", { method: "POST", body: form }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.extraction.lines).toHaveLength(2);
    expect(body.match.lines[0]).toMatchObject({ sourceLineIndex: 0, matchSource: "alias", ingredient: { ingredient: { id: owner.selected.id } } });
    const persisted = await db.purchaseInvoiceUpload.findUniqueOrThrow({ where: { id: body.uploadId } });
    expect(persisted.extraction).toEqual(body.extraction);
    expect(scope.extract).toHaveBeenCalledTimes(1);
  });

  it.each([false, undefined])("does not learn when rememberMatch is %s", async (rememberMatch) => {
    const upload = await pending();
    expect((await confirm(upload.id, [line({ rememberMatch, sourceLineIndex: undefined })])).status).toBe(201);
    expect(await db.supplierInvoiceAlias.count({ where: { supplierId: owner.supplier.id } })).toBe(0);
  });

  it("uses original indices after review reorder, deletion and manual added rows", async () => {
    const upload = await pending(["FIRST DELETED", "SECOND ORIGINAL", "THIRD ORIGINAL"]);
    const response = await confirm(upload.id, [
      line({ sourceLineIndex: 2 }),
      line({ sourceLineIndex: undefined, rememberMatch: false }),
      line({ ingredientId: owner.guessed.id, sourceLineIndex: 1 }),
    ]);
    expect(response.status).toBe(201);
    expect(await db.supplierInvoiceAlias.findMany({
      where: { supplierId: owner.supplier.id }, orderBy: { sourceDescription: "asc" },
      select: { sourceDescription: true, ingredientId: true },
    })).toEqual([
      { sourceDescription: "SECOND ORIGINAL", ingredientId: owner.guessed.id },
      { sourceDescription: "THIRD ORIGINAL", ingredientId: owner.selected.id },
    ]);
  });

  it.each([undefined, -1, 0.5, 20])("rejects an invalid remembered source index %s without any partial writes", async (sourceLineIndex) => {
    const upload = await pending();
    const response = await confirm(upload.id, [line({ sourceLineIndex })]);
    expect(response.status).toBe(400);
    expect(await db.purchaseOrder.count({ where: { restaurantId: owner.restaurant.id } })).toBe(0);
    expect(await db.supplierInvoiceAlias.count({ where: { supplierId: owner.supplier.id } })).toBe(0);
    expect((await db.purchaseInvoiceUpload.findUniqueOrThrow({ where: { id: upload.id } })).status).toBe("pending");
  });

  it.each(["", " \t ", "A".repeat(501)])("rejects an unusable original source description", async (description) => {
    const upload = await pending([description]);
    const response = await confirm(upload.id);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "alias_invalid" });
    expect(await db.purchaseOrder.count({ where: { restaurantId: owner.restaurant.id } })).toBe(0);
  });

  it("does not remember a newly created ingredient or an invalid stored extraction", async () => {
    const upload = await pending();
    expect((await confirm(upload.id, [line({ ingredientId: null, newIngredientName: "New ingredient" })])).status).toBe(400);
    expect(await db.ingredient.count({ where: { restaurantId: owner.restaurant.id } })).toBe(2);
    await db.purchaseInvoiceUpload.update({ where: { id: upload.id }, data: { extraction: {} } });
    expect((await confirm(upload.id)).status).toBe(400);
    expect((await (await read(upload.id)).json()).match).toBeNull();
    expect((await confirm(upload.id, [line({ rememberMatch: false })])).status).toBe(201);
  });

  it("rejects one description assigned to two ingredients, deduplicates agreement and allows later explicit correction", async () => {
    const upload = await pending(["GORDONS DRY 700ML", "gordons   dry 700ml"]);
    const invalid = await confirm(upload.id, [line(), line({ sourceLineIndex: 1, ingredientId: owner.guessed.id })]);
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: "alias_conflict" });
    expect(await db.purchaseOrder.count({ where: { restaurantId: owner.restaurant.id } })).toBe(0);
    expect((await confirm(upload.id, [line(), line({ sourceLineIndex: 1 })])).status).toBe(201);
    const first = await db.supplierInvoiceAlias.findFirstOrThrow({ where: { supplierId: owner.supplier.id } });
    expect(await db.supplierInvoiceAlias.count({ where: { supplierId: owner.supplier.id } })).toBe(1);
    const next = await pending();
    expect((await confirm(next.id, [line({ ingredientId: owner.guessed.id })])).status).toBe(201);
    expect(await db.supplierInvoiceAlias.findUniqueOrThrow({ where: { id: first.id } })).toMatchObject({ ingredientId: owner.guessed.id });
  });

  it("rolls back an alias update when order validation fails and preserves the earlier mapping", async () => {
    const original = await alias();
    const upload = await pending();
    const response = await confirm(upload.id, [line({ ingredientId: owner.guessed.id, expectedCostCents: 0, expectedTaxCents: 1 })]);
    expect(response.status).toBe(400);
    expect(await db.supplierInvoiceAlias.findUniqueOrThrow({ where: { id: original.id } })).toMatchObject({ ingredientId: owner.selected.id });
    expect((await db.purchaseInvoiceUpload.findUniqueOrThrow({ where: { id: upload.id } })).status).toBe("pending");
  });

  it("is atomic with receiving, and a retry never receives or remembers twice", async () => {
    const upload = await pending();
    const first = await confirm(upload.id, [line()], { mode: "receive" });
    expect(first.status).toBe(201);
    expect((await confirm(upload.id, [line({ ingredientId: owner.guessed.id })], { mode: "receive" })).status).toBe(409);
    expect(await db.stockMovement.findMany({ where: { restaurantId: owner.restaurant.id } })).toEqual([
      expect.objectContaining({ ingredientId: owner.selected.id, qtyBase: 1400, valueCents: 21000 }),
    ]);
    expect(await db.supplierInvoiceAlias.findMany({ where: { supplierId: owner.supplier.id } })).toEqual([
      expect.objectContaining({ ingredientId: owner.selected.id }),
    ]);
  });

  it("can remember against a newly created supplier while preserving the same existing ingredient", async () => {
    const upload = await pending();
    const response = await confirm(upload.id, [line()], { supplierId: null, newSupplierName: "A newly reviewed supplier", newSupplierNit: "123" });
    expect(response.status).toBe(201);
    const { order } = await response.json();
    expect(await db.supplierInvoiceAlias.findFirstOrThrow({ where: { supplierId: order.supplierId } })).toMatchObject({ ingredientId: owner.selected.id });
  });
});

describe("alias scope and catalog activity", () => {
  it("re-matches only an explicitly selected active owned supplier without writing or rereading AI", async () => {
    const other = await db.supplier.create({ data: { restaurantId: owner.restaurant.id, name: "Second supplier" } });
    await alias("GORDONS DRY 700ML", owner.selected.id, other.id);
    const upload = await pending();
    expect((await (await read(upload.id)).json()).match.lines[0].matchSource).toBe("name");
    const selected = await (await read(upload.id, other.id)).json();
    expect(selected.match.supplier.supplier.id).toBe(other.id);
    expect(selected.match.lines[0]).toMatchObject({ matchSource: "alias", ingredient: { ingredient: { id: owner.selected.id } } });
    for (const invalid of [foreign.supplier.id, "", "missing"]) {
      expect((await read(upload.id, invalid)).status).toBe(404);
    }
    await db.supplier.update({ where: { id: other.id }, data: { active: false } });
    expect((await read(upload.id, other.id)).status).toBe(404);
    expect(scope.extract).not.toHaveBeenCalled();
    expect(await db.purchaseOrder.count({ where: { restaurantId: owner.restaurant.id } })).toBe(0);
  });

  it("rejects foreign or archived suppliers and ingredients while keeping the upload pending", async () => {
    const upload = await pending();
    expect((await confirm(upload.id, [line()], { supplierId: foreign.supplier.id })).status).toBe(400);
    expect((await confirm(upload.id, [line({ ingredientId: foreign.selected.id })])).status).toBe(400);
    await db.supplier.update({ where: { id: owner.supplier.id }, data: { active: false } });
    expect((await confirm(upload.id)).status).toBe(400);
    await db.supplier.update({ where: { id: owner.supplier.id }, data: { active: true } });
    await db.ingredient.update({ where: { id: owner.selected.id }, data: { active: false } });
    expect((await confirm(upload.id)).status).toBe(400);
    expect((await db.purchaseInvoiceUpload.findUniqueOrThrow({ where: { id: upload.id } })).status).toBe("pending");
    expect(await db.supplierInvoiceAlias.count({ where: { supplierId: owner.supplier.id } })).toBe(0);
  });

  it.each(["archived", "foreign"] as const)("does not fall back to a similar ingredient when the remembered target is %s", async (kind) => {
    await alias("GORDONS DRY 700ML", kind === "foreign" ? foreign.selected.id : owner.selected.id);
    if (kind === "archived") await db.ingredient.update({ where: { id: owner.selected.id }, data: { active: false } });
    const upload = await pending();
    const body = await (await read(upload.id)).json();
    expect(body.match.lines[0]).toMatchObject({ aliasUnavailable: true, ingredient: { kind: "suggest_create" }, suggestedPresentation: null });
    expect(JSON.stringify(body.match)).not.toContain(foreign.selected.id);
  });

  it("prevents another tenant from reading, rematching or confirming the upload", async () => {
    await alias();
    const upload = await pending();
    scope.restaurantId = foreign.restaurant.id;
    expect((await read(upload.id)).status).toBe(404);
    expect((await read(upload.id, foreign.supplier.id)).status).toBe(404);
    expect((await confirm(upload.id)).status).toBe(404);
  });

  it("does not save anything when a pending invoice is discarded", async () => {
    const upload = await pending();
    const response = await discardInvoice(new Request(`http://localhost/api/operator/purchase-invoices/${upload.id}`, { method: "DELETE" }), { params: Promise.resolve({ id: upload.id }) });
    expect(response.status).toBe(200);
    expect((await confirm(upload.id)).status).toBe(409);
    expect((await (await read(upload.id)).json()).match).toBeNull();
    expect(await db.supplierInvoiceAlias.count({ where: { supplierId: owner.supplier.id } })).toBe(0);
  });
});

describe("supplier invoice aliases in restaurant backups", () => {
  it("exports and restores owned aliases with both parents, and leaves the other restaurant untouched", async () => {
    const saved = await alias();
    const otherAlias = await alias("FOREIGN SOURCE", foreign.selected.id, foreign.supplier.id);
    const backup = await createBackup({ restaurantId: owner.restaurant.id, kind: "manual" });
    expect(backup.tableCounts.SupplierInvoiceAlias).toBe(1);
    await db.supplierInvoiceAlias.update({ where: { id: saved.id }, data: { ingredientId: owner.guessed.id } });
    const result = await restoreSnapshot({ restaurantId: owner.restaurant.id, backupId: backup.id });
    expect(result.restored.SupplierInvoiceAlias).toBe(1);
    expect(await db.supplierInvoiceAlias.findUniqueOrThrow({ where: { id: saved.id } })).toMatchObject({ ingredientId: owner.selected.id });
    expect(await db.supplierInvoiceAlias.findUniqueOrThrow({ where: { id: otherAlias.id } })).toEqual(otherAlias);
  });

  it("supports older backups without aliases as an empty table", async () => {
    const backup = await createBackup({ restaurantId: owner.restaurant.id, kind: "manual" });
    const stored = await db.restaurantBackup.findUniqueOrThrow({ where: { id: backup.id } });
    const data = stored.data as unknown as SnapshotData;
    const tables = { ...data.tables };
    delete tables.SupplierInvoiceAlias;
    await db.restaurantBackup.update({ where: { id: backup.id }, data: { data: JSON.parse(JSON.stringify({ ...data, tables })) } });
    await alias();
    expect((await restoreSnapshot({ restaurantId: owner.restaurant.id, backupId: backup.id })).restored.SupplierInvoiceAlias).toBe(0);
    expect(await db.supplierInvoiceAlias.count({ where: { supplierId: owner.supplier.id } })).toBe(0);
  });

  it("does not export invalid cross-tenant aliases and prunes one inserted into a stored snapshot", async () => {
    await alias("INVALID FOREIGN TARGET", foreign.selected.id);
    const backup = await createBackup({ restaurantId: owner.restaurant.id, kind: "manual" });
    expect(backup.tableCounts.SupplierInvoiceAlias).toBe(0);
    const stored = await db.restaurantBackup.findUniqueOrThrow({ where: { id: backup.id } });
    const data = stored.data as unknown as SnapshotData;
    const malicious = {
      id: `invalid-${randomUUID()}`, supplierId: owner.supplier.id, ingredientId: foreign.selected.id,
      sourceDescription: "DO NOT RESTORE", normalizedDescription: "do not restore",
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    await db.restaurantBackup.update({ where: { id: backup.id }, data: { data: JSON.parse(JSON.stringify({ ...data, tables: { ...data.tables, SupplierInvoiceAlias: [malicious] } })) } });
    const result = await restoreSnapshot({ restaurantId: owner.restaurant.id, backupId: backup.id });
    expect(result.pruned.SupplierInvoiceAlias).toBe(1);
    expect(await db.supplierInvoiceAlias.findUnique({ where: { id: malicious.id } })).toBeNull();
    expect(await db.ingredient.findUnique({ where: { id: foreign.selected.id } })).not.toBeNull();
  });
});
