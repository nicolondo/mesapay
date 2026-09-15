import { describe, expect, it } from "vitest";
import { writeFile } from "fs/promises";
import ExcelJS from "exceljs";
import {
  PAYMENT_METHOD_ROWS,
  buildOnboardingWorkbook,
  formatNitWithDv,
  splitPersonName,
  type OnboardingWorkbookInput,
} from "./onboardingWorkbook";

// Datos ficticios: ninguna persona ni comercio real.
const input: OnboardingWorkbookInput = {
  legalName: "SON Y MELONA S.A.S.",
  taxId: "901944469",
  city: "Envigado",
  address: "CR 6 24 A SUR 285 LC 104",
  legalRepName: "MARIA FERNANDA LOPEZ GOMEZ",
  legalRepDocNumber: "1.020.304.050",
  contactEmail: "test@example.test",
  contactPhone: "3001234567",
};

async function load(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  // exceljs tipa `load` con su propio `Buffer extends ArrayBuffer`, que no
  // coincide con el Buffer<ArrayBufferLike> de @types/node; en runtime acepta
  // un Buffer de Node sin problema.
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  return wb;
}

function fillRgb(cell: ExcelJS.Cell): string | undefined {
  const fill = cell.fill as ExcelJS.FillPattern | undefined;
  return fill?.fgColor?.argb;
}

describe("buildOnboardingWorkbook — Datos de Negocio", () => {
  it("replica las hojas y los encabezados del formulario de Kushki", async () => {
    const wb = await load(await buildOnboardingWorkbook(input));
    expect(wb.worksheets.map((w) => w.name)).toEqual([
      "Datos de Negocio",
      "Métodos de Pago",
    ]);
    const ws = wb.getWorksheet("Datos de Negocio")!;
    const headers = Array.from({ length: 12 }, (_, i) =>
      ws.getCell(1, i + 1).value,
    );
    expect(headers).toEqual([
      "Razón Social",
      "Tipo de Identificación",
      "Número de identificación",
      "Ciudad",
      "Dirección",
      "Nombre de Rep. Legal",
      "N° Identificación de Rep. Legal",
      "Nombre Contacto Principal",
      "Apellido Contacto Principal",
      "Email Contacto Principal",
      "Teléfono Contato Principal",
      "# Terminales",
    ]);
  });

  it("escribe los datos del comercio con los tipos que espera Salesforce", async () => {
    const wb = await load(await buildOnboardingWorkbook(input));
    const ws = wb.getWorksheet("Datos de Negocio")!;
    expect(ws.getCell("A2").value).toBe("SON Y MELONA S.A.S.");
    expect(ws.getCell("B2").value).toBe("NIT");
    expect(ws.getCell("C2").value).toBe("901944469-1");
    expect(ws.getCell("D2").value).toBe("Envigado");
    expect(ws.getCell("E2").value).toBe("CR 6 24 A SUR 285 LC 104");
    expect(ws.getCell("F2").value).toBe("MARIA FERNANDA LOPEZ GOMEZ");
    expect(ws.getCell("G2").value).toBe(1020304050);
    expect(ws.getCell("G2").numFmt).toBe("#,##0");
    expect(ws.getCell("H2").value).toBe("MARIA FERNANDA");
    expect(ws.getCell("I2").value).toBe("LOPEZ GOMEZ");
    expect(ws.getCell("J2").value).toBe("test@example.test");
    expect(ws.getCell("K2").value).toBe(3001234567);
    expect(ws.getCell("L2").value).toBe(1);
  });

  it("acepta el NIT ya con DV sin duplicarlo", async () => {
    const wb = await load(
      await buildOnboardingWorkbook({ ...input, taxId: "901944469-1" }),
    );
    expect(wb.getWorksheet("Datos de Negocio")!.getCell("C2").value).toBe(
      "901944469-1",
    );
  });

  it("aplica los estilos de encabezado del formulario", async () => {
    const wb = await load(await buildOnboardingWorkbook(input));
    const ws = wb.getWorksheet("Datos de Negocio")!;
    expect(fillRgb(ws.getCell("A1"))).toMatch(/CFE2F3$/i);
    expect(ws.getCell("A1").font.bold).toBe(true);
    expect(ws.getCell("A1").font.name).toBe("Arial");
    expect(ws.getCell("A1").border.top?.style).toBe("thin");
    expect(fillRgb(ws.getCell("H1"))).toMatch(/D9EAD3$/i);
    expect(fillRgb(ws.getCell("L1"))).toMatch(/FFFF00$/i);
    expect(ws.getCell("A2").font.name).toBe("Calibri");
  });

  it("conserva los anchos de columna del formulario", async () => {
    const wb = await load(await buildOnboardingWorkbook(input));
    const widths = (name: string, cols: string) =>
      cols.split("").map((c) => wb.getWorksheet(name)!.getColumn(c).width);
    expect(widths("Datos de Negocio", "ABCFGHIJKL")).toEqual([
      17, 17, 26.2, 30.3, 31.7, 25.7, 26, 23.5, 25.3, 16.5,
    ]);
    expect(widths("Métodos de Pago", "ABCDE")).toEqual([31, 16.8, 18.2, 12.3, 17.3]);
  });

  it("no lanza con ciudad, dirección y representante en null", async () => {
    const wb = await load(
      await buildOnboardingWorkbook({
        ...input,
        city: null,
        address: null,
        legalRepName: null,
        legalRepDocNumber: null,
      }),
    );
    const ws = wb.getWorksheet("Datos de Negocio")!;
    for (const ref of ["D2", "E2", "F2", "G2", "H2", "I2"]) {
      expect(ws.getCell(ref).value ?? "").toBe("");
    }
  });

  it("deja el teléfono como texto cuando trae prefijo o espacios", async () => {
    const wb = await load(
      await buildOnboardingWorkbook({ ...input, contactPhone: "+57 300 1234567" }),
    );
    expect(wb.getWorksheet("Datos de Negocio")!.getCell("K2").value).toBe(
      "+57 300 1234567",
    );
  });
});

