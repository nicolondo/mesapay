import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../src/lib/db";
import { billingCustomerSchema } from "../src/lib/billingCustomers";

const url = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
if (!["127.0.0.1", "localhost"].includes(url.hostname) || !/^\/mesapay_.*(?:test|validation)$/.test(url.pathname)) {
  throw new Error("Isolated local database required");
}
const tenants: string[] = [];
const contact = billingCustomerSchema.parse({ customerName: "Fixture customer", docType: "NIT", docNumber: "901944469-1", email: "customer@example.test", address: "Calle 10 # 20-30", municipalityCode: "05001" });
beforeAll(async () => {
  for (let i = 0; i < 2; i++) {
    const restaurant = await db.restaurant.create({ data: { name: "Fixture billing customers", slug: `billing-${randomUUID()}` } });
    tenants.push(restaurant.id);
  }
});
afterAll(async () => {
  await db.restaurant.deleteMany({ where: { id: { in: tenants } } });
  await db.$disconnect();
});

describe("billing customer tenant invariants on PostgreSQL", () => {
  it("allows only one canonical document under concurrent creates", async () => {
    const results = await Promise.allSettled([
      db.billingCustomer.create({ data: { ...contact, restaurantId: tenants[0] } }),
      db.billingCustomer.create({ data: { ...contact, restaurantId: tenants[0] } }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.billingCustomer.count({ where: { restaurantId: tenants[0] } })).toBe(1);
    expect(await db.diner.count({ where: { restaurantId: tenants[0] } })).toBe(0);
  });
  it("supports the same document in another restaurant and rejects cross-tenant updates", async () => {
    const customer = await db.billingCustomer.create({ data: { ...contact, restaurantId: tenants[1] } });
    await expect(db.billingCustomer.update({ where: { id: customer.id, restaurantId: tenants[0] }, data: { customerName: "Forbidden change" } })).rejects.toMatchObject({ code: "P2025" });
    expect((await db.billingCustomer.findUniqueOrThrow({ where: { id: customer.id } })).customerName).toBe(contact.customerName);
  });
  it("keeps existing invoice snapshots unchanged when a billing contact is edited", async () => {
    const restaurantId = tenants[0];
    const customer = await db.billingCustomer.findFirstOrThrow({ where: { restaurantId } });
    const table = await db.table.create({ data: { restaurantId, number: 1, qrToken: randomUUID() } });
    const order = await db.order.create({ data: { restaurantId, tableId: table.id, shortCode: randomUUID(), status: "paid", subtotalCents: 10000, totalCents: 10000 } });
    const invoice = await db.invoiceRequest.create({ data: { restaurantId, orderId: order.id, customerName: customer.customerName, docType: customer.docType, docNumber: `${customer.docNumber}-${customer.verificationDigit}`, email: customer.email, address: customer.address, city: customer.city, department: customer.department, status: "generated" } });
    await db.billingCustomer.update({ where: { id: customer.id, restaurantId }, data: { customerName: "New billing name", address: "Calle nueva 123" } });
    expect(await db.invoiceRequest.findUniqueOrThrow({ where: { id: invoice.id } })).toMatchObject({ customerName: contact.customerName, address: contact.address, docNumber: "901944469-1" });
  });
});
