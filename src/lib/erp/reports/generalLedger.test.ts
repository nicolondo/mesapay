import { describe, expect, it } from "vitest";
import {
  accountNature,
  buildGeneralLedger,
  formatVoucherNumber,
  generalLedgerCsvRows,
  isAnnulled,
  type LedgerLineInput,
} from "./generalLedger";

const accounts = [
  { code: "110505", name: "Caja general", type: "activo", nature: "debito" },
  { code: "220505", name: "Proveedores nacionales", type: "pasivo", nature: "credito" },
  { code: "413505", name: "Ventas", type: "ingreso", nature: "credito" },
  { code: "613505", name: "Costo de ventas", type: "costo", nature: "debito" },
  { code: "999905", name: "Sin movimiento", type: "activo", nature: "debito" },
];

const from = new Date("2026-08-01T00:00:00Z");
const to = new Date("2026-09-01T00:00:00Z");

let seq = 0;
function line(
  p: Partial<LedgerLineInput> & { accountCode: string; date: string },
): LedgerLineInput {
  seq++;
  return {
    id: `l${seq}`,
    entryId: p.entryId ?? `e${seq}`,
    voucherNumber: null,
    source: "sale",
    memo: null,
    createdAt: p.createdAt ?? `2026-01-01T00:00:0${seq % 10}Z`,
    debitCents: 0,
    creditCents: 0,
    ...p,
  };
}

const lines: LedgerLineInput[] = [
  // Julio (antes del rango): caja +100.000, proveedores +80.000 (crédito).
  line({ accountCode: "110505", date: "2026-07-31T23:59:59.999Z", debitCents: 100_000 }),
  line({ accountCode: "220505", date: "2026-07-31T23:59:59.999Z", creditCents: 80_000 }),
  line({ accountCode: "220505", date: "2026-07-15T00:00:00Z", debitCents: 30_000 }),
  // Agosto (rango). Desordenados a propósito.
  line({ accountCode: "110505", date: "2026-08-31T23:59:59.999Z", voucherNumber: 12, debitCents: 50_000, source: "sale", memo: "Ventas de agosto" }),
  line({ accountCode: "110505", date: "2026-08-10T00:00:00Z", voucherNumber: 11, creditCents: 20_000, source: "expense_payment" }),
  line({ accountCode: "110505", date: "2026-08-31T23:59:59.999Z", voucherNumber: null, creditCents: 5_000, source: "bank", createdAt: "2026-09-02T00:00:00Z" }),
  line({ accountCode: "220505", date: "2026-08-31T23:59:59.999Z", voucherNumber: 12, creditCents: 40_000, source: "purchase" }),
  line({ accountCode: "220505", date: "2026-08-20T00:00:00Z", voucherNumber: 11, debitCents: 25_000, source: "purchase_payment" }),
  line({ accountCode: "413505", date: "2026-08-31T23:59:59.999Z", voucherNumber: 12, creditCents: 50_000 }),
  line({ accountCode: "613505", date: "2026-08-31T23:59:59.999Z", voucherNumber: 12, debitCents: 40_000 }),
  // Septiembre (fuera del rango): no debe entrar aunque venga.
  line({ accountCode: "110505", date: "2026-09-05T00:00:00Z", debitCents: 999_999 }),
];

describe("buildGeneralLedger — saldo inicial a naturaleza", () => {
  it("activo: inicial = D − C de lo anterior al desde; balance = inicial + debe − haber", () => {
    const gl = buildGeneralLedger(lines, accounts, { from, to });
    const caja = gl.accounts.find((a) => a.code === "110505")!;
    expect(caja.nature).toBe("debito");
    expect(caja.initialCents).toBe(100_000);
    expect(caja.debitCents).toBe(50_000);
    expect(caja.creditCents).toBe(25_000);
    expect(caja.balanceCents).toBe(125_000);
  });

  it("pasivo: inicial = C − D; balance = inicial + haber − debe", () => {
    const gl = buildGeneralLedger(lines, accounts, { from, to });
    const prov = gl.accounts.find((a) => a.code === "220505")!;
    expect(prov.nature).toBe("credito");
    expect(prov.initialCents).toBe(50_000);
    expect(prov.debitCents).toBe(25_000);
    expect(prov.creditCents).toBe(40_000);
    expect(prov.balanceCents).toBe(65_000);
  });

  it("costo es naturaleza débito (corrige el `costos` de zenith)", () => {
    expect(accountNature({ code: "613505", type: "costo" })).toBe("debito");
    expect(accountNature({ code: "613505", nature: "credito", type: "costo" })).toBe("credito");
    expect(accountNature({ code: "2", })).toBe("credito");
    expect(accountNature({ code: "5", })).toBe("debito");
  });
});

