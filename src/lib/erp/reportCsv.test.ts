// Dialecto CSV de reportes: `;`, coma decimal, BOM, CRLF y anti-fórmula.
import { describe, expect, it } from "vitest";
import { buildReportCsv, csvAmount } from "./reportCsv";

describe("csvAmount", () => {
  it("centavos → unidades con coma y dos decimales, sin miles", () => {
    expect(csvAmount(1234567)).toBe("12345,67");
    expect(csvAmount(0)).toBe("0,00");
    expect(csvAmount(5)).toBe("0,05");
    expect(csvAmount(-1050)).toBe("-10,50");
  });
});

describe("buildReportCsv", () => {
  it("BOM + encabezados + filas con `;` y CRLF", () => {
    const csv = buildReportCsv({
      headers: ["Fecha", "Débito"],
      rows: [["2026-09-10", 100000]],
    });
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv).toBe("﻿Fecha;Débito\r\n2026-09-10;1000,00\r\n");
  });

  it("entrecomilla texto con `;` o comillas y neutraliza fórmulas", () => {
    const csv = buildReportCsv({
      headers: ["a"],
      rows: [["=SUM(A1)"], ["+1"], ["-x"], ["@cmd"], ['dice "hola"; chau'], [null], [undefined]],
    });
    const lines = csv.replace("﻿", "").split("\r\n");
    expect(lines[1]).toBe("'=SUM(A1)");
    expect(lines[2]).toBe("'+1");
    expect(lines[3]).toBe("'-x");
    expect(lines[4]).toBe("'@cmd");
    expect(lines[5]).toBe('"dice ""hola""; chau"');
    expect(lines[6]).toBe("");
    expect(lines[7]).toBe("");
  });

  it("los montos negativos NO se prefijan (son números, no texto)", () => {
    const csv = buildReportCsv({ headers: ["m"], rows: [[-250]] });
    expect(csv).toContain("\r\n-2,50\r\n");
  });

  it("la nota opcional va antes de los encabezados", () => {
    const csv = buildReportCsv({ headers: ["a"], rows: [], note: "Empresa; NIT 1" });
    expect(csv).toBe('﻿"Empresa; NIT 1"\r\na\r\n');
  });
});
