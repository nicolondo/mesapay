import { describe, expect, it } from "vitest";
import { buildIncomeStatement, type ResultAccountInput, type ResultMovement } from "./incomeStatement";

const ACCOUNTS: ResultAccountInput[] = [
  { code: "413505", name: "Venta de alimentos", type: "ingreso" },
  { code: "421040", name: "Descuentos comerciales condicionados", type: "ingreso" },
  { code: "613505", name: "Costo de alimentos y bebidas", type: "costo" },
  { code: "613570", name: "Descuentos y rebajas en compras", type: "costo" },
  { code: "613575", name: "Acuerdos comerciales con proveedores", type: "costo" },
  { code: "61357501", name: "Bonificación cerveza", type: "costo" },
];

const mv = (accountCode: string, movementCents: number, month = "2026-11"): ResultMovement => ({ accountCode, month, movementCents });

describe("estado de resultado: acuerdos comerciales con proveedores", () => {
  const statement = (movements: ResultMovement[]) =>
    buildIncomeStatement({ movements, accounts: ACCOUNTS, country: "CO", from: "2026-11-01", to: "2026-11-30" });

  it("renglón propio con lo recibido por acuerdos (y sus auxiliares); costos sin ellos; el total no cambia", () => {
    const st = statement([
      mv("413505", -1_000_000),
      mv("613505", 400_000),
      mv("613570", -20_000), // descuento puntual: dentro de costos
      mv("613575", -30_000),
      mv("61357501", -5_000),
    ]);
    const line = (key: string) => st.cascade.find((r) => r.key === key);
    const costs = line("costo-inv");
    const agreements = line("costo-acuerdos");
    expect(costs && "valueCents" in costs ? costs.valueCents : null).toBe(-380_000);
    expect(agreements && "valueCents" in agreements ? agreements.valueCents : null).toBe(35_000);
    expect(st.summary.costCents).toBe(345_000);
    expect(st.summary.resultCents).toBe(655_000);
  });

  it("sin acuerdos en el período no aparece el renglón", () => {
    const st = statement([mv("413505", -100), mv("613505", 40)]);
    expect(st.cascade.some((r) => r.key === "costo-acuerdos")).toBe(false);
  });

  it("el pronto pago queda en ingresos financieros (4210)", () => {
    const st = statement([mv("413505", -1_000), mv("421040", -50)]);
    const fin = st.cascade.find((r) => r.key === "ing-fin");
    expect(fin && "valueCents" in fin ? fin.valueCents : null).toBe(50);
  });
});
