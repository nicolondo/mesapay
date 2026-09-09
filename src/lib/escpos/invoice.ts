/**
 * Render de la TIRILLA DEL CLIENTE (la factura) a bytes ESC/POS.
 *
 * Hermana de `ticket.ts` y con el mismo contrato: entra un documento con
 * TODO resuelto —textos ya traducidos, montos ya formateados en la moneda
 * del comercio, fechas ya escritas— y sale un Buffer. Sin DB, sin i18n,
 * sin `Intl` acá adentro: es lo que permite testearla byte a byte, que es
 * lo único que tenemos una vez que la impresora está en una caja a 500 km.
 *
 * El CONTENIDO no se inventa: es el mismo que ya salía por los dos
 * caminos que existían para el mismo papel —la factura HTML de
 * `/factura/[id]` que se manda a imprimir desde el navegador y la tirilla
 * del datáfono (`kushki/cloudPrint.buildInvoiceCommands`)—: identidad del
 * comercio, NIT, número de factura, fecha, ítems, descuentos, impuestos,
 * total, forma de pago, datos del cliente si la factura es nominativa y
 * el pie con la resolución DIAN.
 *
 * Lo que NO trae y sí traen esas dos: el QR. `GS ( k` no lo implementan
 * las térmicas genéricas de la misma forma (y varias no lo implementan),
 * así que un QR mal soportado sería basura impresa en la mitad de las
 * cajas. El link de la factura viaja por correo, que es donde el cliente
 * lo usa.
 */

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

export type ThermalInvoiceItem = {
  qty: number;
  /** Nombre del plato — snapshot de OrderItem.nameSnapshot. */
  name: string;
  /** Importe de la LÍNEA (qty × unitario), ya formateado con su moneda. */
  amount: string;
};

/** Fila de dos columnas del bloque de totales o de formas de pago. */
export type ThermalInvoiceRow = {
  label: string;
  amount: string;
  /** El TOTAL: negrita y doble alto. No cambia el ancho de columna. */
  strong?: boolean;
};

/**
 * El documento de la factura, con todo resuelto en el idioma que
 * corresponde. Es lo que se persiste en `PrintJob.payload`.
 */
export type ThermalInvoice = {
  /** 80 o 58. Decide las columnas (48 vs 32) y por lo tanto los cortes. */
  paperWidthMm: number;
  /** Razón social o nombre comercial — el renglón grande de arriba. */
  businessName: string;
  /** NIT, dirección, ciudad, teléfono: lo que el comercio tenga cargado. */
  businessLines: string[];
  /** Rótulo del documento ("COMPROBANTE"), ya traducido. */
  documentLabel: string;
  /** Número con prefijo y padding DIAN ya aplicados ("FE-0012"). */
  documentNumber: string;
  /** Fecha, mesa, código corto — etiqueta a la izquierda, dato a la derecha. */
  metaRows: Array<{ label: string; value: string }>;
  /** Datos del cliente cuando la factura es nominativa. Vacío = consumidor final. */
  customerLines: string[];
  items: ThermalInvoiceItem[];
  /** Subtotal, impuestos, descuento, propina y TOTAL — en ese orden. */
  totals: ThermalInvoiceRow[];
  /** Encabezado del bloque de pago ("Forma de pago"). null = no se imprime. */
  paymentTitle: string | null;
  /** Un renglón por pago cobrado ("Efectivo · $ 40.000"). */
  paymentRows: ThermalInvoiceRow[];
  /** Resolución DIAN, numeración autorizada, agradecimiento. */
  footerLines: string[];
};

/** Versión del sobre que se guarda en PrintJob.payload. */
export const INVOICE_PAYLOAD_VERSION = 1;

export type InvoicePrintJobPayload = {
  v: typeof INVOICE_PAYLOAD_VERSION;
  invoice: ThermalInvoice;
};

/** `kind` del PrintJob de una factura. */
export const CUSTOMER_INVOICE_JOB_KIND = "customer_invoice";

function stringList(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((s): s is string => typeof s === "string") : [];
}

/**
 * Valida (sin confiar) un payload leído de la DB. Devuelve null si no
 * tiene la forma esperada — igual que `parseTicketPayload`, una factura
 * corrupta se cierra en fallido en vez de trabar la cola de la cocina.
 */
