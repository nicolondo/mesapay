/**
 * PRECUENTA térmica: del dato puro (`lib/prebill.ts`) al documento con los
 * textos resueltos, y de ahí a bytes ESC/POS.
 *
 * Mismo contrato que `invoice.ts`: `renderPrebill` recibe un documento con
 * TODO resuelto —etiquetas ya traducidas, montos ya formateados en la
 * moneda del comercio, fecha ya escrita— y devuelve un Buffer. Sin DB, sin
 * i18n, sin `Intl`. Es lo que permite testearla byte a byte.
 *
 * La diferencia con la factura es de FONDO y el papel tiene que gritarla:
 * una precuenta no numera, no lleva resolución DIAN ni forma de pago, y
 * dice en letras "Este documento no es una factura". Es el ticket que se
 * lleva a la mesa para que el comensal revise el consumo antes de pagar;
 * la factura sale después, al cobrar, por el mismo camino de siempre.
 *
 * `buildPrebillTicket` vive acá y no en `print/` a propósito: la página
 * imprimible del navegador lo consume también, así que el papel y la
 * pantalla no son dos armados distintos del mismo dato sino uno solo.
 */

import { displayOrderCode } from "@/lib/orderCode";
import type { PrebillData } from "@/lib/prebill";
import {
  INIT,
  LF,
  NORMAL_SIZE,
  align,
  bold,
  columnsForWidth,
  cut,
  feed,
  line,
  padRow,
  selectCodePage,
  separator,
  textSize,
  wrap,
} from "./commands";

export type ThermalPrebillItem = {
  qty: number;
  name: string;
  /** Importe de la LÍNEA (qty × unitario), ya formateado. */
  amount: string;
  /** Precio unitario ya formateado. Sólo se imprime cuando qty > 1. */
  unit: string | null;
  /** Modificadores ya formateados ("Término: Medio"). */
  modifiers: string[];
  notes: string | null;
};

export type ThermalPrebillRow = {
  label: string;
  amount: string;
  /** Negrita y doble alto: el TOTAL y lo pendiente. */
  strong?: boolean;
};

export type ThermalPrebill = {
  /** 80 o 58. Decide las columnas (48 vs 32) y por lo tanto los cortes. */
  paperWidthMm: number;
  businessName: string;
  /** NIT, dirección, ciudad, teléfono: lo que el comercio tenga cargado. */
  businessLines: string[];
  /** "PRECUENTA", ya traducido. Va grande. */
  title: string;
  /** "Este documento no es una factura", ya traducido. */
  notInvoiceLine: string;
  /** Fecha, mesa/código, mesero — etiqueta a la izquierda, dato a la derecha. */
  metaRows: Array<{ label: string; value: string }>;
  items: ThermalPrebillItem[];
  /** Subtotal, impuestos, descuento, TOTAL, pagado, pendiente. */
  totals: ThermalPrebillRow[];
  /** "Propina sugerida 10%" y "Total con propina". Vacío si no hay nada pendiente. */
  tipRows: ThermalPrebillRow[];
  /** "La propina es voluntaria…". null si no hay filas de propina. */
  tipNotice: string | null;
  footerLines: string[];
};

/** Versión del sobre que se guarda en PrintJob.payload. */
export const PREBILL_PAYLOAD_VERSION = 1;

export type PrebillPrintJobPayload = {
  v: typeof PREBILL_PAYLOAD_VERSION;
  prebill: ThermalPrebill;
};

/** `kind` del PrintJob de una precuenta. */
export const PREBILL_JOB_KIND = "prebill";

/** Traductor mínimo — `createTranslator` de next-intl encaja tal cual. */
export type PrebillTranslator = (
  key: string,
  values?: Record<string, string | number>,
) => string;

