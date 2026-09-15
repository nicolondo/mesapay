import ExcelJS from "exceljs";
import { computeNitDv } from "@/lib/erp/exogena";

/**
 * Formulario de alta de Salesforce/Kushki en Excel.
 *
 * Kushki da de alta a cada comercio cargando en Salesforce una planilla con
 * dos hojas: "Datos de Negocio" (identidad del comercio, representante legal
 * y contacto principal) y "Métodos de Pago" (volumen esperado y tarifas por
 * medio de pago). Al enviar la solicitud de onboarding generamos esa misma
 * planilla y la dejamos en la carpeta del comercio en el SFTP, junto al
 * manifiesto JSON y los documentos KYC, para que del lado de Kushki no haya
 * que transcribir nada.
 *
 * Los valores de "Métodos de Pago" son los que Kushki pactó con MESAPAY para
 * TODOS los comercios (volumen estimado, ticket promedio y tarifas): por eso
 * son una constante y no se derivan de cada comercio. Si Kushki renegocia
 * tarifas, se cambia acá.
 *
 * Cualquier cambio de formato (nombres de hoja, encabezados, orden de
 * columnas, estilos) debe verificarse contra el formulario que Kushki
 * entrega: Salesforce lo importa por posición y nombre de columna. Las
 * erratas del original (p. ej. "Contato") se conservan a propósito.
 */

export type OnboardingWorkbookInput = {
  legalName: string;
  /** Sólo dígitos o "dígitos-DV". */
  taxId: string;
  city: string | null;
  address: string | null;
  legalRepName: string | null;
  legalRepDocNumber: string | null;
  contactEmail: string;
  contactPhone: string;
};

export type PaymentMethodRow = {
  method: string;
  monthlyTrx: number;
  ticketAvg: number;
  /** Fracción: 0.024 se muestra como 2.4%. */
  trxFee: number;
  /** COP por transacción; null cuando el medio no lleva fijo. */
  fixedFee: number | null;
};

/** Tarifas y volúmenes pactados con Kushki, iguales para todos los comercios. */
export const PAYMENT_METHOD_ROWS: readonly PaymentMethodRow[] = [
  { method: "Visa Credit", monthlyTrx: 50, ticketAvg: 120000, trxFee: 0.024, fixedFee: null },
  { method: "Mastercard Credit", monthlyTrx: 50, ticketAvg: 120000, trxFee: 0.024, fixedFee: null },
  { method: "Visa Debit", monthlyTrx: 30, ticketAvg: 120000, trxFee: 0.023, fixedFee: null },
  { method: "Mastercard Debit", monthlyTrx: 30, ticketAvg: 120000, trxFee: 0.023, fixedFee: null },
  { method: "Visa Prepaid", monthlyTrx: 10, ticketAvg: 120000, trxFee: 0.023, fixedFee: null },
  { method: "Mastercard Prepaid", monthlyTrx: 10, ticketAvg: 120000, trxFee: 0.023, fixedFee: null },
  { method: "American Express Credit", monthlyTrx: 5, ticketAvg: 120000, trxFee: 0.028, fixedFee: null },
  { method: "Diners Club Credit", monthlyTrx: 5, ticketAvg: 120000, trxFee: 0.028, fixedFee: null },
  { method: "Visa International Credit", monthlyTrx: 1, ticketAvg: 120000, trxFee: 0.035, fixedFee: null },
  { method: "MC International Credit", monthlyTrx: 1, ticketAvg: 120000, trxFee: 0.035, fixedFee: null },
  { method: "Visa International Debit", monthlyTrx: 1, ticketAvg: 120000, trxFee: 0.035, fixedFee: null },
  { method: "MC International Debit", monthlyTrx: 1, ticketAvg: 120000, trxFee: 0.035, fixedFee: null },
  { method: "Transfer In (PSE) - Davivienda", monthlyTrx: 50, ticketAvg: 120000, trxFee: 0, fixedFee: 800 },
  { method: "PayOut - Davivienda", monthlyTrx: 10, ticketAvg: 120000, trxFee: 0, fixedFee: 1400 },
  { method: "Transfer Out - Bre-B", monthlyTrx: 10, ticketAvg: 120000, trxFee: 0.004, fixedFee: 700 },
  { method: "Transfer In - Bre-B", monthlyTrx: 50, ticketAvg: 120000, trxFee: 0, fixedFee: 700 },
];

