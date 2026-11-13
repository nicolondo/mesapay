import { describe, expect, it } from "vitest";
import {
  allocateProRata,
  creditNoteAmountError,
  creditNoteAvailableCents,
  creditNotePostingLines,
  defaultCreditNoteAccount,
  netPostingLines,
  returnLineCosts,
  reversePostingLines,
  type CreditNoteAmounts,
  type PostingLine,
} from "./supplierCreditNotes";

const sum = (lines: PostingLine[], side: "debit" | "credit") => lines.reduce((s, l) => s + (l[side] ?? 0), 0);
const byCode = (lines: PostingLine[]) =>
  Object.fromEntries(lines.map((l) => [l.code, (l.debit ?? 0) - (l.credit ?? 0)]));

describe("contrapartida por tipo", () => {
  it("acuerdo 613575, descuento 613570, pronto pago 421040, devolución 143505", () => {
    expect(defaultCreditNoteAccount("agreement")).toBe("613575");
    expect(defaultCreditNoteAccount("discount")).toBe("613570");
    expect(defaultCreditNoteAccount("conditional_discount")).toBe("421040");
    expect(defaultCreditNoteAccount("return")).toBe("143505");
  });
});

describe("asiento de una nota", () => {
  const base: CreditNoteAmounts = { kind: "agreement", totalCents: 500_000, ivaCents: 0, incCents: 0, ivaDeductible: false };

  it("sin IVA discriminado: el valor completo es el descuento y el IVA no se toca", () => {
    const lines = creditNotePostingLines(base);
    expect(byCode(lines)).toEqual({ "133005": 500_000, "613575": -500_000 });
    expect(sum(lines, "debit")).toBe(sum(lines, "credit"));
  });

  it("con IVA descontable: baja el IVA descontable (24081001)", () => {
    const lines = creditNotePostingLines({ ...base, kind: "discount", totalCents: 119_000, ivaCents: 19_000, ivaDeductible: true });
    expect(byCode(lines)).toEqual({ "133005": 119_000, "613570": -100_000, "24081001": -19_000 });
  });

  it("con IVA NO descontable: el IVA sigue a la base (fue costo)", () => {
    const lines = creditNotePostingLines({ ...base, kind: "discount", totalCents: 119_000, ivaCents: 19_000, ivaDeductible: false });
    expect(byCode(lines)).toEqual({ "133005": 119_000, "613570": -119_000 });
  });

  it("pronto pago va al ingreso financiero; el INC siempre sigue a la base", () => {
    const lines = creditNotePostingLines({ ...base, kind: "conditional_discount", totalCents: 108_000, incCents: 8_000 });
    expect(byCode(lines)).toEqual({ "133005": 108_000, "421040": -108_000 });
  });

  it("la cuenta elegida reemplaza a la del tipo", () => {
    const lines = creditNotePostingLines({ ...base, accountCode: "429505" });
    expect(byCode(lines)).toEqual({ "133005": 500_000, "429505": -500_000 });
  });

  it("devolución: inventario por lo que tiene kardex, gasto por lo que no; IVA descontable aparte", () => {
    const n: CreditNoteAmounts = {
      kind: "return",
      totalCents: 119_000 + 11_900,
      ivaCents: 20_900,
      incCents: 0,
      ivaDeductible: true,
      lines: [
        { valueCents: 100_000, inventoried: true },
        { valueCents: 10_000, inventoried: false },
      ],
    };
    expect(creditNoteAmountError(n)).toBeNull();
    const lines = creditNotePostingLines(n);
    expect(byCode(lines)).toEqual({ "133005": 130_900, "143505": -100_000, "519505": -10_000, "24081001": -20_900 });
  });

  it("devolución con IVA no descontable: el IVA se reparte en el costo de cada línea (kardex = asiento)", () => {
    const n: CreditNoteAmounts = {
      kind: "return",
      totalCents: 33_301,
      ivaCents: 3_301,
      incCents: 0,
      ivaDeductible: false,
      lines: [
        { valueCents: 10_000, inventoried: true },
        { valueCents: 10_000, inventoried: true },
        { valueCents: 10_000, inventoried: true },
      ],
    };
    const costs = returnLineCosts(n);
    expect(costs.reduce((s, c) => s + c, 0)).toBe(33_301);
    expect(byCode(creditNotePostingLines(n))).toEqual({ "133005": 33_301, "143505": -33_301 });
  });

  it("devolución ya registrada: usa el costo congelado de cada línea", () => {
    const n: CreditNoteAmounts = {
      kind: "return",
      totalCents: 30_000,
      ivaCents: 0,
      incCents: 0,
      ivaDeductible: false,
      lines: [
        { valueCents: 20_000, costCents: 20_000, inventoried: true },
        { valueCents: 10_000, costCents: 10_000, inventoried: false },
      ],
    };
    expect(returnLineCosts(n)).toEqual([20_000, 10_000]);
  });

  it("anulación: el reverso exacto; netear deja una línea por cuenta", () => {
    const lines = creditNotePostingLines({ ...base, kind: "discount", totalCents: 119_000, ivaCents: 19_000, ivaDeductible: true });
    const both = netPostingLines([...lines, ...reversePostingLines(lines)]);
    expect(both).toEqual([]);
    const two = netPostingLines([...lines, ...lines]);
    expect(byCode(two)).toEqual({ "133005": 238_000, "613570": -200_000, "24081001": -38_000 });
  });
});

describe("validación de montos", () => {
  const n: CreditNoteAmounts = { kind: "discount", totalCents: 100, ivaCents: 0, incCents: 0, ivaDeductible: false };
  it("rechaza total, impuestos y base inválidos", () => {
    expect(creditNoteAmountError({ ...n, totalCents: 0 })).toBe("total_invalid");
    expect(creditNoteAmountError({ ...n, ivaCents: -1 })).toBe("tax_invalid");
    expect(creditNoteAmountError({ ...n, ivaCents: 100 })).toBe("base_invalid");
  });
  it("una devolución trae líneas que suman la base", () => {
    expect(creditNoteAmountError({ ...n, kind: "return" })).toBe("lines_required");
    expect(creditNoteAmountError({ ...n, kind: "return", lines: [{ valueCents: 90, inventoried: true }] })).toBe("lines_mismatch");
    expect(creditNoteAmountError({ ...n, kind: "return", lines: [{ valueCents: 100, inventoried: true }] })).toBeNull();
  });
});

describe("reparto y saldo", () => {
  it("allocateProRata reparte exacto", () => {
    expect(allocateProRata(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocateProRata(0, [5, 5])).toEqual([0, 0]);
    expect(allocateProRata(7, [0, 0])).toEqual([0, 0]);
  });
  it("saldo a favor = total − cruces − reintegros; anulada = 0", () => {
    expect(creditNoteAvailableCents({ totalCents: 1000, appliedCents: 300, refundedCents: 200 })).toBe(500);
    expect(creditNoteAvailableCents({ totalCents: 1000, appliedCents: 300, refundedCents: 0, status: "voided" })).toBe(0);
  });
});
