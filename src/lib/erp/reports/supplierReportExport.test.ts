import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import {
  parseSupplierReportQuery,
  supplierDocument,
  supplierReportTotals,
  type SupplierReportRow,
} from "./supplierReport";
import {
  supplierExportHeaders,
  supplierReportCsv,
  supplierReportFilename,
  supplierReportXlsx,
  type SupplierExportContext,
} from "./supplierReportExport";
import { monthLabel, periodLabel } from "./supplierReportLabels";

/** Traductor de prueba: la clave, y sus variables si las hay. */
const t = (key: string, values?: Record<string, string | number>) =>
  values ? `${key}(${Object.entries(values).map(([k, v]) => `${k}=${v}`).join(",")})` : key;

const TODAY = "2026-11-13";
const query = parseSupplierReportQuery({}, TODAY);

const ROWS: SupplierReportRow[] = [
  {
    supplierId: "s1",
    name: "Lácteos del Valle",
    active: true,
    document: supplierDocument("900123456-7", null),
    creditDays: 30,
    totalCents: 1_200_050,
    averageCents: 100_004,
    invoices: 3,
    lastPurchase: "2026-10-05",
    payableCents: 250_000,
    agreementCents: 30_000,
  },
  {
    supplierId: "s2",
    // Un nombre que una hoja de cálculo ejecutaría como fórmula.
    name: "=HYPERLINK(\"x\")",
    active: false,
    document: supplierDocument("0012345", "CC"),
    creditDays: null,
    totalCents: 0,
    averageCents: 0,
    invoices: 0,
    lastPurchase: null,
    payableCents: 0,
    agreementCents: 0,
  },
];
const totals = supplierReportTotals(ROWS, query.period.months);
// El rótulo del mes depende del ICU del runtime («nov 2025» / «nov de 2025»).
const PERIOD = periodLabel(query.period, "es");
const NOV = monthLabel("2025-11", "es");
const OCT = monthLabel("2026-10", "es");

function ctx(over: Partial<SupplierExportContext> = {}): SupplierExportContext {
  return {
    t,
    locale: "es",
    currency: "COP",
    business: { name: "Comercio de prueba", taxId: "900000001-1" },
    query,
    now: new Date("2026-11-13T15:00:00Z"),
    ...over,
  };
}

describe("exportación — CSV", () => {
  const csv = supplierReportCsv(ROWS, totals, ctx());
  const lines = csv.replace(/^﻿/, "").split("\r\n");

  it("lleva BOM, la nota del período y los encabezados en el orden de los datos", () => {
    expect(csv.startsWith("﻿")).toBe(true);
    expect(lines[0]).toBe(`csvNote(period=${PERIOD},months=12,basis=basisCost,include=includeAll)`);
    expect(lines[1]).toBe(supplierExportHeaders(t).join(";"));
  });

  it("una fila por proveedor, montos con coma decimal y fecha ISO, más la fila de total", () => {
    expect(lines).toHaveLength(2 + ROWS.length + 1);
    expect(lines[2]).toBe(
      "Lácteos del Valle;NIT;900123456;7;credit(days=30);30;1000,04;12000,50;3;2026-10-05;2500,00;300,00;active",
    );
    expect(lines[4]).toBe("totalRow(n=2);;;;;;1000,04;12000,50;3;;2500,00;300,00;");
  });

  it("un nombre que empieza como fórmula sale como texto; el documento conserva sus ceros", () => {
    expect(lines[3]).toBe(`"'=HYPERLINK(""x"")";CC;0012345;;cash;0;0,00;0,00;0;;0,00;0,00;inactive`);
  });
});

describe("exportación — Excel", () => {
  async function load(over: Partial<SupplierExportContext> = {}) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await supplierReportXlsx(ROWS, totals, ctx(over))) as unknown as ArrayBuffer);
    return wb;
  }

  it("hoja de datos: encabezados, números de verdad, fechas como fecha y documento como texto", async () => {
    const wb = await load();
    expect(wb.worksheets.map((w) => w.name)).toEqual(["sheetData", "sheetInfo"]);
    const ws = wb.getWorksheet("sheetData")!;
    expect(ws.getRow(1).values).toEqual([undefined, ...supplierExportHeaders(t)]);
    const r = ws.getRow(2);
    expect(r.getCell(1).value).toBe("Lácteos del Valle");
    expect(r.getCell(3).value).toBe("900123456");
    expect(r.getCell(3).numFmt).toBe("@");
    expect(r.getCell(7).value).toBe(1000.04);
    expect(r.getCell(7).numFmt).toBe("#,##0");
    expect(r.getCell(8).value).toBe(12000.5);
    expect(r.getCell(9).value).toBe(3);
    expect(r.getCell(10).value).toEqual(new Date("2026-10-05T00:00:00Z"));
    expect(r.getCell(10).numFmt).toBe("yyyy-mm-dd");
    expect(r.getCell(11).value).toBe(2500);
    // Recibido por acuerdos comerciales: plata, antes del estado.
    expect(r.getCell(12).value).toBe(300);
    expect(r.getCell(12).numFmt).toBe("#,##0");
    expect(r.getCell(13).value).toBe("active");
    // Texto tal cual: en un .xlsx una celda de texto no es fórmula.
    expect(ws.getRow(3).getCell(1).value).toBe("=HYPERLINK(\"x\")");
    expect(ws.getRow(3).getCell(3).value).toBe("0012345");
    const total = ws.getRow(4);
    expect(total.getCell(1).value).toBe("totalRow(n=2)");
    expect(total.getCell(8).value).toBe(12000.5);
    expect(total.getCell(12).value).toBe(300);
    expect(total.font?.bold).toBe(true);
    expect(ws.rowCount).toBe(4);
  });

  it("monedas con centavos usan dos decimales", async () => {
    const ws = (await load({ currency: "USD" })).getWorksheet("sheetData")!;
    expect(ws.getRow(2).getCell(7).numFmt).toBe("#,##0.00");
  });

  it("hoja de información: comercio, período, divisor, base y definición del promedio", async () => {
    const info = (await load()).getWorksheet("sheetInfo")!;
    const pairs = new Map<string, unknown>();
    info.eachRow((row) => pairs.set(String(row.getCell(1).value), row.getCell(2).value));
    expect(pairs.get("infoBusiness")).toBe("Comercio de prueba");
    expect(pairs.get("infoPeriod")).toBe(PERIOD);
    expect(PERIOD).toBe(`${NOV} – ${OCT}`);
    expect(pairs.get("infoMonths")).toBe(12);
    expect(pairs.get("infoBasis")).toBe("basisCost");
    expect(pairs.get("infoInclude")).toBe("includeAll");
    expect(pairs.get("infoRows")).toBe(2);
    expect([...pairs.keys()]).toContain(`definitionBody(from=${NOV},to=${OCT},months=12)`);
    expect([...pairs.keys()]).toContain("definitionAgreements");
  });

  it("nombre del archivo con el período", () => {
    expect(supplierReportFilename(query.period, "xlsx")).toBe("proveedores-2025-11-a-2026-10.xlsx");
    expect(supplierReportFilename(query.period, "csv")).toBe("proveedores-2025-11-a-2026-10.csv");
  });
});
