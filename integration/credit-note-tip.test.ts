// Propina devuelta con la nota crédito de ANULACIÓN, contra PostgreSQL real:
// la regla de la propina (cuenta dividida, cobros rechazados), lo que se fija
// al crear/aceptar la nota, el asiento del motor (efectivo/tarjeta y crédito
// de cliente), la deuda del cliente, las notas anteriores a la regla y las
// propinas del equipo. Datos sintéticos; nada sale hacia la DIAN ni Kushki.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import JSZip from "jszip";
import { db } from "../src/lib/db";
import { originalInvoiceInput } from "../src/lib/dian/__fixtures__/creditNote";
import { buildDianInvoiceXml } from "../src/lib/dian/ubl";
import { createCreditNote, getCreditNoteSource, previewCreditNote } from "../src/lib/dian/creditNotes/service";
import type { CreditNoteInput } from "../src/lib/dian/creditNotes/types";
import { ensureCreditNoteStamps, stampCreditNoteAccounting } from "../src/lib/erp/creditNoteAccounting";
import { generateJournalForMonth } from "../src/lib/erp/posting";
import { monthRange } from "../src/lib/erp/accounting";
import { loadCustomerCreditSummary } from "../src/lib/customerCredit";
import { loadTipReturns, tipReturnLines } from "../src/lib/creditNoteTipReturns";
import { bogotaBusinessDateIso } from "../src/lib/bogota";

const url = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
if (!["127.0.0.1", "localhost"].includes(url.hostname) || !/^\/mesapay_.*(?:test|validation)$/.test(url.pathname))
  throw new Error("Isolated local database required");

// Factura electrónica del fixture: 20.000 + 1.600 INC + 5.000 excluido = 26.600 (en centavos).
const FISCAL = 26_600;
const TIP = 2_660;
const tenants: string[] = [];
const prefix = `P${randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`;
let restaurantId = "";
let tableId = "";
let waiterA = "";
let waiterB = "";

type PaymentSeed = { method: "cash" | "kushki_card" | "customer_credit"; status?: "approved" | "declined"; amountCents: number; tipCents: number; collectedByUserId?: string | null; billingCustomerId?: string | null };

async function invoiceFor(number: number, payments: PaymentSeed[]) {
  const tipCents = payments.filter((p) => (p.status ?? "approved") === "approved").reduce((s, p) => s + p.tipCents, 0);
  const order = await db.order.create({
    data: {
      restaurantId,
      tableId,
      status: "paid",
      paidAt: new Date(),
      shortCode: randomUUID(),
      subtotalCents: FISCAL,
      tipCents,
      totalCents: FISCAL + tipCents,
      payments: {
        create: payments.map((p) => ({
          method: p.method,
          status: p.status ?? "approved",
          amountCents: p.amountCents,
          tipCents: p.tipCents,
          settledAt: new Date(),
          collectedByUserId: p.collectedByUserId ?? null,
          billingCustomerId: p.billingCustomerId ?? null,
        })),
      },
    },
  });
  const built = buildDianInvoiceXml({ ...originalInvoiceInput, invoiceNumber: `FE${number}` });
  const zip = await new JSZip().file("invoice.xml", built.xml).generateAsync({ type: "nodebuffer" });
  const invoice = await db.simpleInvoice.create({
    data: {
      restaurantId,
      orderId: order.id,
      invoiceNumber: number,
      totalCents: FISCAL + tipCents,
      email: null,
      snapshot: { invoicePrefix: "FE", tipCents },
      dianDocument: { create: { restaurantId, orderId: order.id, kind: "invoice", state: "accepted", cufe: built.cufe, xmlZip: new Uint8Array(zip) } },
    },
  });
  return { invoiceId: invoice.id, orderId: order.id };
}

async function annul(invoiceId: string): Promise<CreditNoteInput> {
  const source = await getCreditNoteSource(restaurantId, invoiceId);
  return { originalInvoiceId: invoiceId, requestId: randomUUID(), sourceVersion: source.sourceVersion, mode: "total", reasonCode: "2", reasonText: "Anulación de prueba" };
}

