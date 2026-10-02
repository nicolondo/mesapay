import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import es from "../messages/es.json";

const base = process.env.PLAYWRIGHT_BASE_URL ?? "";
const database = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
test.skip(!/^http:\/\/localhost:/.test(base) || !["localhost", "127.0.0.1"].includes(database.hostname) || !/^\/mesapay_.*(?:validation|test)$/.test(database.pathname), "Isolated local app/database required");
const db = new PrismaClient();
const t = es.opCreditNotes;
const line = { lineId: "1", description: "Plato de prueba", quantity: 1, unitPriceCents: 100001, lineTotalCents: 100001, taxCents: 8000, taxPct: "8.00", taxSchemeId: "04", grossCents: 108001, reservedGrossCents: 0, reservedTaxCents: 0, remainingGrossCents: 108001 };
const source = { originalInvoiceId: "invoice1", original: { invoiceNumber: "SETP990000001" }, lines: [line], remainingTotalCents: 108001, sourceVersion: "v1", prefix: "NC", nextNumber: 1, notes: [] };
const proposal = { lines: [{ ...line, originalLineId: "1" }], subtotalCents: 100001, taxCents: 8000, totalCents: 108001 };

for (const width of [390, 1440]) {
  test(`credit note review is explicit, exact and idempotent at ${width}px`, async ({ page }) => {
    const key = randomUUID(); const password = `Credit-${key}`;
    const restaurant = await db.restaurant.create({ data: { name: "Credit note UI", slug: `credit-ui-${key}`, enabledModules: ["einvoicing"] } });
    const user = await db.user.create({ data: { email: `credit-${key}@example.test`, role: "operator", restaurantId: restaurant.id, passwordHash: await bcrypt.hash(password, 4) } });
    const createBodies: Record<string, unknown>[] = [];
    let previews = 0;
    let savedSeries: unknown = null;
    const partial = width === 1440;
    const expectedProposal = partial ? { lines: [{ ...line, originalLineId: "1", lineTotalCents: 50001, taxCents: 4000, grossCents: 54001 }], subtotalCents: 50001, taxCents: 4000, totalCents: 54001 } : proposal;
    const note = { id: "note1", documentNumber: "NC1", number: 1, canRetry: true, canAbandon: true, abandonedAt: null, originalInvoiceId: "invoice1", reasonCode: "2", reasonText: "Ajuste solicitado por cliente", createdAt: "2026-10-02T12:00:00Z", environment: "2", subtotalCents: 100001, taxCents: 8000, totalCents: 108001, snapshot: { original: source.original, lines: expectedProposal.lines, recipientEmail: null }, document: { state: "to_send", errors: [], lastError: null } };
    try {
      await page.setViewportSize({ width, height: 900 });
      await page.route(/^https?:\/\//, route => ["localhost", "127.0.0.1"].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
      await page.goto(`${base}/signin`);
      await page.getByLabel("Correo", { exact: true }).fill(user.email);
      await page.getByLabel("Contraseña", { exact: true }).fill(password);
      await page.locator('button[type="submit"]').click();
      await page.waitForURL(url => !url.pathname.startsWith("/signin"));
      await page.route("**/api/operator/credit-notes**", async route => {
        const req = route.request(); const path = new URL(req.url()).pathname;
        const fulfill = (body: unknown) => route.fulfill({ json: body });
        if (path.endsWith("/invoices")) return fulfill({ invoices: [{ id: "invoice1", invoiceNumber: source.original.invoiceNumber, customerName: null, totalCents: 108001, paidAt: null, acceptedCreditCents: 0, reservedCreditCents: 0 }] });
        if (path.endsWith("/series")) { if (req.method() === "POST") savedSeries = req.postDataJSON(); return fulfill({ series: { prefix: savedSeries ? "NCA" : "NC", nextNumber: savedSeries ? 2 : 1, environment: "2", issuerNit: "900000001" } }); }
        if (path.includes("/source/")) return fulfill({ source: { ...source, sourceVersion: partial && previews > 0 ? "v2" : "v1" } });
        if (path.endsWith("/preview")) { previews++; if (partial && previews === 1) return route.fulfill({ status: 409, json: { error: "source_changed" } }); return fulfill({ proposal: expectedProposal }); }
        if (path.endsWith("/emit")) return fulfill({ ok: true });
        if (path.endsWith("/note1")) return fulfill({ creditNote: note });
        if (req.method() === "POST") {
          createBodies.push(req.postDataJSON());
          if (createBodies.length === 1) return route.abort("failed");
          return fulfill({ creditNote: note });
        }
        return fulfill({ notes: [] });
      });
      await page.goto(`${base}/operator/facturas/notas-credito`);
      await expect(page.getByRole("heading", { name: t.title, exact: true })).toBeVisible();
      await page.getByRole("button", { name: t.seriesOpen, exact: true }).click();
      await page.getByLabel(t.seriesPrefix, { exact: true }).fill("NCA");
      await page.getByLabel(t.seriesNext, { exact: true }).fill("2");
      await page.getByRole("button", { name: t.seriesSave, exact: true }).click();
      await expect(page.getByText(t.seriesSaved, { exact: true })).toBeVisible();
      expect(savedSeries).toEqual({ prefix: "NCA", nextNumber: 2 });
      await page.getByRole("button", { name: t.seriesClose, exact: true }).click();
      await page.getByLabel(t.searchLabel, { exact: true }).fill("SETP");
      await page.getByRole("button", { name: t.search, exact: true }).click();
      await expect(page.getByText(t.finalConsumer, { exact: true })).toBeVisible();
      await page.getByRole("button", { name: t.selectInvoice.replace("{number}", source.original.invoiceNumber) }).click();
      if (partial) { await page.getByRole("radio", { name: t.mode_partial, exact: false }).check(); await page.getByRole("textbox", { name: t.lineAmount.replace("{name}", line.description), exact: true }).fill("540,01"); }
      await page.getByLabel(t.explanation, { exact: true }).fill("Ajuste solicitado por cliente");
      await page.getByLabel(t.explanation, { exact: true }).press("Enter");
      expect(previews).toBe(0); expect(createBodies).toHaveLength(0);
      await page.getByRole("button", { name: t.review, exact: true }).click();
      if (partial) { await expect(page.getByRole("alert").filter({ hasText: t.error_source_changed })).toBeVisible(); await expect(page.getByRole("heading", { name: t.reviewTitle, exact: true })).toHaveCount(0); expect(createBodies).toHaveLength(0); await page.getByRole("button", { name: t.review, exact: true }).click(); }
      await expect(page.getByRole("heading", { name: t.reviewTitle, exact: true })).toBeFocused();
      await expect(page.getByText(partial ? /540,01/ : /1\.080,01/).last()).toBeVisible();
      expect(createBodies).toHaveLength(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: test.info().outputPath(`credit-note-review-${width}.png`), animations: "disabled", fullPage: true });
      await page.getByRole("button", { name: t.confirm, exact: true }).click();
      await expect(page.getByRole("alert").filter({ hasText: t.error_request_failed })).toBeVisible();
      await expect(page.getByRole("button", { name: t.edit, exact: true })).toBeDisabled();
      await page.getByRole("button", { name: t.confirm, exact: true }).click();
      await expect(page.getByRole("heading", { name: "NC1", exact: true })).toBeVisible();
      expect(createBodies).toHaveLength(2);
      expect(createBodies[1]).toEqual(createBodies[0]);
      expect(createBodies[0].sourceVersion).toBe(partial ? "v2" : "v1");
      expect(createBodies[0].mode).toBe(partial ? "partial" : "total");
      if (partial) expect(createBodies[0].lines).toEqual([{ lineId: "1", grossCents: 54001 }]);
      expect(createBodies[0].requestId).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      await db.user.delete({ where: { id: user.id } });
      await db.restaurant.delete({ where: { id: restaurant.id } });
    }
  });
}
test.afterAll(() => db.$disconnect());