describe("buildGeneralLedger — movimientos", () => {
  it("orden fecha → comprobante (sin numerar al final) → createdAt, con saldo corrido", () => {
    const gl = buildGeneralLedger(lines, accounts, { from, to });
    const caja = gl.accounts.find((a) => a.code === "110505")!;
    expect(caja.movements.map((m) => [m.date.slice(0, 10), m.voucherNumber])).toEqual([
      ["2026-08-10", 11],
      ["2026-08-31", 12],
      ["2026-08-31", null],
    ]);
    expect(caja.movements.map((m) => m.runningCents)).toEqual([80_000, 130_000, 125_000]);
    expect(caja.movements.at(-1)!.runningCents).toBe(caja.balanceCents);
    expect(caja.movements[1]).toMatchObject({ source: "sale", memo: "Ventas de agosto", debitCents: 50_000 });
  });

  it("saldo corrido a naturaleza también en cuentas de crédito", () => {
    const gl = buildGeneralLedger(lines, accounts, { from, to });
    const prov = gl.accounts.find((a) => a.code === "220505")!;
    expect(prov.movements.map((m) => m.runningCents)).toEqual([25_000, 65_000]);
  });

  it("excluye cuentas sin movimiento ni saldo inicial, y las líneas fuera del rango", () => {
    const gl = buildGeneralLedger(lines, accounts, { from, to });
    expect(gl.accounts.map((a) => a.code)).toEqual(["110505", "220505", "413505", "613505"]);
    expect(gl.accounts.find((a) => a.code === "110505")!.debitCents).toBe(50_000);
  });

  it("una cuenta con solo saldo inicial sí aparece (sin movimientos)", () => {
    const gl = buildGeneralLedger(
      [line({ accountCode: "110505", date: "2026-01-01T00:00:00Z", debitCents: 7 })],
      accounts,
      { from, to },
    );
    expect(gl.accounts).toHaveLength(1);
    expect(gl.accounts[0]).toMatchObject({ initialCents: 7, movements: [], balanceCents: 7 });
  });

  it("filtro por cuenta: solo esa, y aparece aunque esté en cero", () => {
    const gl = buildGeneralLedger(lines, accounts, { from, to, accountCode: "413505" });
    expect(gl.accounts.map((a) => a.code)).toEqual(["413505"]);
    expect(gl.balanced).toBe(true);
    const empty = buildGeneralLedger(lines, accounts, { from, to, accountCode: "999905" });
    expect(empty.accounts).toEqual([
      expect.objectContaining({ code: "999905", name: "Sin movimiento", initialCents: 0, movements: [] }),
    ]);
  });

  it("cuenta que no está en el plan: sale con nombre vacío y naturaleza por clase", () => {
    const gl = buildGeneralLedger(
      [line({ accountCode: "530505", date: "2026-08-01T00:00:00Z", debitCents: 10 })],
      accounts,
      { from, to },
    );
    expect(gl.accounts[0]).toMatchObject({ code: "530505", name: "", nature: "debito", balanceCents: 10 });
  });

  it("totales del rango y partida doble", () => {
    const gl = buildGeneralLedger(lines, accounts, { from, to });
    expect(gl.totals).toEqual({ debitCents: 115_000, creditCents: 115_000 });
    expect(gl.balanced).toBe(true);
  });
});

