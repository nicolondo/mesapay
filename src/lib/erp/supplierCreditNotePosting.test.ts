import { describe, expect, it } from "vitest";
import { buildSupplierCreditEntries, type NoteFact } from "./supplierCreditNotePosting";

const day = (d: Date) => d.toISOString().slice(0, 10);
const fn = { calendarDay: day, businessDay: day, entryDate: (d: string) => new Date(`${d}T05:00:00.000Z`) };
const note = (over: Partial<NoteFact> = {}): NoteFact => ({
  id: "n1",
  kind: "agreement",
  date: new Date("2026-11-10T17:00:00Z"),
  totalCents: 100_000,
  ivaCents: 0,
  incCents: 0,
  ivaDeductible: false,
  accountCode: null,
  voidedAt: null,
  ...over,
});
const balanced = (lines: { debit?: number; credit?: number }[]) =>
  lines.reduce((s, l) => s + (l.debit ?? 0), 0) === lines.reduce((s, l) => s + (l.credit ?? 0), 0);

describe("asientos de notas crédito de proveedores", () => {
  it("la nota del día: D saldo a favor · C acuerdos comerciales", () => {
    const [e] = buildSupplierCreditEntries({ notes: [note()], voids: [], applies: [], refunds: [] }, fn);
    expect(e!.source).toBe("supplier_credit_note");
    expect(e!.day).toBe("2026-11-10");
    expect(e!.lines).toEqual([
      { code: "133005", debit: 100_000 },
      { code: "613575", credit: 100_000 },
    ]);
  });

  it("varias notas del mismo día se netean por cuenta", () => {
    const [e] = buildSupplierCreditEntries(
      {
        notes: [note(), note({ id: "n2", kind: "discount", totalCents: 119_000, ivaCents: 19_000, ivaDeductible: true })],
        voids: [],
        applies: [],
        refunds: [],
      },
      fn,
    );
    expect(e!.lines).toEqual([
      { code: "133005", debit: 219_000 },
      { code: "613575", credit: 100_000 },
      { code: "613570", credit: 100_000 },
      { code: "24081001", credit: 19_000 },
    ]);
    expect(balanced(e!.lines)).toBe(true);
  });

  it("la anulación es el reverso exacto, el día que se anula", () => {
    const voided = note({ voidedAt: new Date("2026-11-20T15:00:00Z") });
    const entries = buildSupplierCreditEntries({ notes: [voided], voids: [voided], applies: [], refunds: [] }, fn);
    expect(entries.map((e) => [e.source, e.day])).toEqual([
      ["supplier_credit_note", "2026-11-10"],
      ["supplier_credit_note_void", "2026-11-20"],
    ]);
    expect(entries[1]!.lines).toEqual([
      { code: "613575", debit: 100_000 },
      { code: "133005", credit: 100_000 },
    ]);
  });

  it("cruces: compras contra proveedores y gastos contra costos y gastos por pagar", () => {
    const [e] = buildSupplierCreditEntries(
      {
        notes: [],
        voids: [],
        applies: [
          { target: "purchase", amountCents: 60_000, at: new Date("2026-11-12T17:00:00Z") },
          { target: "expense", amountCents: 15_000, at: new Date("2026-11-12T18:00:00Z") },
        ],
        refunds: [],
      },
      fn,
    );
    expect(e!.source).toBe("supplier_credit_apply");
    expect(e!.lines).toEqual([
      { code: "220505", debit: 60_000 },
      { code: "233505", debit: 15_000 },
      { code: "133005", credit: 75_000 },
    ]);
  });

  it("reintegro en dinero: D banco · C saldo a favor", () => {
    const [e] = buildSupplierCreditEntries(
      { notes: [], voids: [], applies: [], refunds: [{ amountCents: 25_000, accountCode: "111005", at: new Date("2026-11-15T17:00:00Z") }] },
      fn,
    );
    expect(e!.source).toBe("supplier_credit_refund");
    expect(e!.lines).toEqual([
      { code: "111005", debit: 25_000 },
      { code: "133005", credit: 25_000 },
    ]);
  });

  it("devolución: el asiento acredita al inventario el costo congelado de sus líneas", () => {
    const [e] = buildSupplierCreditEntries(
      {
        notes: [
          note({
            kind: "return",
            totalCents: 59_500,
            ivaCents: 9_500,
            ivaDeductible: true,
            lines: [{ valueCents: 50_000, costCents: 50_000, inventoried: true }],
          }),
        ],
        voids: [],
        applies: [],
        refunds: [],
      },
      fn,
    );
    expect(e!.lines).toEqual([
      { code: "133005", debit: 59_500 },
      { code: "143505", credit: 50_000 },
      { code: "24081001", credit: 9_500 },
    ]);
  });
});
