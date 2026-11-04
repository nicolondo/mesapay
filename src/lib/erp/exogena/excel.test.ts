// Excel de revisión de la exógena: para cada formato las filas del Excel son
// EXACTAMENTE los registros del XML (orden, valores, cuantías menores,
// omisiones); con incidencias bloqueantes el XML no sale pero el Excel sí,
// con la hoja de incidencias y las filas marcadas; el 2276 es hoja de trabajo.
import ExcelJS from "exceljs";
import { createTranslator, type AbstractIntlMessages } from "next-intl";
import { describe, expect, it } from "vitest";
import es from "../../../../messages/es.json";
import en from "../../../../messages/en.json";
import pt from "../../../../messages/pt.json";
import { computeNitDv } from "../exogena";
import { buildFormatoRecords, buildFormatoXml } from "./download";
import { buildFormatoSheet, buildFormatoXlsx, FIELDS_2276, headerKey, type Tr } from "./excel";
import { FORMATOS_EXOGENA, tieneXml, type FormatoExogena } from "./normativa";
import { billingCustomerTercero, buildExogenaReport, requestTercero, type ExogenaInputs } from "./sources";
import { RECORD_LAYOUTS } from "./xml";

const UVT_2025 = 49799;
const catalogs = { es, en, pt } as const;
type Lang = keyof typeof catalogs;

/** Traductor real del namespace `opExogena`; una clave que falta rompe el test. */
function tr(lang: Lang): Tr {
  const t = createTranslator({
    locale: lang,
    messages: catalogs[lang] as unknown as AbstractIntlMessages,
    namespace: "opExogena",
    onError: (e) => {
      throw e;
    },
  });
  return (key, values) => (t as unknown as Tr)(key, values);
}

const sup = (id: string, name: string, taxId: string | null, address = "") => ({ id, name, taxId, address });
const wrongDv = String((Number(computeNitDv("901234567")) + 1) % 10);

const acme = sup("s1", "Distribuidora & Cía <Andina> S.A.S.", "900123456", 'Cra 1 # 2-3 "local"');
const dvMalo = sup("s2", "Proveedor DV Malo SAS", `901234567-${wrongDv}`);
const pepe = sup("s3", "José Pérez Gómez", "1020304050");
const luz = sup("s4", "Luz Marina Díaz", "52123456");
const arrendador = sup("s5", "Inmobiliaria Norte SAS", "800999888");
const sinNit = sup("s6", "Proveedor Sin NIT", null);

const ana = requestTercero({ customerName: "Ana María Pérez Gómez", docType: "CC", docNumber: "1.020.304.051" });
const nandu = requestTercero({ customerName: "Comercializadora Ñandú SAS", docType: "NIT", docNumber: "900.555.444" });
const cliente = billingCustomerTercero({
  id: "bc1",
  customerName: "Eventos del Valle SAS",
  docType: "NIT",
  docNumber: "900777666",
  verificationDigit: null,
  address: "Calle 5 # 10-20",
  municipalityCode: "76001",
  country: "CO",
});

