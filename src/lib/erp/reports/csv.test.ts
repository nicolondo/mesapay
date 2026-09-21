import { describe, expect, it } from "vitest";
import { buildReportCsv, centsToCsv, csvCell, csvResponse, CSV_BOM } from "./csv";

describe("centsToCsv", () => {
  it("dos decimales con coma, sin separador de miles, negativos incluidos", () => {
    expect(centsToCsv(123456)).toBe("1234,56");
    expect(centsToCsv(0)).toBe("0,00");
    expect(centsToCsv(-5)).toBe("-0,05");
    expect(centsToCsv(100)).toBe("1,00");
  });
});

describe("csvCell", () => {
  it("guardia de inyección: = + - @ tab CR se prefijan con apóstrofo", () => {
    expect(csvCell("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(csvCell("+57")).toBe("'+57");
    expect(csvCell("-abc")).toBe("'-abc");
    expect(csvCell("@x")).toBe("'@x");
    expect(csvCell("\tx")).toBe("'\tx");
  });

  it("los números son centavos y NO pasan por la guardia (un monto negativo sale limpio)", () => {
    expect(csvCell(-123456)).toBe("-1234,56");
  });

  it("entrecomilla si hay ; comillas o saltos", () => {
    expect(csvCell("a;b")).toBe('"a;b"');
    expect(csvCell('di "hola"')).toBe('"di ""hola"""');
    expect(csvCell("dos\nlíneas")).toBe('"dos\nlíneas"');
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });
});

describe("buildReportCsv", () => {
  it("BOM al frente, ; como separador, CRLF, encabezados y filas", () => {
    const csv = buildReportCsv({
      headers: ["Código", "Cuenta", "Saldo"],
      rows: [["110505", "Caja general", 150000]],
    });
    expect(csv.startsWith(CSV_BOM)).toBe(true);
    expect(csv.slice(1).split("\r\n")).toEqual(["Código;Cuenta;Saldo", "110505;Caja general;1500,00"]);
  });

  it("note va como PRIMERA fila, antes de los encabezados", () => {
    const csv = buildReportCsv({
      headers: ["A"],
      rows: [["x"]],
      note: "Totales del filtro aplicado",
    });
    expect(csv.slice(1).split("\r\n")[0]).toBe("Totales del filtro aplicado");
    expect(csv.slice(1).split("\r\n")[1]).toBe("A");
  });

  it("sin note el archivo arranca por los encabezados", () => {
    const csv = buildReportCsv({ headers: ["A"], rows: [] , note: null });
    expect(csv).toBe(`${CSV_BOM}A`);
  });
});

describe("csvResponse", () => {
  it("descarga con content-type CSV utf-8 y nombre saneado", async () => {
    const res = csvResponse('balance"x\n.csv', CSV_BOM + "a;b");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="balance_x_.csv"');
    // `text()` descarta el BOM por spec: se miran los BYTES (EF BB BF).
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder().decode(bytes)).toBe("a;b");
  });
});
