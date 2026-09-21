// Cronograma de depreciación (puro): arranca el mes SIGUIENTE a la compra,
// cuota redondeada, la última absorbe el residuo, baja hasta el mes de la
// baja inclusive; progreso por meses contabilizados; agregación por par de
// cuentas; validación del alta.
import { describe, expect, it } from "vitest";
import {
  assetProgress,
  assetSchedule,
  depreciationForAssetMonth,
  depreciationLinesFromPairs,
  depreciationPairsFor,
  monthlyQuotaCents,
  parsePurchaseDate,
  postedMonthChecker,
  startMonth,
  validateAssetInput,
} from "./activos";

const horno = {
  purchaseCents: 12_000_000,
  salvageCents: 0,
  purchaseDate: "2026-07-15",
  usefulLifeMonths: 12,
};

describe("assetSchedule", () => {
  it("el primer mes es el SIGUIENTE al de la compra y cubre exactamente la vida útil", () => {
    expect(startMonth("2026-07-15")).toBe("2026-08");
    expect(startMonth("2026-12-31")).toBe("2027-01");
    const rows = assetSchedule(horno);
    expect(rows).toHaveLength(12);
    expect(rows[0]).toEqual({ month: "2026-08", amountCents: 1_000_000 });
    expect(rows[11]).toEqual({ month: "2027-07", amountCents: 1_000_000 });
    expect(rows.reduce((s, r) => s + r.amountCents, 0)).toBe(12_000_000);
  });

  it("cuota redondeada y la última absorbe el residuo para cerrar exacto", () => {
    const odd = { purchaseCents: 10_000_000, salvageCents: 0, purchaseDate: "2026-01-10", usefulLifeMonths: 3 };
    expect(monthlyQuotaCents(odd)).toBe(3_333_333);
    const rows = assetSchedule(odd);
    expect(rows.map((r) => r.amountCents)).toEqual([3_333_333, 3_333_333, 3_333_334]);
    expect(rows.map((r) => r.month)).toEqual(["2026-02", "2026-03", "2026-04"]);
  });

  it("el salvamento sale de la base", () => {
    expect(monthlyQuotaCents({ ...horno, salvageCents: 3_000_000 })).toBe(750_000);
    expect(assetSchedule({ ...horno, salvageCents: 3_000_000 }).reduce((s, r) => s + r.amountCents, 0)).toBe(
      9_000_000,
    );
  });

  it("dado de baja: sólo los meses hasta el de la baja inclusive", () => {
    const rows = assetSchedule({ ...horno, active: false, disposedAt: new Date("2026-10-20T15:00:00Z") });
    expect(rows.map((r) => r.month)).toEqual(["2026-08", "2026-09", "2026-10"]);
    expect(depreciationForAssetMonth({ ...horno, disposedAt: "2026-10-20" }, "2026-11")).toBe(0);
    expect(depreciationForAssetMonth({ ...horno, disposedAt: "2026-10-20" }, "2026-10")).toBe(1_000_000);
  });

  it("inactivo sin fecha de baja, base cero o vida cero: no deprecia", () => {
    expect(assetSchedule({ ...horno, active: false })).toEqual([]);
    expect(assetSchedule({ ...horno, salvageCents: 12_000_000 })).toEqual([]);
    expect(assetSchedule({ ...horno, usefulLifeMonths: 0 })).toEqual([]);
  });

  it("depreciationForAssetMonth: 0 antes del arranque y después de la vida útil", () => {
    expect(depreciationForAssetMonth(horno, "2026-07")).toBe(0);
    expect(depreciationForAssetMonth(horno, "2026-08")).toBe(1_000_000);
    expect(depreciationForAssetMonth(horno, "2027-08")).toBe(0);
  });
});

describe("assetProgress / postedMonthChecker", () => {
  it("contabilizado = mes cerrado o con asiento del mes", () => {
    const isPosted = postedMonthChecker("2026-09", new Set(["2026-11"]));
    expect(isPosted("2026-08")).toBe(true);
    expect(isPosted("2026-10")).toBe(false);
    expect(isPosted("2026-11")).toBe(true);
    const p = assetProgress(horno, isPosted);
    expect(p).toEqual({
      monthlyCents: 1_000_000,
      depreciatedCents: 3_000_000,
      bookValueCents: 9_000_000,
      postedMonths: 3,
      totalMonths: 12,
    });
  });

  it("sin candado ni asientos no hay nada contabilizado", () => {
    const p = assetProgress(horno, postedMonthChecker(null, new Set()));
    expect(p.depreciatedCents).toBe(0);
    expect(p.bookValueCents).toBe(12_000_000);
  });
});

