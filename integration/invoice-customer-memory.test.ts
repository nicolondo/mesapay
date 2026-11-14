// "Recordar mis datos" de la factura personalizada, contra PostgreSQL real
// (BD `*_test` propia). Lo que se prueba acá son las reglas que dependen de
// la base: aislamiento por comercio, filas viejas sin normalizar, quién
// sobrescribe qué (con la escritura condicionada), la casilla desmarcada,
// el token de un solo uso y la auditoría sin valores. Datos inventados.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("../src/auth", () => ({ auth: async () => null }));

import { db } from "../src/lib/db";
import {
  consumeLookupToken,
  createLookupToken,
  findSavedCustomer,
  rememberInvoiceCustomer,
} from "../src/lib/invoiceCustomerMemoryQueries";
import type { InvoiceRequestFields } from "../src/lib/invoiceRequestInput";

const url = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
if (!["127.0.0.1", "localhost"].includes(url.hostname) || !/^\/mesapay_.*(?:test|validation)$/.test(url.pathname)) {
  throw new Error("Isolated local database required");
}
process.env.AUTH_SECRET ??= "integration-test-only";

const tenants: string[] = [];
const orders: string[] = [];

function fields(over: Partial<InvoiceRequestFields> = {}): InvoiceRequestFields {
  return {
    customerName: "Ana Prueba",
    docType: "CC",
    docNumber: "7700112233",
    address: null,
    city: null,
    department: null,
    email: "ana@prueba.test",
    ccEmails: [],
    ...over,
  };
}

beforeAll(async () => {
  for (let i = 0; i < 2; i++) {
    const restaurant = await db.restaurant.create({ data: { name: "Fixture memoria", slug: `memoria-${randomUUID()}` } });
    tenants.push(restaurant.id);
    const table = await db.table.create({ data: { restaurantId: restaurant.id, number: 1, qrToken: randomUUID() } });
    for (let j = 0; j < 2; j++) {
      const order = await db.order.create({ data: { restaurantId: restaurant.id, tableId: table.id, shortCode: randomUUID(), status: "served", subtotalCents: 10000, totalCents: 10000 } });
      orders.push(order.id);
    }
  }
});

afterAll(async () => {
  await db.auditEvent.deleteMany({ where: { restaurantId: { in: tenants } } });
  await db.restaurant.deleteMany({ where: { id: { in: tenants } } });
  await db.$disconnect();
});

