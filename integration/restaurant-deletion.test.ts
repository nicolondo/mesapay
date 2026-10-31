import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { Prisma } from "@prisma/client";
import { db } from "../src/lib/db";
import { createBackup } from "../src/lib/backups";
import { deleteRestaurant, getDeletionPreview, isRestaurantDeletionError } from "../src/lib/restaurantDeletion";

const url = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
if (!["127.0.0.1", "localhost"].includes(url.hostname) || !/^\/mesapay_.*(?:test|validation)$/.test(url.pathname)) {
  throw new Error("Isolated local database required");
}

const fixture = `del-${randomUUID().slice(0, 8)}`;
const actor = { id: null, email: `${fixture}-admin@example.test`, role: "platform_admin" };
let uploadDir: string;
let target: string;
let other: string;
const ids = {
  admin: "",
  operator: "",
  mesero: "",
  rep: "",
  order: "",
  orderItem: "",
  payment: "",
  journalLine: "",
  recipeItem: "",
  purchaseOrderItem: "",
  dinerSession: "",
  creditNoteSeries: "",
  membershipPayment: "",
  commission: "",
  crmLead: "",
  webhookEvent: "",
  oldAudit: "",
  otherOrder: "",
  otherShift: "",
  otherMenuItem: "",
};

async function upload(relative: string) {
  const absolute = path.join(uploadDir, relative);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, `fixture ${relative}`);
  return `/uploads/${relative}`;
}
const exists = (relative: string) =>
  stat(path.join(uploadDir, relative)).then(
    () => true,
    () => false,
  );

