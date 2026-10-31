import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { deserializeRow, serializeRow } from "@/lib/backups/serialize";
import { tenantModel } from "@/lib/backups/tables";
import { centsToNumber, lineCentsToNumbers } from "./ledgerCents";

/** Ventas mensuales reales de Son y Melona que tumbaron el motor en INT4. */
const SEP_2026 = 9_208_811_100;
const OCT_2026 = 24_179_580_000;
const INT4_MAX = 2_147_483_647;

describe("centsToNumber", () => {
  it.each([0, INT4_MAX, INT4_MAX + 1, SEP_2026, OCT_2026, -OCT_2026, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER])(
    "preserva %s centavos exactos desde bigint y number",
    (amount) => {
      expect(centsToNumber(BigInt(amount))).toBe(amount);
      expect(centsToNumber(amount)).toBe(amount);
    },
  );

  it.each([
    BigInt(Number.MAX_SAFE_INTEGER) + BigInt(1),
    BigInt(Number.MIN_SAFE_INTEGER) - BigInt(1),
    Number.MAX_SAFE_INTEGER + 1,
    1.5,
    NaN,
    Infinity,
  ])("rechaza %s en vez de redondearlo en silencio", (value) => {
    expect(() => centsToNumber(value)).toThrow("ledger_amount_out_of_range");
  });
});

describe("lineCentsToNumbers", () => {
  it("convierte débito y crédito, conserva el resto y no muta la línea", () => {
    const source = Object.freeze({
      id: "l1",
      accountCode: "413505",
      memo: null,
      costCenter: { name: "Salón" },
      debitCents: BigInt(0),
      creditCents: BigInt(OCT_2026),
    });
    const line = lineCentsToNumbers(source);
    expect(line).toEqual({ ...source, debitCents: 0, creditCents: OCT_2026 });
    expect(line.costCenter).toBe(source.costCenter);
    expect(source.creditCents).toBe(BigInt(OCT_2026));
    expect(JSON.parse(JSON.stringify(line)).creditCents).toBe(OCT_2026);
  });
});

/**
 * Contrato con la migración 20261101090000_journal_amounts_bigint: si alguna
 * de estas columnas volviera a `Int`, el asiento-resumen mensual de un
 * comercio mediano vuelve a reventar con "Unable to fit integer value".
 */
describe("columnas contables en BIGINT", () => {
  const BIGINT_FIELDS: Record<string, string[]> = {
    JournalLine: ["debitCents", "creditCents"],
    FixedAsset: ["purchaseCents", "salvageCents"],
    DeferredItem: ["totalCents"],
    Budget: ["monthlyCents"],
    TaxFiling: ["declaredCents"],
    BankStatementLine: ["amountCents"],
  };

  it.each(Object.entries(BIGINT_FIELDS))("%s guarda sus montos como BigInt", (model, fields) => {
    const dmmf = Prisma.dmmf.datamodel.models.find((m) => m.name === model);
    expect(dmmf).toBeDefined();
    for (const name of fields) {
      expect(dmmf!.fields.find((f) => f.name === name)?.type).toBe("BigInt");
    }
  });

  it("los respaldos siguen ida y vuelta con montos > INT4 (y con respaldos viejos en number)", () => {
    const fields = tenantModel("JournalLine")!.fields;
    const row = { id: "l1", entryId: "e1", accountId: "a1", accountCode: "110505", debitCents: BigInt(OCT_2026), creditCents: BigInt(0), memo: null, costCenterId: null };
    const json = JSON.parse(JSON.stringify(serializeRow(fields, row)));
    expect(json.debitCents).toBe(String(OCT_2026));
    expect(deserializeRow(fields, json)).toMatchObject({ debitCents: BigInt(OCT_2026), creditCents: BigInt(0) });
    // Un respaldo tomado antes de la migración trae los centavos como number.
    expect(deserializeRow(fields, { ...json, debitCents: 12_345 })).toMatchObject({ debitCents: BigInt(12_345) });
  });
});
