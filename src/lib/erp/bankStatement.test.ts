// Extracto bancario: con la fila de títulos se lee por columnas (el saldo
// ya no se toma como monto; débito y crédito separados dan el signo), y
// pegar el mismo extracto dos veces no duplica.
import { describe, expect, it } from "vitest";
import { dedupeBankLines, parseAmountCell, parseBankStatement } from "./bankStatement";

describe("parseBankStatement", () => {
  it("con títulos Valor;Saldo toma el valor, no el saldo", () => {
    const { lines, byHeader, skipped } = parseBankStatement(
      ["Fecha;Descripción;Sucursal;Dcto;Valor;Saldo", "15/10/2026;PAGO PROVEEDOR;0012;4567;-250.000,00;1.750.000,00"].join("\n"),
    );
    expect(byHeader).toBe(true);
    expect(skipped).toBe(0);
    expect(lines).toEqual([
      { date: new Date("2026-10-15T00:00:00Z"), description: "PAGO PROVEEDOR · 0012 · 4567", amountCents: -25_000_000 },
    ]);
  });

  it("con Débito y Crédito en columnas separadas, el débito sale negativo", () => {
    const { lines } = parseBankStatement(
      ["fecha,descripcion,debito,credito,saldo", "2026-10-01,ARRIENDO,3000000,,500000", "2026-10-02,CONSIGNACION,,1200000,1700000"].join("\n"),
    );
    expect(lines.map((l) => l.amountCents)).toEqual([-300_000_000, 120_000_000]);
    expect(lines[0]!.description).toBe("ARRIENDO");
  });

  it("sin títulos mantiene la lectura de siempre (última celda numérica)", () => {
    const { lines, byHeader } = parseBankStatement("2026-10-03;COMISION;-15.000");
    expect(byHeader).toBe(false);
    expect(lines).toEqual([{ date: new Date("2026-10-03T00:00:00Z"), description: "COMISION", amountCents: -1_500_000 }]);
  });

  it("cuenta como omitidas las filas sin fecha o sin monto y rechaza fechas imposibles", () => {
    const { lines, skipped } = parseBankStatement(["Fecha;Descripción;Valor", "31/02/2026;X;100", "sin fecha;X;100", "01/10/2026;X;"].join("\n"));
    expect(lines).toEqual([]);
    expect(skipped).toBe(3);
  });

  it("parseAmountCell entiende los formatos de la banca colombiana", () => {
    expect(parseAmountCell("1.234.567,89")).toBe(123_456_789);
    expect(parseAmountCell("1,234,567.89")).toBe(123_456_789);
    expect(parseAmountCell("(500)")).toBe(-50_000);
    expect(parseAmountCell("$ 1.000")).toBe(100_000);
    expect(parseAmountCell("PAGO")).toBeNull();
  });
});

describe("dedupeBankLines", () => {
  const line = (amountCents: number, description = "PAGO PSE") => ({
    date: new Date("2026-10-05T00:00:00Z"),
    description,
    amountCents,
  });

  it("pegar el mismo extracto dos veces no duplica", () => {
    const pasted = [line(-10_000), line(20_000)];
    expect(dedupeBankLines(pasted, pasted)).toEqual({ fresh: [], duplicates: 2 });
  });

  it("dos movimientos iguales del mismo día entran los dos la primera vez; al repegar, ninguno", () => {
    const pasted = [line(-10_000), line(-10_000)];
    expect(dedupeBankLines(pasted, []).fresh).toHaveLength(2);
    expect(dedupeBankLines(pasted, [line(-10_000)])).toEqual({ fresh: [line(-10_000)], duplicates: 1 });
  });

  it("compara la descripción sin tildes ni mayúsculas", () => {
    expect(dedupeBankLines([line(5_000, "Consignación")], [line(5_000, "CONSIGNACION")]).duplicates).toBe(1);
  });
});
