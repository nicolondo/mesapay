/**
 * De los documentos térmicos de siempre (los mismos que imprime la caja por
 * ESC/POS) a los comandos del Print API cloud de Kushki, para imprimir en
 * la impresora integrada del datáfono (Sunmi P3, Smart POS de Kushki).
 *
 * El contenido es el MISMO que el de la impresora de caja: cada función
 * recibe el documento ya armado y traducido (`ThermalInvoice`,
 * `ThermalPrebill`, `ThermalReport`) y sólo lo vuelve comandos — textos,
 * columnas etiqueta/monto, divisores, QR y el corte. El ancho lo pone el
 * equipo: los comandos no hablan de milímetros.
 *
 * Puro (sin DB ni red): se prueba sin Kushki.
 */

import type { PrintCommand } from "@/lib/payments/kushki/cloudPrint";
import type { ThermalInvoice } from "@/lib/escpos/invoice";
import type { ThermalPrebill } from "@/lib/escpos/prebill";
import type { ThermalReport } from "@/lib/escpos/report";

/** Tamaños de letra del Print API (los mismos de la factura del datáfono). */
const SIZE = { body: 24, small: 20, title: 28, business: 30 } as const;

const center = (text: string, size: number = SIZE.body, bold = false): PrintCommand => ({
  type: "text",
  text: text + "\n",
  align: "CENTER",
  size,
  bold,
});
const left = (text: string, size: number = SIZE.body, bold = false): PrintCommand => ({
  type: "text",
  text: text + "\n",
  align: "LEFT",
  size,
  bold,
});
const row = (label: string, value: string): PrintCommand => ({
  type: "columns",
  columns: [
    { text: label, weight: 2, align: "LEFT" },
    { text: value, weight: 1, align: "RIGHT" },
  ],
});
const strongRow = (label: string, value: string): PrintCommand[] => [
  { type: "divider", dividerType: "SOLID", offset: 4 },
  {
    type: "columns",
    columns: [
      { text: label, weight: 1, align: "LEFT" },
      { text: value, weight: 2, align: "RIGHT" },
    ],
  },
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

function rows(list: Array<{ label: string; amount: string; strong?: boolean }>): PrintCommand[] {
  return list.flatMap((r) => (r.strong ? strongRow(r.label, r.amount) : [row(r.label, r.amount)]));
}

function itemLines(
  items: Array<{ qty: number; name: string; amount: string; detail: string }>,
): PrintCommand[] {
  return items.flatMap((it) => {
    const out: PrintCommand[] = [row(`${it.qty}x ${it.name}`, it.amount)];
    if (it.detail) out.push(left(`   ${it.detail}`, SIZE.small));
    return out;
  });
}

const detailOf = (parts: Array<string | null | undefined>) =>
  parts.filter((p): p is string => !!p && p.trim().length > 0).join(" · ");

/** La factura (o el comprobante), con CUFE y QR si es electrónica aceptada. */
export function invoiceToTerminalCommands(doc: ThermalInvoice): PrintCommand[] {
  const c = header(doc.businessName, doc.businessLines);
  c.push(center(doc.documentLabel, SIZE.title, true), center(doc.documentNumber, SIZE.body, true));
  for (const m of doc.metaRows) c.push(row(m.label, m.value));
  for (const l of doc.customerLines) c.push(left(l, SIZE.small));
  c.push(dotted);
  c.push(
    ...itemLines(
      doc.items.map((it) => ({
        qty: it.qty,
        name: it.name,
        amount: it.amount,
        detail: detailOf([...(it.modifiers ?? []), it.notes ? `"${it.notes}"` : null]),
      })),
    ),
  );
  if (doc.itemsNote) c.push(left(doc.itemsNote, SIZE.small));
  c.push(solid, ...rows(doc.totals));
  if (doc.paymentTitle && doc.paymentRows.length > 0) {
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
      left(`${doc.fiscal.cufeLabel}: ${doc.fiscal.cufe}`, SIZE.small),
      ...doc.fiscal.noticeLines.map((l) => center(l, SIZE.small)),
    );
  }
  if (doc.footerLines.length > 0) {
    c.push(dotted, ...doc.footerLines.map((l) => center(l, SIZE.small)));
  }
  return [...c, ...end];
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
        detail: detailOf([
          it.unit ? `${it.qty} x ${it.unit}` : null,
          ...it.modifiers,
          it.notes ? `"${it.notes}"` : null,
        ]),
      })),
    ),
  );
  c.push(solid, ...rows(doc.totals));
  if (doc.tipRows.length > 0) {
    c.push(dotted, ...rows(doc.tipRows));
    if (doc.tipNotice) c.push(left(doc.tipNotice, SIZE.small));
  }
  if (doc.footerLines.length > 0) c.push(dotted, ...doc.footerLines.map((l) => center(l, SIZE.small)));
  return [...c, ...end];
}

/** Un reporte de caja (el cierre de turno): secciones de etiqueta → monto. */
export function reportToTerminalCommands(doc: ThermalReport): PrintCommand[] {
  const c = header(doc.businessName, doc.businessLines);
  c.push(center(doc.title, SIZE.title, true));
  for (const m of doc.metaRows) c.push(row(m.label, m.value));
  for (const section of doc.sections) {
    c.push(dotted, left(section.title, SIZE.small, true));
    c.push(...rows(section.rows.map((r) => ({ label: r.label, amount: r.value, strong: r.strong }))));
    for (const n of section.notes) c.push(left(n, SIZE.small));
  }
  if (doc.footerLines.length > 0) c.push(dotted, ...doc.footerLines.map((l) => center(l, SIZE.small)));
  return [...c, ...end];
}