/** Simula la aceptación de la DIAN (sin llamarla) y la contabilización que hace emitCreditNote. */
async function accept(noteId: string, issuedAt = new Date()) {
  const note = await db.creditNote.findUniqueOrThrow({ where: { id: noteId }, include: { dianDocument: true } });
  await db.dianDocument.update({ where: { id: note.dianDocument!.id }, data: { state: "accepted", issuedAt, cufe: "c".repeat(96) } });
  await stampCreditNoteAccounting(restaurantId, noteId);
}

beforeAll(async () => {
  const tenant = await db.restaurant.create({
    data: {
      name: "Propina fixture",
      taxId: originalInvoiceInput.supplier.companyId,
      slug: `tip-${randomUUID()}`,
      businessDayCutoffHour: 0,
      dianConfig: { create: { creditNotePrefix: prefix, environment: "habilitacion" } },
    },
  });
  restaurantId = tenant.id;
  tenants.push(tenant.id);
  tableId = (await db.table.create({ data: { restaurantId, number: 1, label: "Test", qrToken: randomUUID() } })).id;
  const mk = async (name: string) =>
    (await db.user.create({ data: { email: `${name}-${randomUUID()}@example.test`, name, role: "mesero", restaurantId, passwordHash: "!" } })).id;
  waiterA = await mk("Ana");
  waiterB = await mk("Luis");
});

afterAll(async () => {
  await db.journalLine.deleteMany({ where: { entry: { restaurantId: { in: tenants } } } });
  await db.journalEntry.deleteMany({ where: { restaurantId: { in: tenants } } });
  await db.dianDocument.deleteMany({ where: { restaurantId: { in: tenants } } });
  await db.creditNote.deleteMany({ where: { restaurantId: { in: tenants } } });
  await db.creditNoteSeries.deleteMany({ where: { prefix } });
  await db.payment.deleteMany({ where: { order: { restaurantId: { in: tenants } } } });
  await db.user.deleteMany({ where: { restaurantId: { in: tenants } } });
  await db.restaurant.deleteMany({ where: { id: { in: tenants } } });
  await db.$disconnect();
});