beforeAll(async () => {
  uploadDir = await mkdtemp(path.join(os.tmpdir(), "mesapay-delete-"));
  process.env.UPLOAD_DIR = uploadDir;

  target = (
    await db.restaurant.create({
      data: { slug: fixture, name: "Fixture a borrar", legalName: "Fixture SAS", taxId: "900111222", country: "CO", logoUrl: await upload("logo.webp") },
    })
  ).id;
  other = (await db.restaurant.create({ data: { slug: `${fixture}-other`, name: "Otro comercio" } })).id;

  ids.admin = (await db.user.create({ data: { email: `${fixture}-pa@example.test`, passwordHash: "x", role: "platform_admin", restaurantId: target } })).id;
  ids.operator = (await db.user.create({ data: { email: `${fixture}-op@example.test`, passwordHash: "x", role: "operator", restaurantId: target } })).id;
  ids.mesero = (await db.user.create({ data: { email: `${fixture}-me@example.test`, passwordHash: "x", role: "mesero", restaurantId: target } })).id;
  ids.rep = (await db.user.create({ data: { email: `${fixture}-rep@example.test`, passwordHash: "x", role: "comercial" } })).id;
  await db.restaurant.update({ where: { id: target }, data: { salesRepUserId: ids.rep } });
  await db.passwordResetToken.create({ data: { tokenHash: `${fixture}-t`, userId: ids.operator, expiresAt: new Date(Date.now() + 3600_000) } });
  await db.pushSubscription.create({ data: { userId: ids.admin, restaurantId: target, endpoint: `https://push.example.test/${fixture}`, p256dh: "k", auth: "a" } });

  // Salón y venta.
  const table = await db.table.create({ data: { restaurantId: target, number: 1, qrToken: randomUUID() } });
  const category = await db.category.create({ data: { restaurantId: target, slug: "platos", label: "Platos" } });
  const shared = await upload("shared.webp");
  const menuItem = await db.menuItem.create({
    data: { restaurantId: target, categoryId: category.id, name: "Bandeja", priceCents: 10000, photoUrl: await upload("plato.webp") },
  });
  await db.menuItem.create({ data: { restaurantId: target, categoryId: category.id, name: "Ajiaco", priceCents: 9000, photoUrl: shared } });
  const diner = await db.diner.create({ data: { restaurantId: target, email: "comensal@example.test", passwordHash: "x" } });
  ids.dinerSession = (await db.dinerSession.create({ data: { tokenHash: `${fixture}-ds`, dinerId: diner.id } })).id;
  const order = await db.order.create({
    data: { restaurantId: target, tableId: table.id, shortCode: randomUUID(), status: "paid", subtotalCents: 10000, totalCents: 10000, dinerId: diner.id, paidAt: new Date() },
  });
  ids.order = order.id;
  const round = await db.round.create({ data: { orderId: order.id, seq: 1, placedByUserId: ids.mesero } });
  ids.orderItem = (await db.orderItem.create({ data: { orderId: order.id, roundId: round.id, menuItemId: menuItem.id, nameSnapshot: "Bandeja", priceCentsSnapshot: 10000 } })).id;
  const shift = await db.shift.create({ data: { restaurantId: target, openedById: ids.operator, openingCashCents: BigInt(0) } });
  ids.payment = (
    await db.payment.create({ data: { orderId: order.id, method: "cash", status: "approved", amountCents: 10000, shiftId: shift.id, collectedByUserId: ids.mesero } })
  ).id;
  await db.financialOperation.create({ data: { key: `${fixture}-op`, paymentId: ids.payment, kind: "terminal", amountCents: 10000, status: "completed" } });
  await db.cashMovement.create({ data: { restaurantId: target, kind: "egreso", amountCents: 500, concept: "Hielo", createdById: ids.operator, shiftId: shift.id } });

  // Facturación: tirilla + factura DIAN aceptada + nota crédito aceptada (FK RESTRICT al comercio).
  const invoice = await db.simpleInvoice.create({
    data: { restaurantId: target, orderId: order.id, invoiceNumber: 7, totalCents: 10000, snapshot: { invoicePrefix: "FX" } },
  });
  await db.dianDocument.create({
    data: {
      restaurantId: target, orderId: order.id, simpleInvoiceId: invoice.id, kind: "invoice", state: "accepted", cufe: "c".repeat(96),
      xmlZip: new Uint8Array(await new JSZip().file("fv.xml", "<Invoice/>").generateAsync({ type: "nodebuffer" })),
      responseXml: "<ApplicationResponse/>", issuedAt: new Date(),
    },
  });
  // environment "2" = habilitación (CHECK de la serie); el prefijo, [A-Z0-9].
  const series = await db.creditNoteSeries.create({ data: { issuerNit: `9${Date.now()}`.slice(0, 10), environment: "2", prefix: fixture.slice(-6).toUpperCase(), nextNumber: 2 } });
  ids.creditNoteSeries = series.id;
  const note = await db.creditNote.create({
    data: {
      fiscalKey: `${fixture}-fk`, restaurantId: target, originalInvoiceId: invoice.id, seriesId: series.id, number: 1,
      documentNumber: `${series.prefix}1`, requestId: randomUUID(), requestHash: "h", reasonCode: "2", reasonText: "Anulación",
      snapshot: { version: 1 }, subtotalCents: 10000, taxCents: 0, totalCents: 10000,
    },
  });
  await db.dianDocument.create({
    data: { restaurantId: target, creditNoteId: note.id, kind: "credit_note", state: "accepted", cufe: "d".repeat(96), responseXml: "<Response/>", deliveryXml: "<AttachedDocument/>", issuedAt: new Date() },
  });
  await db.dianConfig.create({ data: { restaurantId: target, environment: "habilitacion", certP12Enc: Buffer.from("secret-cert"), softwarePinEnc: "secret-pin" } });

  // ERP: inventario, receta (RESTRICT al insumo), compras, contabilidad (RESTRICT a la cuenta), staff.
  const ingredient = await db.ingredient.create({ data: { restaurantId: target, name: "Arroz", measureKind: "mass" } });
  const recipe = await db.recipe.create({ data: { restaurantId: target, menuItemId: menuItem.id } });
  ids.recipeItem = (await db.recipeItem.create({ data: { recipeId: recipe.id, ingredientId: ingredient.id, qtyBase: 100 } })).id;
  const supplier = await db.supplier.create({ data: { restaurantId: target, name: "Proveedor" } });
  const po = await db.purchaseOrder.create({ data: { restaurantId: target, supplierId: supplier.id, number: 1 } });
  ids.purchaseOrderItem = (await db.purchaseOrderItem.create({ data: { purchaseOrderId: po.id, ingredientId: ingredient.id, qtyOrderedBase: 1000, expectedCostCents: 5000 } })).id;
  await db.purchaseInvoiceUpload.create({ data: { restaurantId: target, fileUrl: await upload("factura-abc.pdf"), extraction: {}, purchaseOrderId: po.id } });
  const account = await db.ledgerAccount.create({ data: { restaurantId: target, code: "110505", name: "Caja", type: "activo", nature: "debito", level: 4 } });
  const entry = await db.journalEntry.create({
    data: { restaurantId: target, date: new Date(), source: "manual", lines: { create: [{ accountId: account.id, accountCode: "110505", debitCents: 100, creditCents: 0 }] } },
    include: { lines: true },
  });
  ids.journalLine = entry.lines[0].id;
  const employee = await db.employee.create({ data: { restaurantId: target, name: "Ana", position: "Mesera", userId: ids.mesero } });
  await db.staffShift.create({
    data: { restaurantId: target, employeeId: employee.id, date: new Date(), startMinutes: 480, endMinutes: 960, checkInPhotoUrl: await upload("marcacion.jpg") },
  });
  await db.printer.create({ data: { restaurantId: target, label: "Cocina", host: "10.0.0.5" } });

  // Plataforma: alta Kushki, débito cancelado, mensualidad + comisión, CRM, webhooks, auditoría.
  await db.kushkiDocument.create({
    data: { restaurantId: target, kind: "rut", fileUrl: await upload(`onboarding/${target}_rut.pdf`), fileName: "rut.pdf", mimeType: "application/pdf", fileSize: 10, uploadedById: ids.operator },
  });
  await db.billingSubscription.create({ data: { restaurantId: target, plan: "basic", amountCents: 100000, currency: "COP", status: "canceled" } });
  const membership = await db.membershipPayment.create({
    data: { restaurantId: target, amountCents: 100000, method: "manual_transfer", periodStart: new Date(), periodEnd: new Date(), recordedByEmail: actor.email },
  });
  ids.membershipPayment = membership.id;
  ids.commission = (
    await db.commissionEntry.create({ data: { salesRepUserId: ids.rep, restaurantId: target, membershipPaymentId: membership.id, baseAmountCents: 100000, bps: 1000, amountCents: 10000 } })
  ).id;
  ids.crmLead = (await db.crmLead.create({ data: { name: "Lead", countryCode: "CO", assignedToUserId: ids.rep, createdByUserId: ids.rep, restaurantId: target } })).id;
  ids.webhookEvent = (await db.kushkiWebhookEvent.create({ data: { eventId: `${fixture}-wh`, type: "charge.approved", payload: {}, restaurantId: target } })).id;
  ids.oldAudit = (
    await db.auditEvent.create({ data: { actorEmail: actor.email, actorRole: "operator", kind: "order.cancel", summary: "Canceló", restaurantId: target } })
  ).id;
  await createBackup({ restaurantId: target, kind: "manual" });

  // Otro comercio: comparte una foto y tiene un turno abierto por el mesero del comercio a borrar.
  const otherTable = await db.table.create({ data: { restaurantId: other, number: 1, qrToken: randomUUID() } });
  const otherCategory = await db.category.create({ data: { restaurantId: other, slug: "platos", label: "Platos" } });
  ids.otherMenuItem = (await db.menuItem.create({ data: { restaurantId: other, categoryId: otherCategory.id, name: "Ajiaco", priceCents: 9000, photoUrl: shared } })).id;
  ids.otherOrder = (await db.order.create({ data: { restaurantId: other, tableId: otherTable.id, shortCode: randomUUID() } })).id;
  ids.otherShift = (await db.shift.create({ data: { restaurantId: other, openedById: ids.mesero, openingCashCents: BigInt(0) } })).id;
}, 60_000);