// Encabezados tal cual vienen en el formulario de Kushki (con sus erratas).
const BUSINESS_HEADERS = [
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
] as const;

const PAYMENT_HEADERS = [
  "Payment Method",
  "No. Monthly Trx",
  "Ticket Avg (COP)",
  "Trx Fee (%)",
  "Fixed Fee (COP)",
] as const;

// Anchos de columna del formulario original (unidades de Excel).
const BUSINESS_WIDTHS: Partial<Record<string, number>> = {
  A: 17, B: 17, C: 26.2, F: 30.3, G: 31.7, H: 25.7, I: 26, J: 23.5, K: 25.3, L: 16.5,
};
const PAYMENT_WIDTHS: Record<string, number> = {
  A: 31, B: 16.8, C: 18.2, D: 12.3, E: 17.3,
};

const BLACK = { argb: "FF000000" };
const THIN_BORDER: Partial<ExcelJS.Borders> = {
  top: { style: "thin" },
  left: { style: "thin" },
  bottom: { style: "thin" },
  right: { style: "thin" },
};

function solidFill(rgb: string): ExcelJS.Fill {
  return { type: "pattern", pattern: "solid", fgColor: { argb: `FF${rgb}` } };
}

/**
 * NIT con dígito de verificación ("901944469-1"). Si ya viene con DV se
 * respeta tal cual; si viene sin DV (con o sin puntos) se calcula. Si no se
 * puede calcular, devuelve los dígitos tal cual.
 */
export function formatNitWithDv(taxId: string): string {
  const cleaned = taxId.replace(/[.\s]/g, "");
  const withDv = /^(\d+)-(\d)$/.exec(cleaned);
  if (withDv) return `${withDv[1]}-${withDv[2]}`;
  const digits = cleaned.replace(/\D/g, "");
  const dv = digits ? computeNitDv(digits) : null;
  return dv ? `${digits}-${dv}` : digits;
}

/**
 * Separa un nombre completo en nombres y apellidos por cantidad de tokens:
 * 4+ → dos nombres y el resto apellidos; 3 → un nombre y dos apellidos;
 * 2 → uno y uno; 1 → todo nombre; vacío → ambos vacíos.
 */
export function splitPersonName(fullName: string | null | undefined): {
  firstName: string;
  lastName: string;
} {
  const tokens = (fullName ?? "").trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { firstName: "", lastName: "" };
  if (tokens.length === 1) return { firstName: tokens[0]!, lastName: "" };
  const firstCount = tokens.length >= 4 ? 2 : 1;
  return {
    firstName: tokens.slice(0, firstCount).join(" "),
    lastName: tokens.slice(firstCount).join(" "),
  };
}

/**
 * Excel guarda números con 15 dígitos significativos: una cédula o un
 * teléfono de sólo dígitos van como número (así lo trae el formulario), pero
 * si son demasiado largos para representarse sin pérdida se dejan como texto.
 */
function asNumberIfDigits(raw: string): number | string {
  if (!/^\d+$/.test(raw)) return raw;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : raw;
}