describe("depreciationPairsFor / depreciationLinesFromPairs", () => {
  const a = { ...horno, expenseAccountCode: "516005", depreciationAccountCode: "159205" };
  const b = {
    ...horno,
    purchaseCents: 6_000_000,
    expenseAccountCode: "516010",
    depreciationAccountCode: "159210",
  };
  const c = { ...horno, purchaseCents: 2_400_000, expenseAccountCode: "516005", depreciationAccountCode: "159205" };

  it("agrupa la cuota del mes por par (gasto, acumulada) y omite lo que no deprecia", () => {
    const pairs = depreciationPairsFor([a, b, c, { ...b, active: false }], "2026-09");
    expect(pairs).toEqual([
      { expenseAccountCode: "516005", depreciationAccountCode: "159205", amountCents: 1_200_000 },
      { expenseAccountCode: "516010", depreciationAccountCode: "159210", amountCents: 500_000 },
    ]);
    expect(depreciationPairsFor([a, b], "2026-07")).toEqual([]);
  });

  it("pares → líneas: Debe gastos / Haber acumuladas, sumadas por cuenta, débitos primero", () => {
    const lines = depreciationLinesFromPairs([
      { expenseAccountCode: "516005", depreciationAccountCode: "159205", amountCents: 100 },
      { expenseAccountCode: "516005", depreciationAccountCode: "159210", amountCents: 50 },
      { expenseAccountCode: "516010", depreciationAccountCode: "159210", amountCents: 25 },
    ]);
    expect(lines).toEqual([
      { code: "516005", debit: 150 },
      { code: "516010", debit: 25 },
      { code: "159205", credit: 100 },
      { code: "159210", credit: 75 },
    ]);
  });
});

describe("validateAssetInput", () => {
  const accounts = new Map([
    ["152005", { active: true, postable: true }],
    ["1520", { active: true, postable: false }],
    ["159205", { active: true, postable: true }],
    ["159299", { active: false, postable: true }],
    ["516005", { active: true, postable: true }],
    ["613505", { active: true, postable: true }],
  ]);
  const good = {
    name: " Horno combi ",
    code: "H-01",
    purchaseDate: "2026-07-15",
    purchaseCents: 12_000_000,
    salvageCents: 1_000_000,
    usefulLifeMonths: 60,
    assetAccountCode: "152005",
    depreciationAccountCode: "159205",
    expenseAccountCode: "516005",
    notes: "",
  };

  it("acepta y normaliza (trim, notas vacías → null, fecha a las 00:00 UTC)", () => {
    const r = validateAssetInput(good, accounts);
    expect(r).toMatchObject({
      ok: true,
      normalized: { name: "Horno combi", code: "H-01", notes: null, purchaseCents: 12_000_000 },
    });
    if (r.ok) expect(r.normalized.purchaseDate.toISOString()).toBe("2026-07-15T00:00:00.000Z");
  });

  it.each([
    [{ name: "H" }, "invalid_name"],
    [{ code: "x".repeat(21) }, "invalid_code"],
    [{ purchaseDate: "2026-02-31" }, "invalid_date"],
    [{ purchaseDate: "15/07/2026" }, "invalid_date"],
    [{ purchaseCents: 0 }, "invalid_purchase"],
    [{ salvageCents: -1 }, "invalid_salvage"],
    [{ salvageCents: 12_000_000 }, "salvage_too_high"],
    [{ usefulLifeMonths: 0 }, "invalid_life"],
    [{ usefulLifeMonths: 601 }, "invalid_life"],
    [{ notes: "n".repeat(1001) }, "invalid_notes"],
    [{ assetAccountCode: "1520" }, "asset_account_invalid"],
    [{ assetAccountCode: "516005" }, "asset_account_invalid"],
    [{ depreciationAccountCode: "159299" }, "depreciation_account_invalid"],
    [{ depreciationAccountCode: "159290" }, "depreciation_account_invalid"],
    [{ expenseAccountCode: "613505" }, "expense_account_invalid"],
    [{ expenseAccountCode: "159205" }, "expense_account_invalid"],
  ])("rechaza %o con %s", (patch, error) => {
    expect(validateAssetInput({ ...good, ...patch }, accounts)).toEqual({ ok: false, error });
  });

  it("parsePurchaseDate acepta compras viejas (1990+) pero no fechas imposibles", () => {
    expect(parsePurchaseDate("2018-03-01")?.toISOString()).toBe("2018-03-01T00:00:00.000Z");
    expect(parsePurchaseDate("1989-12-31")).toBeNull();
    expect(parsePurchaseDate("2026-13-01")).toBeNull();
  });
});
