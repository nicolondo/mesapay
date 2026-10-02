import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import JSZip from "jszip";
import { randomUUID } from "node:crypto";
import { buildDianInvoiceXml } from "../src/lib/dian/ubl";
import { originalInvoiceInput } from "../src/lib/dian/__fixtures__/creditNote";
import es from "../messages/es.json";

const base = process.env.PLAYWRIGHT_BASE_URL ?? "";
const database = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
test.skip(!/^http:\/\/localhost:/.test(base) || !["localhost", "127.0.0.1"].includes(database.hostname) || !/^\/mesapay_.*(?:validation|test)$/.test(database.pathname), "Isolated local app/database required");
const db = new PrismaClient();
const t = es.opCreditNotes;
test.setTimeout(120_000);
async function login(page: Page, email: string, password: string) {
  await page.route(/^https?:\/\//, route => ["localhost", "127.0.0.1"].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
  await page.goto(`${base}/signin`);
  await page.getByLabel("Correo", { exact: true }).fill(email);
  await page.getByLabel("Contraseña", { exact: true }).fill(password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(url => !url.pathname.startsWith("/signin"));
}

test("real credit APIs reserve safely and deliver accepted fixture PDF and QR over HTTP", async ({ page, browser }) => {
  const key = randomUUID(); const password = `Credit-${key}`;
  const prefix = `E${key.replaceAll("-", "").slice(0, 8).toUpperCase()}`;
  const restaurant = await db.restaurant.create({ data: { name: "Credit note real API · SIN VALIDEZ FISCAL", slug: `credit-api-${key}`, taxId: originalInvoiceInput.supplier.companyId, invoicePrefix: "FE", enabledModules: ["einvoicing"], dianConfig: { create: { creditNotePrefix: prefix, environment: "habilitacion" } } } });
  const hash = await bcrypt.hash(password, 4);
  const admin = await db.user.create({ data: { email: `credit-api-${key}@example.test`, role: "operator", restaurantId: restaurant.id, passwordHash: hash } });
  const waiter = await db.user.create({ data: { email: `credit-waiter-${key}@example.test`, role: "mesero", restaurantId: restaurant.id, passwordHash: hash } });
  const table = await db.table.create({ data: { restaurantId: restaurant.id, number: 1, qrToken: randomUUID() } });
  const order = await db.order.create({ data: { restaurantId: restaurant.id, tableId: table.id, status: "paid", paidAt: new Date(), shortCode: randomUUID() } });
  const built = buildDianInvoiceXml(originalInvoiceInput);
  const xmlZip = new Uint8Array(await new JSZip().file("invoice.xml", built.xml).generateAsync({ type: "nodebuffer" }));
  const invoice = await db.simpleInvoice.create({ data: { restaurantId: restaurant.id, orderId: order.id, invoiceNumber: 1, totalCents: 999999, snapshot: { invoicePrefix: "FE" }, dianDocument: { create: { restaurantId: restaurant.id, orderId: order.id, kind: "invoice", state: "accepted", cufe: built.cufe, xmlZip } } } });
  const waiterContext = await browser.newContext({ locale: "es-CO" });
  const anonymousContext = await browser.newContext({ locale: "es-CO" });
  const previewBodies: Record<string, unknown>[] = [];
  page.on("request", req => { if (new URL(req.url()).pathname.endsWith("/credit-notes/preview")) previewBodies.push(req.postDataJSON()); });
  try {
    await login(page, admin.email, password);
    await page.goto(`${base}/operator/facturas/notas-credito`);
    await page.getByLabel(t.searchLabel, { exact: true }).fill("FE1");
    await page.getByRole("button", { name: t.search, exact: true }).click();
    await expect(page.getByText(t.finalConsumer, { exact: true })).toBeVisible();
    await page.getByRole("button", { name: t.selectInvoice.replace("{number}", "FE1"), exact: true }).click();
    await page.getByLabel(t.explanation, { exact: true }).fill("SIN VALIDEZ FISCAL — prueba local de entrega");
    await page.getByRole("button", { name: t.review, exact: true }).click();
    await expect(page.getByRole("heading", { name: t.reviewTitle, exact: true })).toBeVisible();
    expect(previewBodies).toHaveLength(1);
    expect(previewBodies[0]).not.toHaveProperty("requestId");
    expect(await db.creditNote.count({ where: { restaurantId: restaurant.id } })).toBe(0);
    await page.getByRole("button", { name: t.confirm, exact: true }).click();
    await expect(page.getByRole("heading", { name: `${prefix}1`, exact: true })).toBeVisible();
    await expect.poll(async () => (await db.creditNote.findFirst({ where: { restaurantId: restaurant.id }, include: { dianDocument: true } }))?.dianDocument?.lastError).toBe("no_certificate");
    const notes = await db.creditNote.findMany({ where: { restaurantId: restaurant.id }, include: { dianDocument: true } });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ originalInvoiceId: invoice.id, totalCents: 26600, subtotalCents: 25000, taxCents: 1600, abandonedAt: null });
    expect(notes[0].dianDocument).toMatchObject({ state: "to_send", attempts: 0, xmlZip: null, leaseToken: null });
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("paid");
    expect((await page.request.get(`${base}/api/operator/credit-notes/source/${invoice.id}`)).ok()).toBe(true);
    const source = await (await page.request.get(`${base}/api/operator/credit-notes/source/${invoice.id}`)).json();
    expect(source.source.remainingTotalCents).toBe(0);
    // Only this isolated fixture is promoted. No SOAP or email action occurs.
    // Cached delivery XML is deliberately a test container, not a fiscal artifact.
    const note = notes[0];
    const staffBase = `${base}/api/operator/credit-notes/${note.id}`;
    const publicBase = `${base}/nota-credito/${note.publicToken}`;
    const anonymous = anonymousContext.request;
    for (const state of ["pending", "rejected"] as const) {
      await db.dianDocument.update({ where: { id: note.dianDocument!.id }, data: { state } });
      expect((await anonymous.get(publicBase)).status()).toBe(404);
      expect((await anonymous.get(`${publicBase}/document?format=pdf`)).status()).toBe(404);
      expect((await page.request.get(`${staffBase}/download?format=pdf`)).status()).toBe(409);
      expect((await page.request.get(`${staffBase}/qr`)).status()).toBe(409);
    }
    const testXml = '<?xml version="1.0"?><AttachedDocument xmlns="urn:oasis:names:specification:ubl:schema:xsd:AttachedDocument-2"><Note>SIN VALIDEZ FISCAL - SOLO PRUEBA LOCAL</Note></AttachedDocument>';
    const creditXml = '<?xml version="1.0"?><CreditNote xmlns="urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2"><Note>SIN VALIDEZ FISCAL - SOLO PRUEBA LOCAL</Note></CreditNote>';
    const creditZip = new Uint8Array(await new JSZip().file("test-credit.xml", creditXml).generateAsync({ type: "nodebuffer" }));
    await db.dianDocument.update({ where: { id: note.dianDocument!.id }, data: {
      state: "accepted", cufe: "c".repeat(96), xmlZip: creditZip,
      issuedAt: new Date("2026-10-02T15:00:00Z"),
      responseXml: '<ApplicationResponse><Note>SIN VALIDEZ FISCAL - SOLO PRUEBA LOCAL</Note></ApplicationResponse>',
      deliveryXml: testXml, errors: [], lastError: null, nextAttemptAt: null,
    } });
    const pdf = await page.request.get(`${staffBase}/download?format=pdf`);
    expect(pdf.status()).toBe(200);
    expect(pdf.headers()["content-type"]).toContain("application/pdf");
    expect(pdf.headers()["content-disposition"]).toBe(`attachment; filename="${note.documentNumber}.pdf"`);
    expect(pdf.headers()["cache-control"]).toContain("no-store");
    expect(pdf.headers()["x-content-type-options"]).toBe("nosniff");
    expect((await pdf.body()).subarray(0, 5).toString("ascii")).toBe("%PDF-");
    const print = await page.request.get(`${staffBase}/print`);
    expect(print.status()).toBe(200);
    expect(print.headers()["content-disposition"]).toContain("inline;");
    expect((await print.body()).subarray(0, 5).toString("ascii")).toBe("%PDF-");
    const qr = await page.request.get(`${staffBase}/qr`);
    expect(qr.status()).toBe(200);
    expect(qr.headers()["content-type"]).toBe("image/png");
    expect((await qr.body()).subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    const publicPage = await anonymous.get(publicBase);
    expect(publicPage.status()).toBe(200);
    expect(await publicPage.text()).toContain(note.documentNumber);
    const publicPdf = await anonymous.get(`${publicBase}/document?format=pdf`);
    expect(publicPdf.status()).toBe(200);
    expect(publicPdf.headers()["cache-control"]).toContain("no-store");
    expect(publicPdf.headers()["content-type"]).toContain("application/pdf");
    expect((await publicPdf.body()).subarray(0, 5).toString("ascii")).toBe("%PDF-");
    const publicXml = await anonymous.get(`${publicBase}/document?format=xml`);
    expect(publicXml.status()).toBe(200);
    expect(await publicXml.text()).toBe(testXml);
    const invalid = `${base}/nota-credito/invalid-${randomUUID()}`;
    expect((await anonymous.get(invalid)).status()).toBe(404);
    expect((await anonymous.get(`${invalid}/document?format=pdf`)).status()).toBe(404);
    expect((await anonymous.get(`${staffBase}/download?format=pdf`)).status()).toBe(401);
    expect((await db.creditNote.count({ where: { restaurantId: restaurant.id } }))).toBe(1);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("paid");
    const waiterPage = await waiterContext.newPage();
    await login(waiterPage, waiter.email, password);
    const denied = await waiterPage.request.get(`${base}/api/operator/credit-notes/${notes[0].id}`);
    expect([401, 403]).toContain(denied.status());
    await waiterPage.goto(`${base}/operator/facturas/notas-credito`);
    await expect(waiterPage.getByRole("heading", { name: t.title, exact: true })).toHaveCount(0);
  } finally {
    await waiterContext.close();
    await anonymousContext.close();
    await db.dianDocument.deleteMany({ where: { restaurantId: restaurant.id } });
    await db.creditNote.deleteMany({ where: { restaurantId: restaurant.id } });
    await db.creditNoteSeries.deleteMany({ where: { prefix } });
    await db.user.deleteMany({ where: { restaurantId: restaurant.id } });
    await db.restaurant.delete({ where: { id: restaurant.id } });
  }
});
test.afterAll(() => db.$disconnect());