describe("buildOnboardingWorkbook — Métodos de Pago", () => {
  it("copia la tabla pactada con Kushki fila por fila", async () => {
    const wb = await load(await buildOnboardingWorkbook(input));
    const ws = wb.getWorksheet("Métodos de Pago")!;
    expect(Array.from({ length: 5 }, (_, i) => ws.getCell(1, i + 1).value)).toEqual([
      "Payment Method",
      "No. Monthly Trx",
      "Ticket Avg (COP)",
      "Trx Fee (%)",
      "Fixed Fee (COP)",
    ]);
    expect(PAYMENT_METHOD_ROWS).toHaveLength(16);
    PAYMENT_METHOD_ROWS.forEach((row, i) => {
      const r = i + 2;
      expect(ws.getCell(r, 1).value).toBe(row.method);
      expect(ws.getCell(r, 2).value).toBe(row.monthlyTrx);
      expect(ws.getCell(r, 3).value).toBe(row.ticketAvg);
      expect(ws.getCell(r, 4).value).toBe(row.trxFee);
      expect(ws.getCell(r, 5).value ?? null).toBe(row.fixedFee);
    });
    // Nada más debajo de la tabla.
    expect(ws.getCell(18, 1).value ?? null).toBeNull();
  });

  it("usa formatos de porcentaje y moneda y deja vacío el fijo cuando no aplica", async () => {
    const wb = await load(await buildOnboardingWorkbook(input));
    const ws = wb.getWorksheet("Métodos de Pago")!;
    expect(ws.getCell("D2").numFmt).toBe("0.0%");
    expect(ws.getCell("D2").value).toBe(0.024);
    expect(ws.getCell("C2").numFmt).toBe('"$"#,##0');
    expect(ws.getCell("E14").value).toBe(800);
    expect(ws.getCell("E2").value ?? null).toBeNull();
    expect(fillRgb(ws.getCell("A1"))).toMatch(/CFE2F3$/i);
    expect(ws.getCell("A2").font.bold).toBe(true);
    expect(ws.getCell("E2").border.bottom?.style).toBe("thin");
  });
});

describe("splitPersonName", () => {
  it.each([
    ["", "", ""],
    ["MARIA", "MARIA", ""],
    ["MARIA LOPEZ", "MARIA", "LOPEZ"],
    ["MARIA LOPEZ GOMEZ", "MARIA", "LOPEZ GOMEZ"],
    ["MARIA FERNANDA LOPEZ GOMEZ", "MARIA FERNANDA", "LOPEZ GOMEZ"],
    ["JUAN CARLOS DE LA CRUZ", "JUAN CARLOS", "DE LA CRUZ"],
    ["  MARIA   LOPEZ  ", "MARIA", "LOPEZ"],
  ])("%j → %j / %j", (full, firstName, lastName) => {
    expect(splitPersonName(full)).toEqual({ firstName, lastName });
  });
  it("tolera null y undefined", () => {
    expect(splitPersonName(null)).toEqual({ firstName: "", lastName: "" });
    expect(splitPersonName(undefined)).toEqual({ firstName: "", lastName: "" });
  });
});

describe("formatNitWithDv", () => {
  it.each([
    ["901944469-1", "901944469-1"],
    ["901944469", "901944469-1"],
    ["901.944.469", "901944469-1"],
    ["901.944.469 - 1", "901944469-1"],
    ["", ""],
  ])("%j → %j", (raw, expected) => {
    expect(formatNitWithDv(raw)).toBe(expected);
  });
  it("devuelve los dígitos tal cual cuando el DV no se puede calcular", () => {
    expect(formatNitWithDv("1".repeat(16))).toBe("1".repeat(16));
  });
});

// Con ONBOARDING_WORKBOOK_OUT=/ruta/muestra.xlsx el test deja el archivo para
// abrirlo en Excel y compararlo a ojo con el formulario de Kushki.
it("escribe una muestra si ONBOARDING_WORKBOOK_OUT está definido", async () => {
  const out = process.env.ONBOARDING_WORKBOOK_OUT;
  const buffer = await buildOnboardingWorkbook(input);
  expect(buffer.subarray(0, 2).toString("latin1")).toBe("PK");
  if (out) await writeFile(out, buffer);
});
