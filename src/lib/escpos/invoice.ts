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
 * Son DOS documentos con la misma forma:
 *
 *   · El COMPROBANTE (`fiscal: null`): la tirilla de siempre, la que sale
 *     al cobrar en un comercio sin facturación electrónica.
 *   · La FACTURA ELECTRÓNICA (`fiscal` con valor): la misma tirilla con
 *     el rótulo "Factura electrónica de venta", el adquiriente (o
 *     "Consumidor final"), el CUFE completo y el QR de consulta de la
 *     DIAN. Sólo existe cuando la DIAN ya la ACEPTÓ.
 *
 * Sobre el QR: `GS ( k` no lo implementan las térmicas genéricas de la
 * misma forma (y varias no lo implementan), así que un QR mal soportado
 * sería basura impresa en la mitad de las cajas. Por eso sale SÓLO cuando
 * la impresora tiene `supportsQr`, que el dueño prende a mano después de
 * ver el QR de prueba bien impreso; si no, debajo del CUFE va la URL de
 * consulta de la DIAN en texto. El comprobante nunca lleva QR: el link
 * viaja por correo, que es donde el cliente lo usa.
 */

import { encodeCp850 } from "./codepage";
import {
  DEFAULT_LINE_SPACING,
  LF,
  align,
  bold,
  chunk,
  columnsForWidth,
  cut,
  feed,
  line,
  padRow,
  pairRows,
  qr,
  selectFont,
  separator,
  smallColumnsForWidth,
  wrap,
} from "./commands";
import {
  DETAIL_SEPARATOR,
  compactStart,
  itemChunks,
  itemDetail,
  totalRowChunks,
} from "./compact";

export type ThermalInvoiceItem = {
  qty: number;
  /** Nombre del plato — snapshot de OrderItem.nameSnapshot. */
  name: string;
  /** Importe de la LÍNEA (qty × unitario), ya formateado con su moneda. */
  amount: string;
  /**
   * Modificadores legibles ("Término: Medio") y nota del ítem. Se
   * imprimen JUNTOS en un renglón de fuente B debajo del plato
   * ("Término: Medio · \"sin cebolla\""), como en la precuenta. Con los
   * repetidos agrupados (`groupInvoiceLines`) son lo que distingue dos
   * líneas del mismo plato. Opcionales: los payloads viejos no los traen
   * y se imprimen igual.
   */
  modifiers?: string[];
  notes?: string | null;
};

/** Fila de dos columnas del bloque de totales o de formas de pago. */
export type ThermalInvoiceRow = {
  label: string;
  amount: string;
  /**
   * El TOTAL: negrita a doble ALTO con el ancho normal, así nunca se
   * desborda. Ver `totalRowChunks` y `TOTAL_SIZE` en `compact.ts`.
   */
  strong?: boolean;
};

/**
 * Bloque FISCAL de la factura electrónica: sólo cuando la DIAN ya la
 * aceptó. Va después de la forma de pago y antes del pie legal.
 */
export type ThermalInvoiceFiscal = {
  /** "CUFE", ya traducido. */
  cufeLabel: string;
  /** El CUFE completo (96 hex). Se parte en renglones al renderizar. */
  cufe: string;
  /** URL de consulta en el catálogo de la DIAN — es también el dato del QR. */
  verifyUrl: string;
  /**
   * true ⇒ QR nativo (`GS ( k`), porque la impresora lo soporta.
   * false ⇒ la URL en texto debajo del CUFE.
   */
  qr: boolean;
  /** Rótulo de la URL en texto ("Consulta esta factura en la DIAN:"). */
  verifyLabel: string;
  /** "Representación impresa de la factura electrónica de venta" y afines. */
  noticeLines: string[];
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
  /**
   * Factura electrónica aceptada: CUFE + QR/URL. Opcional (y null) en el
   * comprobante, y ausente en los payloads guardados antes de que
   * existiera — esos se siguen imprimiendo tal cual.
   */
  fiscal?: ThermalInvoiceFiscal | null;
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
    const modifiers = stringList(it.modifiers);
    const notes = typeof it.notes === "string" && it.notes.trim() ? it.notes : null;
    items.push({
      qty: it.qty,
      name: it.name,
      amount: it.amount,
      ...(modifiers.length > 0 && { modifiers }),
      ...(notes && { notes }),
    });
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

  // El bloque fiscal es todo o nada: una factura electrónica "a medias"
  // (sin CUFE, sin URL) es peor que no imprimir, así que un bloque
  // presente pero malformado invalida el payload entero.
  let fiscal: ThermalInvoiceFiscal | null = null;
  if (inv.fiscal != null) {
    const f = inv.fiscal;
    if (!f || typeof f !== "object" || Array.isArray(f)) return null;
    const fr = f as Record<string, unknown>;
    if (typeof fr.cufeLabel !== "string") return null;
    if (typeof fr.cufe !== "string" || fr.cufe.length === 0) return null;
    if (typeof fr.verifyUrl !== "string" || fr.verifyUrl.length === 0) return null;
    if (typeof fr.verifyLabel !== "string") return null;
    fiscal = {
      cufeLabel: fr.cufeLabel,
      cufe: fr.cufe,
      verifyUrl: fr.verifyUrl,
      qr: fr.qr === true,
      verifyLabel: fr.verifyLabel,
      noticeLines: stringList(fr.noticeLines),
    };
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
    fiscal,
  };
}