describe("buildGeneralLedger — anulación por reversa", () => {
  // Original anulado (status annulled, líneas vigentes) + reversa manual
  // invertida: en la cuenta suman CERO. Si el anulado se descartara, la
  // reversa quedaría sola y el saldo bajaría dos veces.
  const reversalCase: LedgerLineInput[] = [
    line({ accountCode: "110505", date: "2026-08-05T00:00:00Z", entryId: "orig", voucherNumber: 7, status: "annulled", source: "manual", memo: "Ajuste", creditCents: 9_000 }),
    line({ accountCode: "530505", date: "2026-08-05T00:00:00Z", entryId: "orig", voucherNumber: 7, status: "annulled", source: "manual", memo: "Ajuste", debitCents: 9_000 }),
    line({ accountCode: "110505", date: "2026-08-06T00:00:00Z", entryId: "rev", voucherNumber: 8, status: "posted", source: "manual", memo: "Reversa de #000007", debitCents: 9_000 }),
    line({ accountCode: "530505", date: "2026-08-06T00:00:00Z", entryId: "rev", voucherNumber: 8, status: "posted", source: "manual", memo: "Reversa de #000007", creditCents: 9_000 }),
  ];

  it("original anulado + reversa suman cero en la cuenta y ambos aparecen (el anulado marcado)", () => {
    const gl = buildGeneralLedger(reversalCase, accounts, { from, to });
    const caja = gl.accounts.find((a) => a.code === "110505")!;
    expect(caja).toMatchObject({ initialCents: 0, debitCents: 9_000, creditCents: 9_000, balanceCents: 0 });
    expect(caja.movements.map((m) => [m.entryId, m.voided, m.runningCents])).toEqual([
      ["orig", true, -9_000],
      ["rev", false, 0],
    ]);
    const gastos = gl.accounts.find((a) => a.code === "530505")!;
    expect(gastos.balanceCents).toBe(0);
    expect(gl.totals).toEqual({ debitCents: 18_000, creditCents: 18_000 });
    expect(gl.balanced).toBe(true);
  });

  it("un anulado anterior al «desde» también entra en el saldo inicial (junto con su reversa)", () => {
    const gl = buildGeneralLedger(reversalCase, accounts, {
      from: new Date("2026-08-07T00:00:00Z"),
      to,
      accountCode: "110505",
    });
    expect(gl.accounts[0]).toMatchObject({ initialCents: 0, movements: [] });
  });

  it("sin `status` (asientos viejos) el movimiento no se marca", () => {
    const gl = buildGeneralLedger(lines, accounts, { from, to });
    expect(gl.accounts.flatMap((a) => a.movements).every((m) => m.voided === false)).toBe(true);
    expect(isAnnulled(undefined)).toBe(false);
    expect(isAnnulled("posted")).toBe(false);
    expect(isAnnulled("annulled")).toBe(true);
  });
});

describe("CSV del mayor", () => {
  it("formatVoucherNumber → #000123", () => {
    expect(formatVoucherNumber(123)).toBe("#000123");
    expect(formatVoucherNumber(null)).toBeNull();
  });

  it("fila de saldo inicial por cuenta + una por movimiento", () => {
    const gl = buildGeneralLedger(lines, accounts, { from, to, accountCode: "110505" });
    const rows = generalLedgerCsvRows(gl, {
      initial: "Saldo inicial",
      unnumbered: "s/n",
      voided: "ANULADO",
      sourceLabel: (s) => `src:${s}`,
    });
    expect(rows[0]).toEqual(["110505", "Caja general", "", "", "", "Saldo inicial", 0, 0, 100_000]);
    expect(rows[1]).toEqual(["110505", "Caja general", "2026-08-10", "#000011", "src:expense_payment", "", 0, 20_000, 80_000]);
    expect(rows[3][3]).toBe("s/n");
  });

  it("un movimiento anulado lleva la marca en la descripción", () => {
    const gl = buildGeneralLedger(
      [line({ accountCode: "110505", date: "2026-08-05T00:00:00Z", status: "annulled", memo: "Ajuste", creditCents: 9_000 })],
      accounts,
      { from, to },
    );
    const rows = generalLedgerCsvRows(gl, {
      initial: "Saldo inicial",
      unnumbered: "s/n",
      voided: "ANULADO",
      sourceLabel: (s) => s,
    });
    expect(rows[1][5]).toBe("ANULADO · Ajuste");
  });
});