function buildBusinessSheet(
  wb: ExcelJS.Workbook,
  input: OnboardingWorkbookInput,
): void {
  const ws = wb.addWorksheet("Datos de Negocio");
  for (const [col, width] of Object.entries(BUSINESS_WIDTHS)) {
    if (width !== undefined) ws.getColumn(col).width = width;
  }

  BUSINESS_HEADERS.forEach((text, i) => {
    const cell = ws.getCell(1, i + 1);
    cell.value = text;
    const letter = String.fromCharCode(65 + i);
    if (letter <= "G") {
      // A1:G1 — bloque de identidad del comercio.
      cell.font = { name: "Arial", size: 11, bold: true, color: BLACK };
      cell.fill = solidFill("CFE2F3");
      cell.alignment = { vertical: "top" };
      cell.border = THIN_BORDER;
    } else if (letter <= "K") {
      // H1:K1 — contacto principal.
      cell.font = { name: "Arial", size: 10, bold: true };
      cell.fill = solidFill("D9EAD3");
      cell.alignment = { vertical: "middle" };
    } else {
      // L1 — terminales.
      cell.font = { name: "Arial", size: 10, bold: true };
      cell.fill = solidFill("FFFF00");
    }
  });

  const rep = splitPersonName(input.legalRepName);
  const repDoc = (input.legalRepDocNumber ?? "").replace(/[.\s]/g, "");
  const phone = input.contactPhone.trim();

  const values: Array<string | number> = [
    input.legalName,
    "NIT",
    formatNitWithDv(input.taxId),
    input.city ?? "",
    input.address ?? "",
    input.legalRepName ?? "",
    asNumberIfDigits(repDoc),
    // Nombre y apellido del contacto principal salen del representante
    // legal: es exactamente lo que trae el formulario de Kushki.
    rep.firstName,
    rep.lastName,
    input.contactEmail,
    // Con "+" u otros caracteres queda como texto; sólo dígitos va como número.
    asNumberIfDigits(phone),
    // MESAPAY es una única terminal virtual por comercio.
    1,
  ];
  values.forEach((value, i) => {
    const cell = ws.getCell(2, i + 1);
    cell.value = value;
    cell.font = { name: "Calibri", size: 11 };
  });
  if (typeof ws.getCell("G2").value === "number") {
    ws.getCell("G2").numFmt = "#,##0";
  }
}

function buildPaymentMethodsSheet(wb: ExcelJS.Workbook): void {
  const ws = wb.addWorksheet("Métodos de Pago");
  for (const [col, width] of Object.entries(PAYMENT_WIDTHS)) {
    ws.getColumn(col).width = width;
  }

  PAYMENT_HEADERS.forEach((text, i) => {
    const cell = ws.getCell(1, i + 1);
    cell.value = text;
    cell.font = { name: "Arial", size: 11, bold: true, color: BLACK };
    cell.fill = solidFill("CFE2F3");
    cell.alignment = { vertical: "top" };
    cell.border = THIN_BORDER;
  });

  PAYMENT_METHOD_ROWS.forEach((row, i) => {
    const r = i + 2;
    const method = ws.getCell(r, 1);
    method.value = row.method;
    method.font = { name: "Arial", size: 11, bold: true };

    const trx = ws.getCell(r, 2);
    trx.value = row.monthlyTrx;
    trx.font = { name: "Calibri", size: 11 };
    trx.alignment = { horizontal: "center" };

    const ticket = ws.getCell(r, 3);
    ticket.value = row.ticketAvg;
    ticket.font = { name: "Calibri", size: 11 };
    ticket.alignment = { horizontal: "center" };
    ticket.numFmt = '"$"#,##0';

    const fee = ws.getCell(r, 4);
    fee.value = row.trxFee;
    fee.font = { name: "Calibri", size: 11 };
    fee.numFmt = "0.0%";

    const fixed = ws.getCell(r, 5);
    if (row.fixedFee !== null) fixed.value = row.fixedFee;
    fixed.font = { name: "Calibri", size: 11 };

    for (let c = 1; c <= 5; c++) ws.getCell(r, c).border = THIN_BORDER;
  });
}

/** Genera el .xlsx del formulario de alta. Puro: sin DB ni SFTP. */
export async function buildOnboardingWorkbook(
  input: OnboardingWorkbookInput,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "MESAPAY";
  buildBusinessSheet(wb, input);
  buildPaymentMethodsSheet(wb);
  const out = await wb.xlsx.writeBuffer();
  return Buffer.isBuffer(out) ? out : Buffer.from(out as ArrayBuffer);
}