/** Lado del módulo del QR de la DIAN, en puntos. Ver `qr()` en commands. */
// Se revisó al compactar y se deja en 4: con la URL de consulta (QR
// versión 7, 45 módulos) son ~22 mm de lado. A 3 puntos el módulo mide
// 0,37 mm y en una térmica gastada los puntos se corren y el celular ya
// no lo lee. 22 mm es el mínimo que se lee siempre, y el QR es lo único
// de la factura electrónica que no se puede "achicar" sin perderlo.
const QR_MODULE_SIZE = 4;

/**
 * Bytes ESC/POS completos de la tirilla, listos para escribir tal cual al
 * socket TCP:9100. El agente NO interpreta nada.
 *
 * Formato COMPACTO (ver `compact.ts`): interlineado de 24 puntos (y el de
 * la letra en los renglones agrandados), un margen superior para que el
 * nombre no quede pegado al corte, datos del comercio en un párrafo,
 * número y fecha en la misma fila, detalle de cada plato en un renglón de
 * fuente B, y los textos legales en fuente B.
 * El contenido es el mismo de siempre —rótulo, número, fecha, NIT, ítems,
 * impuesto discriminado, CUFE, QR o URL, resolución, leyendas—: lo que se
 * ahorra es papel en blanco.
 */
export function renderInvoice(invoice: ThermalInvoice): Buffer {
  const cols = columnsForWidth(invoice.paperWidthMm);
  const smallCols = smallColumnsForWidth(invoice.paperWidthMm);
  const chunks: Buffer[] = [];

  chunks.push(...compactStart());

  // ── Identidad del comercio ──────────────────────────────────────────
  // El nombre en negrita, y NIT · dirección · ciudad · teléfono corridos
  // en un párrafo: en 80mm son dos renglones en vez de cuatro.
  chunks.push(align("center"), bold(true));
  for (const l of wrap(invoice.businessName, cols)) chunks.push(line(l));
  chunks.push(bold(false));
  if (invoice.businessLines.length > 0) {
    for (const l of wrap(invoice.businessLines.join(DETAIL_SEPARATOR), cols)) {
      chunks.push(line(l));
    }
  }

  // ── Rótulo, número y datos de la factura ────────────────────────────
  // El rótulo ("FACTURA ELECTRÓNICA DE VENTA") solo y en negrita: es una
  // leyenda obligatoria. Debajo, de a dos por renglón: número (en
  // negrita) y fecha; mesa y cliente; documento y dirección del cliente.
  chunks.push(separator(cols));
  chunks.push(bold(true));
  for (const l of wrap(invoice.documentLabel, cols)) chunks.push(line(l));
  chunks.push(bold(false), align("left"));
  const cells = [
    invoice.documentNumber,
    ...invoice.metaRows.map((r) => `${r.label} ${r.value}`.trim()),
    ...invoice.customerLines,
  ];
  pairRows(cells, cols).forEach((l, i) => {
    // El número es lo que se busca cuando alguien vuelve con la tirilla:
    // va en negrita (sólo él, no la fecha que comparte el renglón).
    if (i === 0 && l.startsWith(invoice.documentNumber)) {
      chunks.push(
        bold(true),
        encodeCp850(invoice.documentNumber),
        bold(false),
        line(l.slice(invoice.documentNumber.length)),
      );
    } else {
      chunks.push(line(l));
    }
  });

  // ── Ítems ───────────────────────────────────────────────────────────
  // Ya vienen AGRUPADOS ("2x Bretaña", ver `groupInvoiceLines`). Precio
  // en el primer renglón; modificadores y nota juntos, en fuente B.
  chunks.push(separator(cols));
  for (const item of invoice.items) {
    chunks.push(
      ...itemChunks(
        {
          qty: item.qty,
          name: item.name,
          amount: item.amount,
          detail: itemDetail(item.modifiers, item.notes),
        },
        cols,
        smallCols,
      ),
    );
  }

  // ── Totales y forma de pago ─────────────────────────────────────────
  // Sin separador entre los dos bloques: la forma de pago cierra la
  // cuenta. Con un solo pago, el rótulo va en el mismo renglón si entra
  // ("Forma de pago: Efectivo ..... $ 40.000").
  chunks.push(separator(cols));
  for (const row of invoice.totals) chunks.push(...totalRowChunks(row, cols));
  const single = invoice.paymentRows.length === 1 ? invoice.paymentRows[0] : null;
  const singleRow =
    single && invoice.paymentTitle
      ? padRow(`${invoice.paymentTitle}: ${single.label}`, single.amount, cols)
      : null;
  if (singleRow && singleRow.length === 1) {
    chunks.push(line(singleRow[0]));
  } else if (invoice.paymentRows.length > 0) {
    if (invoice.paymentTitle) {
      chunks.push(bold(true));
      for (const l of wrap(invoice.paymentTitle, cols)) chunks.push(line(l));
      chunks.push(bold(false));
    }
    for (const row of invoice.paymentRows) {
      for (const l of padRow(row.label, row.amount, cols)) chunks.push(line(l));
    }
  }

  // ── Bloque fiscal (factura electrónica ACEPTADA por la DIAN) ────────
  // El QR SÓLO si la impresora lo declaró (`supportsQr`); si no, la
  // misma URL en texto. Todo en fuente B: el CUFE son 96 hexadecimales
  // sin un espacio, y va pegado a su rótulo ("CUFE: 0123…") partido a lo
  // bruto por columna, que es la única forma de partirlo sin perder nada.
  if (invoice.fiscal) {
    const f = invoice.fiscal;
    chunks.push(separator(cols), align("center"));
    if (f.qr) {
      chunks.push(qr(f.verifyUrl, { size: QR_MODULE_SIZE, correction: "M" }), LF);
    }
    chunks.push(selectFont("B"));
    for (const l of chunk(`${f.cufeLabel}: ${f.cufe}`, smallCols)) {
      chunks.push(line(l));
    }
    if (!f.qr) {
      for (const l of wrap(f.verifyLabel, smallCols)) chunks.push(line(l));
      for (const l of wrap(f.verifyUrl, smallCols)) chunks.push(line(l));
    }
    for (const l of f.noticeLines) {
      for (const w of wrap(l, smallCols)) chunks.push(line(w));
    }
    chunks.push(selectFont("A"));
  }

  // ── Pie legal ───────────────────────────────────────────────────────
  // Vuelve el interlineado de fábrica (`ESC 2`) antes del pie: la
  // resolución y la advertencia de propina se leen con aire, y el avance
  // antes del corte (`ESC d`, que se mide en renglones) vuelve a ser el
  // de siempre — con 24 puntos el cortador se comería el pie.
  chunks.push(DEFAULT_LINE_SPACING);
  if (invoice.footerLines.length > 0) {
    chunks.push(separator(cols), align("center"), selectFont("B"));
    for (const l of invoice.footerLines) {
      for (const w of wrap(l, smallCols)) chunks.push(line(w));
    }
    chunks.push(selectFont("A"));
  }

  // ── Cierre ──────────────────────────────────────────────────────────
  // Alimentar antes de cortar: el cortador está unos milímetros por
  // encima del cabezal, sin este feed el corte se come el pie. El corte
  // es PARCIAL (el mismo `cut()` de la comanda): deja la pestañita que
  // sostiene la tirilla hasta que el cajero la arranca para entregarla.
  chunks.push(align("left"), feed(4), cut(), LF);
  return Buffer.concat(chunks);
}