describe("propina devuelta con la anulación (PostgreSQL)", () => {
  it("cuenta dividida pagada en efectivo y tarjeta: muestra el desglose, la anulación devuelve toda la propina cobrada", async () => {
    const { invoiceId } = await invoiceFor(1, [
      { method: "kushki_card", amountCents: 16_000 + 1_600, tipCents: 1_600, collectedByUserId: waiterA },
      { method: "cash", amountCents: 10_600 + 1_060, tipCents: 1_060, collectedByUserId: waiterB },
      // Un cobro rechazado no cuenta como propina cobrada.
      { method: "cash", status: "declined", amountCents: 9_999, tipCents: 999 },
    ]);
    const source = await getCreditNoteSource(restaurantId, invoiceId);
    expect(source.charge).toEqual({ fiscalTotalCents: FISCAL, tipCents: TIP, chargedCents: FISCAL + TIP });

    // Una parcial no toca la propina; la anulación la devuelve entera.
    const partial = await previewCreditNote(restaurantId, { ...(await annul(invoiceId)), mode: "partial", reasonCode: "3", lines: [{ lineId: "1", grossCents: 1_000 }] });
    expect(partial.tipRefundCents).toBe(0);
    const input = await annul(invoiceId);
    const review = await previewCreditNote(restaurantId, input);
    expect(review).toMatchObject({ totalCents: FISCAL, tipRefundCents: TIP });

    const note = await createCreditNote(restaurantId, null, input);
    // La nota electrónica NO cambia: su total es el fiscal; la propina va aparte.
    expect(note.totalCents).toBe(FISCAL);
    expect(note.tipRefundCents).toBe(TIP);
    expect((await db.creditNote.findUniqueOrThrow({ where: { id: note.id } })).tipRefundCents).toBe(TIP);

    const issuedAt = new Date();
    await accept(note.id, issuedAt);
    const stamped = await db.creditNote.findUniqueOrThrow({ where: { id: note.id } });
    expect(stamped).toMatchObject({ receivableCents: 0, tipRefundCents: TIP, tipReceivableCents: 0 });

    // Asiento del motor del mes de la nota: D 238030 propina · C 238020 lo cobrado. Cuadra.
    const month = bogotaBusinessDateIso(issuedAt).slice(0, 7);
    await generateJournalForMonth(restaurantId, month, monthRange(month)!);
    const entry = await db.journalEntry.findFirstOrThrow({
      where: { restaurantId, source: "credit_note", sourceRef: month },
      include: { lines: true },
    });
    const net = (code: string) =>
      entry.lines.filter((l) => l.accountCode === code).reduce((s, l) => s + Number(l.debitCents) - Number(l.creditCents), 0);
    expect(net("238030")).toBe(TIP);
    expect(net("238020")).toBe(-(FISCAL + TIP));
    expect(net("417505")).toBe(25_000);
    expect(net("241205")).toBe(1_600);
    const debit = entry.lines.reduce((s, l) => s + Number(l.debitCents), 0);
    const credit = entry.lines.reduce((s, l) => s + Number(l.creditCents), 0);
    expect(debit).toBe(credit);
    expect(await db.creditNote.findUniqueOrThrow({ where: { id: note.id } })).toMatchObject({ postedMonth: month, tipPostedMonth: month });

    // Regenerar el mes deja exactamente lo mismo.
    await generateJournalForMonth(restaurantId, month, monthRange(month)!);
    const again = await db.journalEntry.findMany({ where: { restaurantId, source: "credit_note", sourceRef: month }, include: { lines: true } });
    expect(again).toHaveLength(1);
    expect(again[0]!.lines.map((l) => [l.accountCode, Number(l.debitCents), Number(l.creditCents)]).sort()).toEqual(
      entry.lines.map((l) => [l.accountCode, Number(l.debitCents), Number(l.creditCents)]).sort(),
    );

    // Propinas del equipo: la del día de la nota, repartida entre quienes la cobraron.
    const returns = await loadTipReturns(restaurantId, { from: new Date(issuedAt.getTime() - 60_000), to: null });
    expect(tipReturnLines(returns)).toEqual([{ creditNoteId: note.id, documentNumber: note.documentNumber, cents: TIP }]);
    expect(tipReturnLines(returns, waiterA)[0]!.cents).toBe(1_600);
    expect(tipReturnLines(returns, waiterB)[0]!.cents).toBe(1_060);
    // Fuera de la ventana (un turno anterior a la nota) no aparece.
    expect(await loadTipReturns(restaurantId, { from: new Date(issuedAt.getTime() - 7_200_000), to: new Date(issuedAt.getTime() - 3_600_000) })).toEqual([]);
  });

  it("cuenta cobrada a crédito de cliente: la deuda baja por lo cobrado (comida + propina) y la propina acredita Clientes", async () => {
    const customer = await db.billingCustomer.create({
      data: { restaurantId, customerName: "ACME", docType: "NIT", docNumber: `9${Date.now() % 100_000_000}`, email: "acme@example.test", creditEnabled: true },
    });
    const { invoiceId } = await invoiceFor(2, [
      { method: "customer_credit", amountCents: FISCAL + TIP, tipCents: TIP, billingCustomerId: customer.id },
    ]);
    const note = await createCreditNote(restaurantId, null, await annul(invoiceId));
    await accept(note.id);
    expect(await db.creditNote.findUniqueOrThrow({ where: { id: note.id } })).toMatchObject({ receivableCents: FISCAL, tipReceivableCents: TIP });
    const summary = await loadCustomerCreditSummary(restaurantId, customer.id);
    expect(summary?.debtCents).toBe(0);
  });

  it("nota de anulación ANTERIOR a la regla (sin propina fijada): se calcula y fija una sola vez", async () => {
    const { invoiceId } = await invoiceFor(3, [{ method: "cash", amountCents: FISCAL + TIP, tipCents: TIP }]);
    const note = await createCreditNote(restaurantId, null, await annul(invoiceId));
    await accept(note.id);
    // Como quedaron las notas aceptadas antes del despliegue: sello fiscal hecho, propina sin columna.
    await db.creditNote.update({ where: { id: note.id }, data: { tipRefundCents: null, tipReceivableCents: null, tipPostedMonth: null } });
    await ensureCreditNoteStamps(restaurantId);
    const fixed = await db.creditNote.findUniqueOrThrow({ where: { id: note.id } });
    expect(fixed).toMatchObject({ tipRefundCents: TIP, tipReceivableCents: 0, receivableCents: 0 });
    // Idempotente: otra pasada no cambia nada.
    await ensureCreditNoteStamps(restaurantId);
    expect(await db.creditNote.findUniqueOrThrow({ where: { id: note.id } })).toEqual(fixed);
  });
});