/**
 * Del dato puro al documento con los textos resueltos. Síncrono y con el
 * traductor y el formateador de moneda por parámetro, igual que
 * `buildThermalInvoice`: así se prueba qué filas salen y cuáles no sin
 * catálogos ni DB.
 *
 * Las etiquetas salen del namespace `emailInvoice`, el mismo de la
 * tirilla de la factura: "Subtotal", "Incl. impoconsumo 8%", "Descuento
 * 10%", "TOTAL" se leen IGUAL en la precuenta y en la factura que viene
 * después, que es lo que permite compararlas de un vistazo.
 */
export function buildPrebillTicket(args: {
  data: PrebillData;
  paperWidthMm: number;
  /** Fecha y hora YA formateadas en el idioma y la zona del comercio. */
  dateLabel: string;
  money: (cents: number) => string;
  t: PrebillTranslator;
}): ThermalPrebill {
  const { data: d, money, t } = args;
  // Corto (primer grupo) como en la comanda y la factura: el código
  // completo es el identificador, el humano sólo necesita el primer grupo.
  const code = displayOrderCode(d.shortCode);

  const businessLines = [
    d.taxId ? t("taxId", { id: d.taxId }) : null,
    d.legalAddress,
    d.legalCity,
    d.legalPhone ? t("phone", { phone: d.legalPhone }) : null,
  ].filter((l): l is string => !!l && l.trim().length > 0);

  const destination = (() => {
    const dest = d.destination;
    if (dest.kind === "table") {
      const base = t("prebillTable", { number: dest.number });
      return dest.label ? `${base} · ${dest.label}` : base;
    }
    if (dest.kind === "pickup") {
      return t("prebillPickup", { name: dest.name ?? code });
    }
    // Factura manual: nada de "Mesa -100" en un papel que ve el cliente.
    return dest.label ?? code;
  })();

  const metaRows: ThermalPrebill["metaRows"] = [
    { label: t("date"), value: args.dateLabel },
    { label: destination, value: code },
  ];
  if (d.waiterName) {
    metaRows.push({ label: t("prebillWaiter"), value: d.waiterName });
  }

  const totals: ThermalPrebillRow[] = [
    { label: t("subtotal"), amount: money(d.grossSubtotalCents) },
  ];
  // Impuesto EMBEBIDO en los platos, informativo: base gravable + "Incl.
  // impoconsumo 8%". Ya está dentro del subtotal, no se suma.
  if (d.embeddedTax) {
    totals.push({ label: t("taxBase"), amount: money(d.embeddedTax.baseCents) });
    totals.push({
      label:
        d.embeddedTax.kind === "inc"
          ? t("taxIncIncluded", { pct: d.embeddedTax.pct })
          : t("taxIvaIncluded", { pct: d.embeddedTax.pct }),
      amount: money(d.embeddedTax.taxCents),
    });
  }
  if (d.discountCents > 0) {
    totals.push({
      label: d.discountPct
        ? t("discountRowPct", { pct: d.discountPct })
        : t("discountRow"),
      amount: "-" + money(d.discountCents),
    });
  }
  // Impuesto que las líneas libres SUMAN encima: éste sí entra al total.
  if (d.taxOnTop.inc > 0) {
    totals.push({ label: t("taxInc"), amount: money(d.taxOnTop.inc) });
  }
  if (d.taxOnTop.iva > 0) {
    totals.push({ label: t("taxIva"), amount: money(d.taxOnTop.iva) });
  }
  totals.push({ label: t("total"), amount: money(d.totalCents), strong: true });
  // Con pagos parciales ya aprobados, lo que importa es lo que FALTA.
  if (d.paidCents > 0) {
    totals.push({ label: t("prebillPaid"), amount: "-" + money(d.paidCents) });
    totals.push({
      label: t("prebillOutstanding"),
      amount: money(d.outstandingCents),
      strong: true,
    });
  }

  const tipRows: ThermalPrebillRow[] =
    d.outstandingCents > 0 && d.suggestedTipCents > 0
      ? [
          {
            label: t("prebillSuggestedTip", { pct: d.suggestedTipPct }),
            amount: money(d.suggestedTipCents),
          },
          {
            label: t("prebillTotalWithTip"),
            amount: money(d.totalWithTipCents),
          },
        ]
      : [];

  return {
    paperWidthMm: args.paperWidthMm,
    businessName: d.businessName,
    businessLines,
    title: t("prebillTitle"),
    notInvoiceLine: t("prebillNotInvoice"),
    metaRows,
    items: d.lines.map((l) => ({
      qty: l.qty,
      name: l.name,
      amount: money(l.lineCents),
      unit: l.qty > 1 ? money(l.unitCents) : null,
      modifiers: l.modifiers,
      notes: l.notes,
    })),
    totals,
    tipRows,
    tipNotice: tipRows.length > 0 ? t("prebillTipVoluntary") : null,
    footerLines: [t("thanks")],
  };
}

