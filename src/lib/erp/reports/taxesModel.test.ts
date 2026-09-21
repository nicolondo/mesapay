import { describe, expect, it } from "vitest";
import {
  buildTaxAccountReport,
  classifyTaxAccount,
  familySubtotal,
  RETENTION_PREFIXES,
  signedMovement,
  TAX_ACCOUNT_FAMILIES,
  TAX_ACCOUNT_PREFIXES,
  type TaxAccount,
  type TaxLedgerLine,
} from "./taxesModel";

const acc = (code: string, type: string, name = code): TaxAccount => ({ code, name, type });
const line = (accountCode: string, debitCents: number, creditCents: number): TaxLedgerLine => ({
  accountCode,
  debitCents,
  creditCents,
});

describe("clasificación de cuentas tributarias", () => {
  it("gana el prefijo MÁS LARGO (135515 antes que 1355)", () => {
    expect(classifyTaxAccount("135515", "activo")).toBe("retefuente-favor");
    expect(classifyTaxAccount("13551501", "activo")).toBe("retefuente-favor");
    expect(classifyTaxAccount("135517", "activo")).toBe("reteiva-favor");
    expect(classifyTaxAccount("135518", "activo")).toBe("reteica-favor");
    expect(classifyTaxAccount("135505", "activo")).toBe("anticipos");
  });

  it("el grupo 24 completo es «por pagar», con familia propia para IVA / INC / ICA / renta", () => {
    expect(classifyTaxAccount("2408", "pasivo")).toBe("iva");
    expect(classifyTaxAccount("24080501", "pasivo")).toBe("iva");
    expect(classifyTaxAccount("24081001", "pasivo")).toBe("iva");
    expect(classifyTaxAccount("240405", "pasivo")).toBe("renta");
    // Cualquier otro impuesto del grupo 24 existe sin estar en lista cerrada.
    expect(classifyTaxAccount("249505", "pasivo")).toBe("otros-impuestos");
  });

  it("INC e ICA siguen al PUC del motor de MESAPAY (241205 = INC, 241605 = ICA), no al de zenith", () => {
    expect(classifyTaxAccount("241205", "pasivo")).toBe("consumo");
    expect(classifyTaxAccount("2412", "pasivo")).toBe("consumo");
    expect(classifyTaxAccount("241605", "pasivo")).toBe("ica");
    expect(TAX_ACCOUNT_FAMILIES.find((f) => f.key === "consumo")?.prefix).toBe("2412");
    expect(TAX_ACCOUNT_FAMILIES.find((f) => f.key === "ica")?.prefix).toBe("2416");
  });

  it("las retenciones practicadas van por 2365 / 2367 / 2368", () => {
    expect(classifyTaxAccount("236505", "pasivo")).toBe("retefuente");
    expect(classifyTaxAccount("2367", "pasivo")).toBe("reteiva");
    expect(classifyTaxAccount("236805", "pasivo")).toBe("reteica");
  });

  it("la cuenta de un concepto de retención va a la familia de su kind, esté donde esté", () => {
    expect(classifyTaxAccount("289505", "pasivo", "reteiva")).toBe("reteiva");
    expect(classifyTaxAccount("139530", "activo", "retefuente")).toBe("retefuente-favor");
    // Un kind desconocido no manda: sigue el prefijo.
    expect(classifyTaxAccount("236505", "pasivo", "raro")).toBe("retefuente");
  });

  it("fuera de todo prefijo se clasifica por NATURALEZA", () => {
    expect(classifyTaxAccount("280505", "pasivo")).toBe("otras-pagar");
    expect(classifyTaxAccount("139530", "activo")).toBe("otras-favor");
  });

  it("los prefijos raíz que se consultan no se solapan", () => {
    expect([...TAX_ACCOUNT_PREFIXES].sort()).toEqual(["1355", "2365", "2367", "2368", "24"]);
    expect([...RETENTION_PREFIXES].sort()).toEqual([
      "135515",
      "135517",
      "135518",
      "2365",
      "2367",
      "2368",
    ]);
  });
});

describe("signo por naturaleza de la cuenta", () => {
  it("el pasivo crece al crédito y el activo al débito", () => {
    expect(signedMovement("pasivo", { debitCents: 0, creditCents: 190_000 })).toBe(190_000);
    expect(signedMovement("activo", { debitCents: 75_000, creditCents: 0 })).toBe(75_000);
    expect(signedMovement("ingreso", { debitCents: 0, creditCents: 10 })).toBe(10);
    expect(signedMovement("gasto", { debitCents: 10, creditCents: 0 })).toBe(10);
  });

  it("un período que revierte el movimiento sale NEGATIVO (anulaciones, pagos)", () => {
    expect(signedMovement("pasivo", { debitCents: 500_000, creditCents: 200_000 })).toBe(-300_000);
    expect(signedMovement("activo", { debitCents: 0, creditCents: 40_000 })).toBe(-40_000);
  });
});

