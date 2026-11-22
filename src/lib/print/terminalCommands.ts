/**
 * De los documentos térmicos de siempre (los mismos que imprime la caja por
 * ESC/POS) a los comandos del Print API cloud de Kushki, para imprimir en
 * la impresora integrada del datáfono (Sunmi P3, Smart POS de Kushki).
 *
 * El contenido es el MISMO que el de la impresora de caja: cada función
 * recibe el documento ya armado y traducido (`ThermalInvoice`,
 * `ThermalPrebill`, `ThermalReport`) y sólo lo vuelve comandos — textos,
 * columnas etiqueta/monto, divisores, QR y el corte.
 *
 * El DISEÑO es el mismo del otro armador del datáfono
 * (`kushki/cloudPrint.buildInvoiceCommands`) y usa sus mismos helpers:
 * TODO texto va pre-envuelto POR PALABRA al ancho efectivo de su tamaño
 * (`fit`/`wrap`), porque el terminal envuelve solo pero parte en el ancho
 * exacto — la factura FESM de la foto del dueño salió con «FACTURA
 * ELECTRÓNICA DE V/ENTA», «SUGE/RIDA» y el CUFE en bloque justamente por
 * mandar los textos crudos desde acá. Un nombre largo baja a renglones
 * completos en vez de entreverarse con el precio en `columns`; los
 * modificadores van juntos si entran en un renglón y si no de a uno; el
 * CUFE va con su rótulo en su renglón y en grupos de 8; y la sección
 * «Pagos» del documento se imprime con `paymentsSectionCommands` — la
 * misma de la caja, la web y el correo.
 *
 * Puro (sin DB ni red): se prueba sin Kushki.
 */

import {
  TERMINAL_COLS,
  TERMINAL_INDENT,
  amountRow,
  fit,
  paymentsSectionCommands,
  spacedDividers,
  terminalCols,
  type PrintCommand,
} from "@/lib/payments/kushki/cloudPrint";
import { chunk, wrap } from "@/lib/escpos/commands";
import { DETAIL_SEPARATOR, itemDetailParts } from "@/lib/escpos/compact";
import type { ThermalInvoice, ThermalInvoiceRow } from "@/lib/escpos/invoice";
import type { ThermalPrebill } from "@/lib/escpos/prebill";
import type { ThermalReport } from "@/lib/escpos/report";

/**
 * Tamaños de letra del Print API, los del contrato: 24 (normal), 32
 * (subtítulo), 48 (título). Lo "chico" va a 24, el mínimo documentado.
 */
const SIZE = { body: 24, small: 24, title: 32, business: 32, amount: 32, strongLabel: 28 } as const;

const center = (text: string, size: number = SIZE.body, bold = false): PrintCommand => ({
  type: "text",
  text: fit(text, size) + "\n",
  align: "CENTER",
  size,
  bold,
});
const left = (text: string, size: number = SIZE.body, bold = false): PrintCommand => ({
  type: "text",
  text: fit(text, size) + "\n",
  align: "LEFT",
  size,
  bold,
});
/**
 * Una fila fuerte (el TOTAL A PAGAR, lo pendiente): rótulo en negrita a
 * 28 y el monto solo, a la derecha y más grande — a ese tamaño nunca se
 * encima con nada (el mismo patrón de `buildInvoiceCommands`).
 */
const strongRow = (label: string, value: string): PrintCommand[] => [
  { type: "divider", dividerType: "SOLID", offset: 4 },
  { type: "text", text: fit(label, SIZE.strongLabel) + "\n", align: "LEFT", size: SIZE.strongLabel, bold: true },
  { type: "text", text: value + "\n", align: "RIGHT", size: SIZE.amount, bold: true },
];
const dotted: PrintCommand = { type: "divider", dividerType: "DOTTED", offset: 8 };
const solid: PrintCommand = { type: "divider", dividerType: "SOLID", offset: 8 };
const end: PrintCommand[] = [{ type: "feed", lines: 3 }, { type: "cut" }];

function header(businessName: string, businessLines: string[]): PrintCommand[] {
  const c: PrintCommand[] = [center(businessName, SIZE.business, true)];
  if (businessLines.length > 0) c.push(center(businessLines.join(" · "), SIZE.small));
  c.push(solid);
  return c;
}

function rows(list: ThermalInvoiceRow[]): PrintCommand[] {
  return list.flatMap((r) => (r.strong ? strongRow(r.label, r.amount) : amountRow(r.label, r.amount)));
}

/**
 * Un ítem: "1x Nombre ..... $ precio" con el nombre envuelto por palabra
 * (lo que no entra al lado del precio sigue abajo en renglones completos)
 * y el detalle con la MISMA regla de la caja (`itemChunks`): junto con
 * " · " si entra en un renglón, y si no, una pieza por renglón, sangrada.
 */
function itemLines(
  items: Array<{ qty: number; name: string; amount: string; detail: string[] }>,
): PrintCommand[] {
  return items.flatMap((it) => {
    const out: PrintCommand[] = amountRow(`${it.qty}x ${it.name}`, it.amount);
    if (it.detail.length > 0) {
      const joined = it.detail.join(DETAIL_SEPARATOR);
      const lines =
        TERMINAL_INDENT.length + joined.length <= TERMINAL_COLS
          ? [TERMINAL_INDENT + joined]
          : it.detail.flatMap((part) =>
              wrap(part, TERMINAL_COLS, { first: TERMINAL_INDENT, cont: TERMINAL_INDENT }),
            );
      for (const l of lines) out.push({ type: "text", text: l + "\n", size: SIZE.small });
    }
    return out;
  });
}