/** Un año con datos en todos los formatos, avisos que no bloquean y cuantías menores. */
const completo: ExogenaInputs = {
  purchases: [
    { supplier: acme, netCents: 100_000_000, ivaCents: 19_000_000, indedCents: 0, retefuenteCents: 2_500_000, reteIvaCents: 0 },
    { supplier: dvMalo, netCents: 50_000_000, ivaCents: 9_500_000, indedCents: 1_000_000, retefuenteCents: 0, reteIvaCents: 1_425_000 },
    { supplier: pepe, netCents: 5_000_000, ivaCents: 0, indedCents: 0, retefuenteCents: 0, reteIvaCents: 0 },
  ],
  expenses: [
    { supplier: arrendador, category: "Arriendo local", amountCents: 300_000_000 },
    { supplier: luz, category: "Mantenimiento", amountCents: 4_000_000 },
    { supplier: pepe, category: "Otros", amountCents: 3_012_345 },
  ],
  sales: [
    { customer: null, baseCents: 500_000_000, ivaCents: 0, incCents: 40_000_000 },
    { customer: ana, baseCents: 20_000_000, ivaCents: 3_800_000, incCents: 0 },
    { customer: nandu, baseCents: 100_000_000, ivaCents: 0, incCents: 8_000_000 },
  ],
  creditNotes: [{ customer: ana, baseCents: 2_000_000, ivaCents: 380_000, incCents: 0 }],
  receivables: [
    { customer: cliente, saldoCents: 80_000_000 },
    { customer: ana, saldoCents: 5_000_000 },
  ],
  payables: [
    { supplier: acme, totalCents: 119_000_000, paidCents: 19_000_000 },
    { supplier: luz, totalCents: 4_000_000, paidCents: 0 },
  ],
  filings: [
    { form: "ica", declaredCents: 1_234_500 },
    { form: "ica", declaredCents: 1_000_000 },
    { form: "iva", declaredCents: 5_000_000 },
  ],
  payroll: [
    { employeeId: "e1", employeeName: "Carlos Andrés Ruiz López", conceptKey: "salario", kind: "devengado", amountCents: 130_000_000 },
    { employeeId: "e1", employeeName: "Carlos Andrés Ruiz López", conceptKey: "auxilio_transporte", kind: "devengado", amountCents: 16_200_000 },
    { employeeId: "e1", employeeName: "Carlos Andrés Ruiz López", conceptKey: "salud_empleado", kind: "deduccion", amountCents: 5_200_000 },
    { employeeId: "e1", employeeName: "Carlos Andrés Ruiz López", conceptKey: "pension_empleado", kind: "deduccion", amountCents: 5_200_000 },
  ],
  shareholders: [
    { id: "sh1", name: "Nicolás Londoño", docType: "CC", docNumber: "1020304052", dv: null, sharePctBps: 6000, nominalCents: 600_000_000, premiumCents: 0 },
    { id: "sh2", name: "Inversiones Teresita SAS", docType: "NIT", docNumber: "900111222", dv: null, sharePctBps: 4000, nominalCents: 400_000_000, premiumCents: 50_000_000 },
  ],
  holdings: [
    { id: "ho1", concept: "1110", entityName: "Bancolombia S.A.", entityDocType: "NIT", entityDocNumber: "890903938", valueCents: 1_500_000_000 },
  ],
};

/** Lo mismo + un proveedor sin NIT: bloquea el 1001, el 1005 y el 1009. */
const bloqueado: ExogenaInputs = {
  ...completo,
  purchases: [
    ...completo.purchases,
    { supplier: sinNit, netCents: 20_000_000, ivaCents: 3_800_000, indedCents: 0, retefuenteCents: 0, reteIvaCents: 0 },
  ],
  payables: [...completo.payables, { supplier: sinNit, totalCents: 23_800_000, paidCents: 0 }],
};

const unescape = (s: string) =>
  s.replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");

/** Registros del XML: [elemento, [[atributo, valor]…]] en orden. */
function xmlRecords(xml: string): { element: string; attrs: [string, string][] }[] {
  return xml
    .split("\n")
    .map((l) => /^ {2}<(\w+) (.*)\/>$/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({
      element: m[1]!,
      attrs: [...m[2]!.matchAll(/(\w+)="([^"]*)"/g)].map((a) => [a[1]!, unescape(a[2]!)] as [string, string]),
    }));
}

async function readXlsx(body: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(body as unknown as ExcelJS.Buffer);
  return wb;
}

/** Valores de la hoja (sin la fila 1 si es encabezado). */
function sheetValues(ws: ExcelJS.Worksheet, width: number, header = true): (string | number | null)[][] {
  const out: (string | number | null)[][] = [];
  ws.eachRow({ includeEmpty: false }, (row, n) => {
    if (header && n === 1) return;
    out.push(Array.from({ length: width }, (_, j) => row.getCell(j + 1).value as string | number | null));
  });
  return out;
}

const informante = { name: "Casa Teresita S.A.S.", taxId: "901555333-2" };
const NOW = new Date("2026-05-10T15:00:00Z");