function stringList(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((s): s is string => typeof s === "string") : [];
}

function rowList(raw: unknown): ThermalPrebillRow[] {
  if (!Array.isArray(raw)) return [];
  const out: ThermalPrebillRow[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const row = r as Record<string, unknown>;
    if (typeof row.label !== "string" || typeof row.amount !== "string") continue;
    out.push({
      label: row.label,
      amount: row.amount,
      ...(row.strong === true ? { strong: true } : {}),
    });
  }
  return out;
}

/**
 * Valida (sin confiar) un payload leído de la DB. Devuelve null si no
 * tiene la forma esperada — igual que `parseInvoicePayload`, una
 * precuenta corrupta se cierra en fallido en vez de trabar la cola.
 */
export function parsePrebillPayload(raw: unknown): ThermalPrebill | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const env = raw as Record<string, unknown>;
  if (env.v !== PREBILL_PAYLOAD_VERSION) return null;
  const p = env.prebill;
  if (!p || typeof p !== "object" || Array.isArray(p)) return null;
  const doc = p as Record<string, unknown>;
  if (typeof doc.paperWidthMm !== "number") return null;
  if (typeof doc.businessName !== "string") return null;
  if (typeof doc.title !== "string") return null;
  if (typeof doc.notInvoiceLine !== "string") return null;
  if (!Array.isArray(doc.items)) return null;

  const items: ThermalPrebillItem[] = [];
  for (const rawItem of doc.items) {
    if (!rawItem || typeof rawItem !== "object") return null;
    const it = rawItem as Record<string, unknown>;
    if (typeof it.qty !== "number") return null;
    if (typeof it.name !== "string" || typeof it.amount !== "string") return null;
    items.push({
      qty: it.qty,
      name: it.name,
      amount: it.amount,
      unit: typeof it.unit === "string" ? it.unit : null,
      modifiers: stringList(it.modifiers),
      notes: typeof it.notes === "string" ? it.notes : null,
    });
  }

  const metaRows: ThermalPrebill["metaRows"] = [];
  if (Array.isArray(doc.metaRows)) {
    for (const r of doc.metaRows) {
      if (!r || typeof r !== "object") continue;
      const row = r as Record<string, unknown>;
      if (typeof row.label !== "string" || typeof row.value !== "string") continue;
      metaRows.push({ label: row.label, value: row.value });
    }
  }

  return {
    paperWidthMm: doc.paperWidthMm,
    businessName: doc.businessName,
    businessLines: stringList(doc.businessLines),
    title: doc.title,
    notInvoiceLine: doc.notInvoiceLine,
    metaRows,
    items,
    totals: rowList(doc.totals),
    tipRows: rowList(doc.tipRows),
    tipNotice: typeof doc.tipNotice === "string" ? doc.tipNotice : null,
    footerLines: stringList(doc.footerLines),
  };
}

/** Sangría de los renglones colgados de un ítem (unitario, modificadores, nota). */
const INDENT = "   ";

/**
 * Bytes ESC/POS completos de la precuenta, listos para escribir tal cual al
 * socket TCP:9100. El agente NO interpreta nada.
 */