/** La factura (o el comprobante), con CUFE y QR si es electrónica aceptada. */
export function invoiceToTerminalCommands(doc: ThermalInvoice): PrintCommand[] {
  const c = header(doc.businessName, doc.businessLines);
  c.push(center(doc.documentLabel, SIZE.title, true), center(doc.documentNumber, SIZE.body, true));
  // Fecha, mesa, código: cada dato ENTERO en su renglón (en `columns` la
  // fecha quedaba apretada contra el rótulo y salía con la «m.» cortada).
  for (const m of doc.metaRows) c.push(left(`${m.label} ${m.value}`.trim(), SIZE.small));
  for (const l of doc.customerLines) c.push(left(l, SIZE.small));
  c.push(dotted);
  c.push(
    ...itemLines(
      doc.items.map((it) => ({
        qty: it.qty,
        name: it.name,
        amount: it.amount,
        detail: itemDetailParts(it.modifiers, it.notes),
      })),
    ),
  );
  if (doc.itemsNote) c.push(left(doc.itemsNote, SIZE.small));
  c.push(solid, ...rows(doc.totals));
  // La sección «Pagos» (documento nuevo) reemplaza al bloque "Forma de
  // pago"; un documento viejo sin sección imprime su bloque de siempre —
  // la compatibilidad es en el CONTENIDO, nunca en el diseño.
  if (doc.paymentsSection) {
    c.push(...paymentsSectionCommands(doc.paymentsSection));
  } else if (doc.paymentTitle && doc.paymentRows.length > 0) {
    c.push(dotted, left(doc.paymentTitle, SIZE.small, true), ...rows(doc.paymentRows));
  }
  if (doc.pendingRow) c.push(...strongRow(doc.pendingRow.label, doc.pendingRow.amount));
  if (doc.tipRows && doc.tipRows.length > 0) {
    c.push(dotted, ...rows(doc.tipRows));
    if (doc.tipNotice) c.push(left(doc.tipNotice, SIZE.small));
  }
  if (doc.fiscal) {
    c.push(
      dotted,
      { type: "qr", content: doc.fiscal.verifyUrl, dotSize: 5, errorLevel: "M", align: "CENTER" },
    );
    // El CUFE con su rótulo en su renglón y en grupos de 8 que no se
    // parten — el bloque denso de 96 hex era ilegible (foto FESM8525).
    c.push(left(`${doc.fiscal.cufeLabel}:`, SIZE.small));
    for (const l of wrap(chunk(doc.fiscal.cufe, 8).join(" "), terminalCols(SIZE.small))) {
      c.push({ type: "text", text: l + "\n", align: "LEFT", size: SIZE.small });
    }
    c.push(...doc.fiscal.noticeLines.map((l) => center(l, SIZE.small)));
  }
  if (doc.footerLines.length > 0) {
    c.push(dotted, ...doc.footerLines.map((l) => center(l, SIZE.small)));
  }
  // Aire antes de cada separador que sigue a texto (ver `spacedDividers`).
  return spacedDividers([...c, ...end]);
}

/** La precuenta: "PRECUENTA", "no es una factura", consumo y propina sugerida. */
export function prebillToTerminalCommands(doc: ThermalPrebill): PrintCommand[] {
  const c = header(doc.businessName, doc.businessLines);
  c.push(center(doc.title, SIZE.title, true), center(doc.notInvoiceLine, SIZE.small));
  c.push(dotted);
  for (const m of doc.metaRows) c.push(left(`${m.label} ${m.value}`.trim(), SIZE.small));
  c.push(dotted);
  c.push(
    ...itemLines(
      doc.items.map((it) => ({
        qty: it.qty,
        name: it.name,
        amount: it.amount,
        detail: itemDetailParts(
          it.modifiers,
          it.notes,
          it.unit ? [`${it.qty} x ${it.unit}`] : [],
        ),
      })),
    ),
  );
  c.push(solid, ...rows(doc.totals));
  if (doc.tipRows.length > 0) {
    c.push(dotted, ...rows(doc.tipRows));
    if (doc.tipNotice) c.push(left(doc.tipNotice, SIZE.small));
  }
  if (doc.footerLines.length > 0) c.push(dotted, ...doc.footerLines.map((l) => center(l, SIZE.small)));
  // Aire antes de cada separador que sigue a texto (ver `spacedDividers`).
  return spacedDividers([...c, ...end]);
}

/** Un reporte de caja (el cierre de turno): secciones de etiqueta → monto. */
export function reportToTerminalCommands(doc: ThermalReport): PrintCommand[] {
  const c = header(doc.businessName, doc.businessLines);
  c.push(center(doc.title, SIZE.title, true));
  for (const m of doc.metaRows) c.push(...amountRow(m.label, m.value));
  for (const section of doc.sections) {
    c.push(dotted, left(section.title, SIZE.small, true));
    c.push(...rows(section.rows.map((r) => ({ label: r.label, amount: r.value, strong: r.strong }))));
    for (const n of section.notes) c.push(left(n, SIZE.small));
  }
  if (doc.footerLines.length > 0) c.push(dotted, ...doc.footerLines.map((l) => center(l, SIZE.small)));
  // Aire antes de cada separador que sigue a texto (ver `spacedDividers`).
  return spacedDividers([...c, ...end]);
}