async function xlsxOf(inputs: ExogenaInputs, formato: FormatoExogena, lang: Lang = "es") {
  const report = buildExogenaReport(inputs);
  const built = await buildFormatoXlsx({
    report,
    formato,
    year: 2025,
    uvtPesos: UVT_2025,
    informante,
    t: tr(lang),
    locale: lang,
    now: NOW,
  });
  return { report, built, wb: await readXlsx(built.body) };
}

const conXml = FORMATOS_EXOGENA.filter(tieneXml);

describe("Excel = XML, formato por formato", () => {
  it.each(conXml)("%s: mismas filas, mismo orden, mismos valores que los registros del XML", async (formato) => {
    const { report, built, wb } = await xlsxOf(completo, formato);
    const xml = buildFormatoXml(report, formato, 2025, UVT_2025, { fecEnvio: "2026-05-10T10:00:00" });
    if (!xml.ok) throw new Error(`XML ${formato} bloqueado en el fixture`);
    const records = xmlRecords(xml.xml);
    const layout = RECORD_LAYOUTS[formato];
    expect(records.length).toBe(xml.records);
    expect(records.length).toBeGreaterThan(0); // el fixture cubre el formato

    const ws = wb.worksheets[0]!;
    expect(ws.name).toBe(`Formato ${formato}`);
    const header = Array.from({ length: layout.fields.length }, (_, j) => ws.getRow(1).getCell(j + 1).value);
    expect(header).toEqual(layout.fields.map((f) => tr("es")(headerKey(formato, f))));
    expect(ws.getRow(1).getCell(layout.fields.length + 1).value).toBeNull();

    const rows = sheetValues(ws, layout.fields.length);
    expect(rows).toHaveLength(records.length);
    records.forEach((rec, i) => {
      expect(rec.element).toBe(layout.element);
      expect(rec.attrs.map(([k]) => k)).toEqual([...layout.fields]);
      // Celda vacía = atributo vacío; números como número (no texto).
      expect(rows[i]!.map((v) => (v === null ? "" : String(v)))).toEqual(rec.attrs.map(([, v]) => v));
    });
    const recs = buildFormatoRecords(report, formato, UVT_2025).records;
    rows.forEach((r, i) =>
      r.forEach((v, j) => {
        const d = recs[i]!.data[layout.fields[j]!];
        expect(typeof v === "number").toBe(typeof d === "number");
      }),
    );
    expect(built.sheet.xmlRecords).toBe(xml.records);
    expect(built.sheet.valorTotal).toBe(xml.valorTotal);
  });

  it("cuantías menores y montos en pesos: el 1001 agrega los pagos < 3 UVT en 222222222 por concepto", async () => {
    const { wb } = await xlsxOf(completo, "1001");
    const rows = sheetValues(wb.worksheets[0]!, RECORD_LAYOUTS["1001"].fields.length);
    const menores = rows.filter((r) => r[2] === "222222222");
    // pepe (5016) y luz (5004) van agregados; 30.123,45 + 50.000 = 80.123 pesos enteros.
    expect(menores.map((r) => [r[0], r[7], r[12]])).toEqual([
      ["5016", "CUANTÍAS MENORES", 80123],
      ["5004", "CUANTÍAS MENORES", 40000],
    ]);
    expect(rows.find((r) => r[2] === "900123456")![12]).toBe(1_000_000);
  });

  it("los textos conservan &, <, comillas y tildes tal cual (el XML los escapa, el Excel no)", async () => {
    const { wb } = await xlsxOf(completo, "1001");
    const rows = sheetValues(wb.worksheets[0]!, RECORD_LAYOUTS["1001"].fields.length);
    const r = rows.find((x) => x[2] === "900123456")!;
    expect(r[7]).toBe("Distribuidora & Cía <Andina> S.A.S.");
    expect(r[8]).toBe('Cra 1 # 2-3 "local"');
    // Los códigos son texto: conservan los ceros a la izquierda.
    const v = (await xlsxOf(completo, "1008")).wb.worksheets[0]!;
    const cli = sheetValues(v, RECORD_LAYOUTS["1008"].fields.length).find((x) => x[2] === "900777666")!;
    expect([cli[10], cli[11], cli[12]]).toEqual(["76", "001", "169"]);
  });

  it("encabezado congelado, filtro y números con formato numérico", async () => {
    const { wb } = await xlsxOf(completo, "1001");
    const ws = wb.worksheets[0]!;
    expect(ws.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
    expect(ws.getRow(1).font?.bold).toBe(true);
    expect(ws.getRow(2).getCell(13).numFmt).toBe("#,##0");
    expect(ws.getRow(2).getCell(3).numFmt).toBe("@");
    const socios = (await xlsxOf(completo, "1010")).wb.worksheets[0]!;
    // 1010: porcentaje codificado (60 % × 10^5) y su posición decimal, sin miles.
    expect(socios.getRow(2).getCell(15).value).toBe(6_000_000);
    expect(socios.getRow(2).getCell(15).numFmt).toBe("0");
  });

  it("sin incidencias en el formato: sólo la hoja de datos y la de información", async () => {
    const { wb } = await xlsxOf(completo, "1007");
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Formato 1007", "Información"]);
  });
});

describe("incidencias en el Excel", () => {
  it("bloqueado: el XML no sale; el Excel sí, con las filas del XML primero y el tercero sin NIT al final, en rojo", async () => {
    const { report, built, wb } = await xlsxOf(bloqueado, "1001");
    expect(buildFormatoXml(report, "1001", 2025, UVT_2025)).toEqual({ ok: false, error: "issues_pending" });
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Formato 1001", "Incidencias", "Información"]);

    const width = RECORD_LAYOUTS["1001"].fields.length;
    const rows = sheetValues(wb.worksheets[0]!, width);
    const records = buildFormatoRecords(report, "1001", UVT_2025);
    expect(records.omitted).toHaveLength(1);
    // Las primeras filas son exactamente los registros que irían al XML.
    expect(rows.slice(0, records.records.length).map((r) => r.map((v) => v ?? ""))).toEqual(
      records.records.map((r) => RECORD_LAYOUTS["1001"].fields.map((f) => r.data[f])),
    );
    const last = rows.at(-1)!;
    expect([last[0], last[1], last[2], last[5], last[12]]).toEqual(["5016", null, null, "Proveedor", 200_000]);
    const lastRow = wb.worksheets[0]!.getRow(rows.length + 1);
    expect((lastRow.getCell(1).fill as ExcelJS.FillPattern).fgColor?.argb).toBe("FFFDE2E1");
    expect(String(lastRow.getCell(1).note)).toContain("no va al XML");
    expect(built.sheet.blocked).toBe(true);

    const inc = sheetValues(wb.getWorksheet("Incidencias")!, 5);
    expect(inc).toContainEqual(["Bloquea", "Proveedor Sin NIT", "Sin número de documento", 200_000, String(rows.length + 1)]);
    // El aviso del DV marca su fila (en amarillo) pero no bloquea.
    const dv = inc.find((r) => r[1] === "Proveedor DV Malo SAS")!;
    expect(dv.slice(0, 3)).toEqual(["Aviso", "Proveedor DV Malo SAS", tr("es")("issue_invalid_dv")]);
    const dvRow = wb.worksheets[0]!.getRow(Number(dv[4]));
    expect(dvRow.getCell(3).value).toBe("901234567");
    expect((dvRow.getCell(1).fill as ExcelJS.FillPattern).fgColor?.argb).toBe("FFFFF3CD");

    const info = sheetValues(wb.getWorksheet("Información")!, 2, false);
    expect(info).toContainEqual(["Estado", tr("es")("xlsx.statusBlocked")]);
    expect(info).toContainEqual(["Filas sin documento (no van al XML)", 1]);
  });

  it("los demás formatos sin la incidencia se descargan igual en XML (la incidencia es del 1001/1005/1009)", () => {
    const report = buildExogenaReport(bloqueado);
    expect(buildFormatoXml(report, "1007", 2025, UVT_2025).ok).toBe(true);
    for (const f of ["1001", "1005", "1009"] as const) {
      expect(buildFormatoSheet(report, f, 2025, UVT_2025).rows.at(-1)!.status).toBe("omitted");
    }
  });

  it("un aviso de un tercero agregado en cuantías menores marca la fila agregada", () => {
    const report = buildExogenaReport({
      ...completo,
      purchases: [],
      expenses: [{ supplier: sup("s9", "Pequeño DV Malo", `901234567-${wrongDv}`), category: "Otros", amountCents: 1_000_000 }],
    });
    const sheet = buildFormatoSheet(report, "1001", 2025, UVT_2025);
    expect(sheet.rows).toHaveLength(1);
    expect(sheet.rows[0]!.values[2]).toBe("222222222");
    expect(sheet.rows[0]!.status).toBe("warning");
    expect(sheet.issues[0]!.sheetRows).toEqual([2]);
  });

  it("1011: el formulario sin concepto no va al archivo y la incidencia lo dice", async () => {
    const { wb } = await xlsxOf(completo, "1011");
    expect(sheetValues(wb.worksheets[0]!, 2)).toEqual([["8214", 22345]]);
    expect(sheetValues(wb.getWorksheet("Incidencias")!, 5)).toEqual([
      ["Aviso", "iva", tr("es")("issue_missing_concept"), 50_000, "No va en el archivo"],
    ]);
  });
});

describe("2276 y metadatos", () => {
  it("2276: hoja de trabajo por empleado (sin XML), con la incidencia de documento en cada fila", async () => {
    const { report, built, wb } = await xlsxOf(completo, "2276");
    expect(buildFormatoXml(report, "2276", 2025, UVT_2025)).toEqual({ ok: false, error: "no_xml" });
    expect(built.filename).toBe("Dmuisca_010227604202600000001.xlsx");
    const ws = wb.worksheets[0]!;
    expect(ws.name).toBe("Formato 2276");
    expect(sheetValues(ws, FIELDS_2276.length)).toEqual([
      [null, null, "López", "Ruiz", "Carlos", "Andrés", 1_300_000, 162_000, 52_000, 52_000, 0],
    ]);
    expect((ws.getRow(2).getCell(1).fill as ExcelJS.FillPattern).fgColor?.argb).toBe("FFFFF3CD");
    const info = sheetValues(wb.getWorksheet("Información")!, 2, false);
    expect(info).toContainEqual(["Estado", tr("es")("xlsx.statusNoXml")]);
    expect(info.find((r) => r[0] === "Archivo XML oficial")).toBeUndefined();
  });

  it("información: informante, NIT, año gravable y de envío, formato y versión, archivo XML", async () => {
    const { built, wb } = await xlsxOf(completo, "1001");
    expect(built.filename).toBe("Dmuisca_010100111202600000001.xlsx");
    const info = sheetValues(wb.getWorksheet("Información")!, 2, false);
    expect(info.slice(0, 8)).toEqual([
      ["Informante", "Casa Teresita S.A.S."],
      ["NIT del informante", "901555333-2"],
      ["Año gravable", 2025],
      ["Año de envío", 2026],
      ["Formato", `1001 · ${tr("es")("f1001Name")}`],
      ["Versión", 11],
      ["UVT del año", UVT_2025],
      ["Estado", tr("es")("xlsx.statusReady")],
    ]);
    expect(info).toContainEqual(["Archivo XML oficial", "Dmuisca_010100111202600000001.xml"]);
  });

  it.each(["en", "pt"] as const)("%s: todas las hojas salen traducidas (ninguna clave falta)", async (lang) => {
    for (const formato of FORMATOS_EXOGENA) {
      const { wb } = await xlsxOf(bloqueado, formato, lang);
      expect(wb.worksheets[0]!.name).toBe(tr(lang)("xlsx.sheetData", { formato }));
      expect(wb.worksheets.at(-1)!.name).toBe(tr(lang)("xlsx.sheetInfo"));
    }
  });

  it("cada encabezado de cada formato existe en es, en y pt", () => {
    for (const lang of ["es", "en", "pt"] as const) {
      const t = tr(lang);
      for (const formato of FORMATOS_EXOGENA) {
        const fields = tieneXml(formato) ? RECORD_LAYOUTS[formato].fields : FIELDS_2276;
        for (const f of fields) expect(t(headerKey(formato, f)).length).toBeGreaterThan(0);
      }
    }
  });
});