afterAll(async () => {
  const steps = [
    () => db.shift.deleteMany({ where: { restaurantId: other } }),
    () => db.order.deleteMany({ where: { restaurantId: { in: [target, other] } } }),
    () => db.restaurant.deleteMany({ where: { id: { in: [target, other] } } }),
    () => db.commissionEntry.deleteMany({ where: { id: ids.commission } }),
    () => db.membershipPayment.deleteMany({ where: { id: ids.membershipPayment } }),
    () => db.crmLead.deleteMany({ where: { id: ids.crmLead } }),
    () => db.kushkiWebhookEvent.deleteMany({ where: { id: ids.webhookEvent } }),
    () => db.auditEvent.deleteMany({ where: { OR: [{ id: ids.oldAudit }, { targetId: target }, { actorEmail: actor.email }] } }),
    () => db.deletedRestaurantArchive.deleteMany({ where: { deletedRestaurantId: target } }),
    () => db.user.deleteMany({ where: { email: { startsWith: fixture } } }),
    () => db.creditNoteSeries.deleteMany({ where: { id: ids.creditNoteSeries } }),
    () => db.platformEvent.deleteMany({ where: { restaurantId: { in: [target, other] } } }),
  ];
  try {
    for (const step of steps) await step().catch(() => undefined);
    await rm(uploadDir, { recursive: true, force: true });
  } finally {
    await db.$disconnect();
  }
});