export function renderPrebill(doc: ThermalPrebill): Buffer {
  const cols = columnsForWidth(doc.paperWidthMm);
  // A doble ancho entra la mitad de texto por renglón.
  const bigCols = Math.floor(cols / 2);
  const chunks: Buffer[] = [];

  chunks.push(INIT, selectCodePage());

  // ── Identidad del comercio ──────────────────────────────────────────
  // Doble ALTO y no doble ancho, como en la factura: se lee de un vistazo
  // y una razón social larga sigue entrando en las 48/32 columnas.
  chunks.push(align("center"), bold(true), textSize(1, 2));
  for (const l of wrap(doc.businessName, cols)) chunks.push(line(l));
  chunks.push(NORMAL_SIZE, bold(false));
  for (const l of doc.businessLines) {
    for (const w of wrap(l, cols)) chunks.push(line(w));
  }

  // ── "PRECUENTA" + "no es una factura" ───────────────────────────────
  // El título va al tamaño del número de factura, y el aviso pegado
  // debajo: quien reciba este papel no puede confundirlo con la factura.
  chunks.push(separator(cols));
  chunks.push(bold(true), textSize(2, 2));
  for (const l of wrap(doc.title, bigCols)) chunks.push(line(l));
  chunks.push(NORMAL_SIZE, bold(false));
  for (const l of wrap(doc.notInvoiceLine, cols)) chunks.push(line(l));

  // ── Fecha, mesa, código, mesero ─────────────────────────────────────
  chunks.push(align("left"));
  for (const row of doc.metaRows) {
    for (const l of padRow(row.label, row.value, cols)) chunks.push(line(l));
  }

  // ── Ítems ───────────────────────────────────────────────────────────
  chunks.push(separator(cols));
  const hung = { first: INDENT, cont: INDENT + "  " };
  for (const item of doc.items) {
    for (const l of padRow(`${item.qty}x ${item.name}`, item.amount, cols, {
      cont: INDENT,
    })) {
      chunks.push(line(l));
    }
    // Los colgados van a tamaño normal y con sangría: es el detalle que el
    // comensal revisa ("¿me cobraron el término que pedí?"), no lo que
    // tiene que leer de lejos.
    if (item.unit) {
      for (const l of wrap(`${item.qty} x ${item.unit}`, cols, hung)) {
        chunks.push(line(l));
      }
    }
    for (const mod of item.modifiers) {
      for (const l of wrap(`- ${mod}`, cols, hung)) chunks.push(line(l));
    }
    if (item.notes) {
      for (const l of wrap(`"${item.notes}"`, cols, hung)) chunks.push(line(l));
    }
  }

  // ── Totales ─────────────────────────────────────────────────────────
  chunks.push(separator(cols));
  for (const row of doc.totals) {
    if (row.strong) chunks.push(bold(true), textSize(1, 2));
    for (const l of padRow(row.label, row.amount, cols)) chunks.push(line(l));
    if (row.strong) chunks.push(NORMAL_SIZE, bold(false));
  }

  // ── Propina sugerida ────────────────────────────────────────────────
  // Bloque aparte, separado del TOTAL a propósito: la propina NO está
  // sumada arriba y el aviso lo dice en letras.
  if (doc.tipRows.length > 0) {
    chunks.push(separator(cols));
    for (const row of doc.tipRows) {
      for (const l of padRow(row.label, row.amount, cols)) chunks.push(line(l));
    }
    if (doc.tipNotice) {
      for (const l of wrap(doc.tipNotice, cols)) chunks.push(line(l));
    }
  }

  // ── Pie ─────────────────────────────────────────────────────────────
  if (doc.footerLines.length > 0) {
    chunks.push(separator(cols), align("center"));
    for (const l of doc.footerLines) {
      for (const w of wrap(l, cols)) chunks.push(line(w));
    }
  }

  // ── Cierre ──────────────────────────────────────────────────────────
  // Alimentar antes de cortar y corte PARCIAL, igual que la comanda y la
  // factura: deja la pestañita que sostiene el papel hasta que el mesero
  // lo arranca para llevarlo a la mesa.
  chunks.push(align("left"), feed(4), cut(), LF);
  return Buffer.concat(chunks);
}