describe("memoria de clientes de facturación en PostgreSQL", () => {
  it("el comensal guarda sus datos (de autoservicio, con constancia de autorización y auditoría sin valores)", async () => {
    const outcome = await rememberInvoiceCustomer({ restaurantId: tenants[0], orderId: orders[0], actor: "diner", remember: true, fields: fields(), ccEmailsProvided: false });
    expect(outcome).toMatchObject({ kind: "create", selfService: true });
    const saved = await db.billingCustomer.findUniqueOrThrow({ where: { id: outcome.customerId } });
    expect(saved).toMatchObject({ restaurantId: tenants[0], docNumber: "7700112233", email: "ana@prueba.test", selfService: true, creditEnabled: false, discountEnabled: false });
    expect(saved.rememberConsentAt).toBeInstanceOf(Date);
    const audit = await db.auditEvent.findFirstOrThrow({ where: { restaurantId: tenants[0], targetId: saved.id } });
    expect(audit).toMatchObject({ kind: "billing_customer.self_service.create", actorRole: "diner" });
    expect(JSON.stringify(audit)).not.toContain("7700112233");
    expect(JSON.stringify(audit)).not.toContain("ana@prueba.test");
  });

  it("aislamiento: el mismo documento en otro comercio no existe", async () => {
    expect(await findSavedCustomer(tenants[1], "CC", "7700112233")).toBeNull();
    expect((await findSavedCustomer(tenants[0], "CC", "7700112233"))?.customerName).toBe("Ana Prueba");
  });

  it("el comensal actualiza SU registro de autoservicio", async () => {
    const outcome = await rememberInvoiceCustomer({ restaurantId: tenants[0], orderId: orders[0], actor: "diner", remember: true, fields: fields({ email: "ana.nueva@prueba.test" }), ccEmailsProvided: false });
    expect(outcome).toMatchObject({ kind: "update", fields: ["email"] });
    expect((await findSavedCustomer(tenants[0], "CC", "7700112233"))?.email).toBe("ana.nueva@prueba.test");
  });

  it("el comensal NO sobrescribe un cliente creado por el personal", async () => {
    await db.billingCustomer.create({ data: { restaurantId: tenants[0], customerName: "Empresa del Personal S.A.S.", docType: "NIT", docNumber: "900111222", verificationDigit: "1", email: "facturas@empresa.test" } });
    const outcome = await rememberInvoiceCustomer({ restaurantId: tenants[0], orderId: orders[0], actor: "diner", remember: true, fields: fields({ docType: "NIT", docNumber: "900111222", customerName: "Un Desconocido", email: "atacante@prueba.test" }), ccEmailsProvided: false });
    expect(outcome).toEqual({ kind: "none", reason: "protected", customerId: expect.any(String) });
    const row = await findSavedCustomer(tenants[0], "NIT", "900111222");
    expect(row).toMatchObject({ customerName: "Empresa del Personal S.A.S.", email: "facturas@empresa.test" });
    // Desmarcar tampoco lo esconde: es del personal.
    await rememberInvoiceCustomer({ restaurantId: tenants[0], orderId: orders[0], actor: "diner", remember: false, fields: fields({ docType: "NIT", docNumber: "900111222" }), ccEmailsProvided: false });
    expect(await findSavedCustomer(tenants[0], "NIT", "900111222", { forDiner: true })).not.toBeNull();
  });

  it("si el personal le da crédito a un registro de autoservicio, el comensal ya no lo cambia", async () => {
    const own = await rememberInvoiceCustomer({ restaurantId: tenants[0], orderId: orders[0], actor: "diner", remember: true, fields: fields({ docNumber: "7700445566", email: "credito@prueba.test" }), ccEmailsProvided: false });
    await db.billingCustomer.update({ where: { id: own.customerId }, data: { creditEnabled: true } });
    const outcome = await rememberInvoiceCustomer({ restaurantId: tenants[0], orderId: orders[0], actor: "diner", remember: true, fields: fields({ docNumber: "7700445566", email: "otro@prueba.test" }), ccEmailsProvided: false });
    expect(outcome.kind).toBe("none");
    expect((await db.billingCustomer.findUniqueOrThrow({ where: { id: own.customerId } })).email).toBe("credito@prueba.test");
  });

  it("el administrador corrige cualquiera, con correos adicionales, y queda como del personal", async () => {
    const outcome = await rememberInvoiceCustomer({ restaurantId: tenants[0], orderId: orders[0], actor: "manager", remember: true, fields: fields({ email: "ana.oficial@prueba.test", ccEmails: ["conta@prueba.test"] }), ccEmailsProvided: true });
    expect(outcome).toMatchObject({ kind: "update", selfService: false });
    const row = await db.billingCustomer.findUniqueOrThrow({ where: { id: outcome.customerId } });
    expect(row).toMatchObject({ email: "ana.oficial@prueba.test", ccEmails: ["conta@prueba.test"], selfService: false });
    // Desde ahí el comensal ya no lo cambia.
    const after = await rememberInvoiceCustomer({ restaurantId: tenants[0], orderId: orders[0], actor: "diner", remember: true, fields: fields({ email: "ana@prueba.test" }), ccEmailsProvided: false });
    expect(after).toMatchObject({ kind: "none", reason: "protected" });
  });

  it("casilla desmarcada: no se crea nada, y un registro de autoservicio deja de ofrecerse al comensal", async () => {
    const none = await rememberInvoiceCustomer({ restaurantId: tenants[1], orderId: orders[2], actor: "diner", remember: false, fields: fields({ docNumber: "7700998877" }), ccEmailsProvided: false });
    expect(none).toEqual({ kind: "none", reason: "not_remembered" });
    expect(await db.billingCustomer.count({ where: { restaurantId: tenants[1] } })).toBe(0);

    await rememberInvoiceCustomer({ restaurantId: tenants[1], orderId: orders[2], actor: "diner", remember: true, fields: fields({ docNumber: "7700998877" }), ccEmailsProvided: false });
    const optOut = await rememberInvoiceCustomer({ restaurantId: tenants[1], orderId: orders[2], actor: "diner", remember: false, fields: fields({ docNumber: "7700998877" }), ccEmailsProvided: false });
    expect(optOut.kind).toBe("opt_out");
    expect(await findSavedCustomer(tenants[1], "CC", "7700998877", { forDiner: true })).toBeNull();
    // El personal lo sigue viendo (es un registro del comercio), y volver a
    // marcar la casilla lo reactiva.
    expect(await findSavedCustomer(tenants[1], "CC", "7700998877")).not.toBeNull();
    await rememberInvoiceCustomer({ restaurantId: tenants[1], orderId: orders[2], actor: "diner", remember: true, fields: fields({ docNumber: "7700998877" }), ccEmailsProvided: false });
    expect(await findSavedCustomer(tenants[1], "CC", "7700998877", { forDiner: true })).not.toBeNull();
  });

  it("encuentra filas viejas guardadas con puntos o con DV, sin crear un duplicado", async () => {
    await db.billingCustomer.create({ data: { restaurantId: tenants[1], customerName: "Cliente Viejo", docType: "NIT", docNumber: "800.222.333-4", email: "viejo@prueba.test" } });
    expect((await findSavedCustomer(tenants[1], "NIT", "800222333"))?.customerName).toBe("Cliente Viejo");
    const outcome = await rememberInvoiceCustomer({ restaurantId: tenants[1], orderId: orders[2], actor: "diner", remember: true, fields: fields({ docType: "NIT", docNumber: "800222333", customerName: "Otro" }), ccEmailsProvided: false });
    expect(outcome.kind).toBe("none");
    expect(await db.billingCustomer.count({ where: { restaurantId: tenants[1], docType: "NIT" } })).toBe(1);
  });

  it("token de \"Usar estos datos\": de un solo uso, de esa orden y de ese comercio", async () => {
    const customer = await findSavedCustomer(tenants[0], "CC", "7700112233");
    const token = await createLookupToken(tenants[0], orders[0], customer!.id);
    expect(await db.invoiceCustomerLookup.count({ where: { tokenHash: token } })).toBe(0);
    // Otra orden u otro comercio: no.
    expect(await consumeLookupToken(token, tenants[0], orders[1])).toEqual({ ok: false, error: "saved_customer_expired" });
    expect(await consumeLookupToken(token, tenants[1], orders[0])).toEqual({ ok: false, error: "saved_customer_expired" });
    // Dos canjes a la vez: sólo uno gana.
    const [a, b] = await Promise.all([consumeLookupToken(token, tenants[0], orders[0]), consumeLookupToken(token, tenants[0], orders[0])]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(await consumeLookupToken(token, tenants[0], orders[0])).toEqual({ ok: false, error: "saved_customer_expired" });

    const stale = await createLookupToken(tenants[0], orders[0], customer!.id);
    await db.invoiceCustomerLookup.updateMany({ where: { orderId: orders[0], usedAt: null }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await consumeLookupToken(stale, tenants[0], orders[0])).toEqual({ ok: false, error: "saved_customer_expired" });
  });
});