describe("reporte de familias del período", () => {
  const accounts: TaxAccount[] = [
    // IVA: madre de 6 dígitos (asientos viejos) + auxiliares de 8.
    acc("240805", "pasivo", "IVA generado en ventas"),
    acc("24080501", "pasivo", "IVA generado 19%"),
    acc("24081001", "pasivo", "IVA descontable 19%"),
    // Retefuente practicada: madre + auxiliar.
    acc("2365", "pasivo", "Retención en la fuente"),
    acc("236505", "pasivo", "Retención en la fuente por pagar"),
    // Retefuente que nos practicaron.
    acc("135515", "activo", "Retención en la fuente"),
    // INC del motor.
    acc("241205", "pasivo", "INC por pagar (8%)"),
    // Sin movimiento en el período.
    acc("241605", "pasivo", "ICA por pagar"),
    // Con movimiento pero neto cero (se causó y se pagó dentro del período).
    acc("240405", "pasivo", "Impuesto de renta por pagar"),
  ];
  const lines: TaxLedgerLine[] = [
    line("240805", 0, 100_000),
    line("24080501", 0, 600_000),
    line("24080501", 0, 300_000), // dos asientos sobre la misma cuenta se suman
    line("24081001", 400_000, 0),
    line("2365", 0, 50_000),
    line("236505", 0, 25_000),
    line("135515", 30_000, 0),
    line("241205", 0, 80_000),
    line("240405", 70_000, 70_000),
  ];
  const report = buildTaxAccountReport(lines, accounts);
  const pagar = report.groups.find((g) => g.key === "pagar");
  const favor = report.groups.find((g) => g.key === "favor");
  const family = (key: string) => pagar?.families.find((f) => f.key === key);

  it("los 6 y los 8 dígitos ruedan a la MISMA familia (sin migrar asientos)", () => {
    const iva = family("iva");
    expect(iva?.rows.map((r) => r.code)).toEqual(["240805", "24080501", "24081001"]);
    // 100.000 + 900.000 generado − 400.000 descontable = 600.000 por pagar.
    expect(iva?.subtotalCents).toBe(600_000);
    expect(iva?.rows.find((r) => r.code === "24080501")?.valorCents).toBe(900_000);
    expect(family("retefuente")?.subtotalCents).toBe(75_000);
  });

  it("las familias se agrupan por NATURALEZA con sus totales", () => {
    // 600.000 IVA + 80.000 INC + 75.000 retefuente.
    expect(report.totalPorPagarCents).toBe(755_000);
    expect(report.totalAFavorCents).toBe(30_000);
    expect(pagar?.families.map((f) => f.key)).toEqual(["iva", "consumo", "retefuente"]);
    expect(favor?.families.map((f) => f.key)).toEqual(["retefuente-favor"]);
    expect(pagar?.totalCents).toBe(755_000);
    expect(favor?.totalCents).toBe(30_000);
  });

  it("familySubtotal lee cualquier familia (0 si no tiene movimiento)", () => {
    expect(familySubtotal(report, "iva")).toBe(600_000);
    expect(familySubtotal(report, "consumo")).toBe(80_000);
    expect(familySubtotal(report, "retefuente-favor")).toBe(30_000);
    expect(familySubtotal(report, "ica")).toBe(0);
  });

  it("sin movimiento (o con neto cero) la familia NO se muestra", () => {
    expect(family("ica")).toBeUndefined();
    expect(family("renta")).toBeUndefined();
  });

  it("un comercio sin movimiento tributario no produce grupos", () => {
    expect(buildTaxAccountReport([], accounts)).toEqual({
      groups: [],
      totalAFavorCents: 0,
      totalPorPagarCents: 0,
    });
  });

  it("la cuenta de un concepto de retención se clasifica por su kind aunque el código no calce", () => {
    const r = buildTaxAccountReport(
      [line("289505", 0, 12_000)],
      [acc("289505", "pasivo", "ReteIVA especial")],
      { conceptKindByCode: new Map([["289505", "reteiva"]]) },
    );
    expect(r.groups[0]?.families[0]).toMatchObject({ key: "reteiva", subtotalCents: 12_000 });
  });

  it("una línea sobre una cuenta que no está en el plan no se pierde: clase 2 → pasivo", () => {
    const r = buildTaxAccountReport([line("236540", 0, 9_000)], []);
    expect(r.totalPorPagarCents).toBe(9_000);
    expect(r.groups[0]?.families[0]?.rows[0]).toEqual({ code: "236540", name: "", valorCents: 9_000 });
  });
});