export function parseInvoicePayload(raw: unknown): ThermalInvoice | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const env = raw as Record<string, unknown>;
  if (env.v !== INVOICE_PAYLOAD_VERSION) return null;
  const i = env.invoice;
  if (!i || typeof i !== "object" || Array.isArray(i)) return null;
  const inv = i as Record<string, unknown>;
  if (typeof inv.paperWidthMm !== "number") return null;
  if (typeof inv.businessName !== "string") return null;
  if (typeof inv.documentLabel !== "string") return null;
  if (typeof inv.documentNumber !== "string") return null;
  if (!Array.isArray(inv.items)) return null;

  const items: ThermalInvoiceItem[] = [];
  for (const rawItem of inv.items) {
    if (!rawItem || typeof rawItem !== "object") return null;
    const it = rawItem as Record<string, unknown>;
    if (typeof it.qty !== "number") return null;
    if (typeof it.name !== "string" || typeof it.amount !== "string") return null;
    items.push({ qty: it.qty, name: it.name, amount: it.amount });
  }

  const rows = (raw2: unknown): ThermalInvoiceRow[] => {
    if (!Array.isArray(raw2)) return [];
    const out: ThermalInvoiceRow[] = [];
    for (const r of raw2) {
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
  };

  const metaRows: Array<{ label: string; value: string }> = [];
  if (Array.isArray(inv.metaRows)) {
    for (const r of inv.metaRows) {
      if (!r || typeof r !== "object") continue;
      const row = r as Record<string, unknown>;
      if (typeof row.label !== "string" || typeof row.value !== "string") continue;
      metaRows.push({ label: row.label, value: row.value });
    }
  }

  return {
    paperWidthMm: inv.paperWidthMm,
    businessName: inv.businessName,
    businessLines: stringList(inv.businessLines),
    documentLabel: inv.documentLabel,
    documentNumber: inv.documentNumber,
    metaRows,
    customerLines: stringList(inv.customerLines),
    items,
    totals: rows(inv.totals),
    paymentTitle:
      typeof inv.paymentTitle === "string" ? inv.paymentTitle : null,
    paymentRows: rows(inv.paymentRows),
    footerLines: stringList(inv.footerLines),
  };
}

/** Sangría de los renglones colgados de un ítem largo. */
const INDENT = "   ";

/**
 * Bytes ESC/POS completos de la tirilla, listos para escribir tal cual al
 * socket TCP:9100. El agente NO interpreta nada.
 */
export function renderInvoice(invoice: ThermalInvoice): Buffer {
  const cols = columnsForWidth(invoice.paperWidthMm);
  // A doble ancho entra la mitad de texto por renglón.
  const bigCols = Math.floor(cols / 2);
  const chunks: Buffer[] = [];

  chunks.push(INIT, selectCodePage());

  // ── Identidad del comercio ──────────────────────────────────────────
  // Doble ALTO y no doble ancho: el nombre se lee de un vistazo pero
  // siguen entrando 48/32 columnas, así que una razón social larga
  // ("Inversiones Gastronómicas del Caribe S.A.S.") no se parte en cinco.
  chunks.push(align("center"), bold(true), textSize(1, 2));
  for (const l of wrap(invoice.businessName, cols)) chunks.push(line(l));
  chunks.push(NORMAL_SIZE, bold(false));
  for (const l of invoice.businessLines) {
    for (const w of wrap(l, cols)) chunks.push(line(w));
  }

  // ── Número de factura ───────────────────────────────────────────────
  // Es lo que se busca cuando alguien vuelve con la tirilla en la mano,
  // así que va grande y solo. A doble ancho las columnas se parten a la
  // mitad — de ahí `bigCols`.
  chunks.push(separator(cols));
  for (const l of wrap(invoice.documentLabel, cols)) chunks.push(line(l));
  chunks.push(bold(true), textSize(2, 2));
  for (const l of wrap(invoice.documentNumber, bigCols)) chunks.push(line(l));
  chunks.push(NORMAL_SIZE, bold(false));

  // ── Fecha, mesa, código ─────────────────────────────────────────────
  chunks.push(align("left"));
  for (const row of invoice.metaRows) {
    for (const l of padRow(row.label, row.value, cols)) chunks.push(line(l));
  }

  // ── Cliente (sólo factura nominativa) ───────────────────────────────
  if (invoice.customerLines.length > 0) {
    chunks.push(separator(cols));
    for (const l of invoice.customerLines) {
      for (const w of wrap(l, cols)) chunks.push(line(w));
    }
  }

  // ── Ítems ───────────────────────────────────────────────────────────
  chunks.push(separator(cols));
  for (const item of invoice.items) {
    for (const l of padRow(`${item.qty}x ${item.name}`, item.amount, cols, {
      cont: INDENT,
    })) {
      chunks.push(line(l));
    }
  }

  // ── Totales ─────────────────────────────────────────────────────────
  chunks.push(separator(cols));
  for (const row of invoice.totals) {
    if (row.strong) chunks.push(bold(true), textSize(1, 2));
    for (const l of padRow(row.label, row.amount, cols)) chunks.push(line(l));
    if (row.strong) chunks.push(NORMAL_SIZE, bold(false));
  }

  // ── Forma de pago ───────────────────────────────────────────────────
  if (invoice.paymentRows.length > 0) {
    chunks.push(separator(cols));
    if (invoice.paymentTitle) {
      chunks.push(bold(true));
      for (const l of wrap(invoice.paymentTitle, cols)) chunks.push(line(l));
      chunks.push(bold(false));
    }
    for (const row of invoice.paymentRows) {
      for (const l of padRow(row.label, row.amount, cols)) chunks.push(line(l));
    }
  }

  // ── Pie legal ───────────────────────────────────────────────────────
  if (invoice.footerLines.length > 0) {
    chunks.push(separator(cols), align("center"));
    for (const l of invoice.footerLines) {
      for (const w of wrap(l, cols)) chunks.push(line(w));
    }
  }

  // ── Cierre ──────────────────────────────────────────────────────────
  // Alimentar antes de cortar: el cortador está unos milímetros por
  // encima del cabezal, sin este feed el corte se come el pie. El corte
  // es PARCIAL (el mismo `cut()` de la comanda): deja la pestañita que
  // sostiene la tirilla hasta que el cajero la arranca para entregarla.
  chunks.push(align("left"), feed(4), cut(), LF);
  return Buffer.concat(chunks);
}