/** Filas con restaurantId = el comercio, en TODOS los modelos que tienen esa columna. */
async function rowsOfTarget(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const m of Prisma.dmmf.datamodel.models) {
    if (!m.fields.some((f) => f.kind === "scalar" && f.name === "restaurantId")) continue;
    const d = (db as unknown as Record<string, { count(a: unknown): Promise<number> }>)[m.name.charAt(0).toLowerCase() + m.name.slice(1)];
    const n = await d.count({ where: { restaurantId: target } });
    if (n) out[m.name] = n;
  }
  return out;
}

async function deletionError(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (isRestaurantDeletionError(error)) return error;
    throw error;
  }
  throw new Error("expected the deletion to fail");
}

describe("eliminar un comercio en PostgreSQL", () => {
  it("el resumen cuenta lo que se va a borrar", async () => {
    const preview = await getDeletionPreview(target);
    expect(preview?.counts).toMatchObject({ orders: 1, payments: 1, invoices: 1, dianInvoices: 1, creditNotes: 1, users: 3, ingredients: 1, journalEntries: 1 });
    expect(preview?.counts.files).toBeGreaterThanOrEqual(6);
    expect(preview?.blockers).toEqual([]);
    expect(preview?.warnings.map((w) => w.code)).toContain("platform_users_detached");
  }, 60_000);

  it("con un cobro pendiente, bloquea y no borra nada", async () => {
    // Monto 0: el trigger reserve_payment no lo frena aunque la cuenta ya esté cobrada.
    const pending = await db.payment.create({ data: { orderId: ids.order, method: "cash", status: "pending", amountCents: 0 } });
    const error = await deletionError(deleteRestaurant({ restaurantId: target, confirmSlug: fixture, actor }));
    expect(error.code).toBe("blocked");
    expect(error.details.blockers?.map((b) => b.code)).toContain("payments_pending");
    await db.payment.delete({ where: { id: pending.id } });
    expect(await db.restaurant.count({ where: { id: target } })).toBe(1);
    expect(await db.deletedRestaurantArchive.count({ where: { deletedRestaurantId: target } })).toBe(0);
  }, 60_000);

  it("con el slug incorrecto no borra nada", async () => {
    const error = await deletionError(deleteRestaurant({ restaurantId: target, confirmSlug: fixture.toUpperCase(), actor }));
    expect(error.code).toBe("confirm_mismatch");
    expect(await db.restaurant.count({ where: { id: target } })).toBe(1);
  });

  it("si el export falla, no borra nada (ni filas, ni archivos, ni deja archivo final)", async () => {
    const before = await rowsOfTarget();
    await expect(
      deleteRestaurant({
        restaurantId: target,
        confirmSlug: fixture,
        actor,
        readUpload: async () => {
          throw Object.assign(new Error("permission denied"), { code: "EACCES" });
        },
      }),
    ).rejects.toThrow("permission denied");
    expect(await rowsOfTarget()).toEqual(before);
    expect(await db.deletedRestaurantArchive.count({ where: { deletedRestaurantId: target } })).toBe(0);
    expect(await exists("plato.webp")).toBe(true);
  }, 60_000);

  it("borra TODO lo del comercio, conserva lo de plataforma y deja un archivo final que sobrevive", async () => {
    const adminBefore = await db.user.findUniqueOrThrow({ where: { id: ids.admin }, select: { sessionVersion: true } });
    const seriesBefore = await db.creditNoteSeries.findUniqueOrThrow({ where: { id: ids.creditNoteSeries } });
    const result = await deleteRestaurant({ restaurantId: target, confirmSlug: fixture, actor });

    // Ninguna fila con restaurantId = el comercio, en ninguna tabla; ni hijos sueltos.
    expect(await rowsOfTarget()).toEqual({});
    expect(await db.restaurant.count({ where: { id: target } })).toBe(0);
    expect(await db.orderItem.count({ where: { id: ids.orderItem } })).toBe(0);
    expect(await db.payment.count({ where: { id: ids.payment } })).toBe(0);
    expect(await db.financialOperation.count({ where: { paymentId: ids.payment } })).toBe(0);
    expect(await db.journalLine.count({ where: { id: ids.journalLine } })).toBe(0);
    expect(await db.recipeItem.count({ where: { id: ids.recipeItem } })).toBe(0);
    expect(await db.purchaseOrderItem.count({ where: { id: ids.purchaseOrderItem } })).toBe(0);
    expect(await db.dinerSession.count({ where: { id: ids.dinerSession } })).toBe(0);

    // Usuarios: el platform_admin y el comercial quedan; el operador se va; el mesero con un turno en otro comercio queda desactivado.
    const admin = await db.user.findUniqueOrThrow({ where: { id: ids.admin } });
    expect(admin.restaurantId).toBeNull();
    expect(admin.sessionVersion).toBeGreaterThan(adminBefore.sessionVersion);
    expect(await db.user.count({ where: { id: ids.operator } })).toBe(0);
    expect(await db.passwordResetToken.count({ where: { userId: ids.operator } })).toBe(0);
    const mesero = await db.user.findUniqueOrThrow({ where: { id: ids.mesero } });
    expect(mesero.restaurantId).toBeNull();
    expect(mesero.disabledAt).not.toBeNull();
    expect(await db.user.count({ where: { id: ids.rep } })).toBe(1);
    expect(result.summary).toMatchObject({ usersDeleted: 1, usersDetached: 1, usersDisabled: 1, orders: 1, creditNotes: 1 });

    // Registros de plataforma: se conservan, sin vínculo.
    expect(await db.membershipPayment.findUniqueOrThrow({ where: { id: ids.membershipPayment } })).toMatchObject({ restaurantId: null, deletedRestaurantName: "Fixture a borrar" });
    expect(await db.commissionEntry.findUniqueOrThrow({ where: { id: ids.commission } })).toMatchObject({ restaurantId: null, deletedRestaurantName: "Fixture a borrar" });
    expect((await db.crmLead.findUniqueOrThrow({ where: { id: ids.crmLead } })).restaurantId).toBeNull();
    expect((await db.kushkiWebhookEvent.findUniqueOrThrow({ where: { id: ids.webhookEvent } })).restaurantId).toBeNull();
    expect((await db.auditEvent.findUniqueOrThrow({ where: { id: ids.oldAudit } })).restaurantId).toBeNull();
    expect((await db.creditNoteSeries.findUniqueOrThrow({ where: { id: ids.creditNoteSeries } })).nextNumber).toBe(seriesBefore.nextNumber);
    const audit = await db.auditEvent.findFirstOrThrow({ where: { kind: "restaurant.delete", targetId: target } });
    expect(audit).toMatchObject({ restaurantId: null, actorEmail: actor.email });

    // El otro comercio, intacto.
    expect(await db.order.count({ where: { id: ids.otherOrder } })).toBe(1);
    expect(await db.shift.count({ where: { id: ids.otherShift } })).toBe(1);
    expect(await db.menuItem.count({ where: { id: ids.otherMenuItem } })).toBe(1);

    // Archivo final: fila de plataforma con el ZIP completo.
    const archive = await db.deletedRestaurantArchive.findUniqueOrThrow({ where: { id: result.archiveId } });
    expect(archive).toMatchObject({ deletedRestaurantId: target, slug: fixture, taxId: "900111222", deletedByEmail: actor.email });
    const zip = await JSZip.loadAsync(archive.archive);
    const data = JSON.parse(await zip.file("data/restaurant.json")!.async("string"));
    expect(data.snapshot.version).toBe(1);
    expect(data.snapshot.tables.Order.map((o: { id: string }) => o.id)).toEqual([ids.order]);
    expect(data.snapshot.tables.CreditNote).toHaveLength(1);
    expect(data.platform.MembershipPayment).toHaveLength(1);
    expect(data.platform.FinancialOperation).toHaveLength(1);
    expect(data.platform.DianConfig[0]).toMatchObject({ certP12Enc: null, softwarePinEnc: null });
    expect(JSON.stringify(data)).not.toContain("secret-pin");
    expect(zip.file("fiscal/invoices/FX7/signed-xml.zip")).not.toBeNull();
    expect(await zip.file("fiscal/invoices/FX7/dian-response.xml")!.async("string")).toBe("<ApplicationResponse/>");
    expect(Object.keys(zip.files).some((n) => n.startsWith("fiscal/credit-notes/") && n.endsWith("attached-document.xml"))).toBe(true);
    expect(await zip.file("files/purchase-invoices/factura-abc.pdf")!.async("string")).toBe("fixture factura-abc.pdf");
    expect(zip.file(`files/onboarding/${target}_rut.pdf`)).not.toBeNull();

    // Disco: lo del comercio se borró después del commit; la foto compartida queda.
    for (const gone of ["logo.webp", "plato.webp", "factura-abc.pdf", "marcacion.jpg", `onboarding/${target}_rut.pdf`]) {
      expect(await exists(gone), gone).toBe(false);
    }
    expect(await readFile(path.join(uploadDir, "shared.webp"), "utf8")).toBe("fixture shared.webp");
    expect(result.files).toMatchObject({ failed: 0, kept: 1 });
  }, 120_000);
});
