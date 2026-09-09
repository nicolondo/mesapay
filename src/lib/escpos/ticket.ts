/**
 * Render de la COMANDA térmica a bytes ESC/POS.
 *
 * Es la pieza que no vamos a poder depurar cómodamente una vez instalada
 * en una cocina, así que es puramente funcional: entra un documento,
 * sale un Buffer. Sin DB, sin i18n, sin `Date` implícito — todo lo que
 * varía (textos traducidos, hora ya formateada) llega resuelto en el
 * documento. Por eso se puede testear byte a byte.
 *
 * El contenido reproduce exactamente lo que hoy imprime la pestaña de
 * Chrome (`buildTicketHtml` en /operator/print/[station]/PrintListener):
 * estación, mesa o pickup, shortCode, número de ronda, hora, ítems con
 * cantidad, modificadores, notas y nombre del comensal.
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
  selectCodePage,
  separator,
  textSize,
  wrap,
} from "./commands";

export type ThermalTicketItem = {
  qty: number;
  /** Nombre del plato — snapshot de OrderItem.nameSnapshot. */
  name: string;
  /** Modificadores ya formateados ("Término: Medio", "Sin: cebolla"). */
  modifiers: string[];
  /** Nota que escribió el mesero/comensal para ESE plato. */
  notes: string | null;
  /** A qué comensal de la mesa le va el plato, si se registró. */
  guestName: string | null;
};

/**
 * El documento de la comanda con TODO ya resuelto en el idioma que
 * corresponde. Este objeto es lo que se persiste en PrintJob.payload:
 * el renderer no sabe de restaurantes, rondas ni catálogos i18n.
 */
export type ThermalTicket = {
  /** 80 o 58. Decide las columnas (48 vs 32) y por lo tanto los cortes. */
  paperWidthMm: number;
  /** Encabezado grande: "COCINA", "BAR · CÓCTELES". */
  stationLine: string;
  /** Línea gigante: "MESA 7" o "RECOGER · Ana". */
  destinationLine: string;
  /** Metadatos ya armados: "A4F2 · R2 · 19:41". */
  metaLine: string;
  /** Aviso centrado opcional: "FUERTES JUNTOS". */
  noticeLine: string | null;
  items: ThermalTicketItem[];
  /** Nota de la mesa completa, ya prefijada ("Mesa: sin picante"). */
  orderNote: string | null;
  /** Pie: nombre del comercio. */
  footer: string;
};

/** Versión del sobre que se guarda en PrintJob.payload. */
export const TICKET_PAYLOAD_VERSION = 1;

export type PrintJobPayload = {
  v: typeof TICKET_PAYLOAD_VERSION;
  ticket: ThermalTicket;
};

/**
 * Valida (sin confiar) un payload leído de la DB. Devuelve null si no
 * tiene la forma esperada — un job corrupto no debe tumbar la entrega
 * de los demás.
 */
export function parseTicketPayload(raw: unknown): ThermalTicket | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const env = raw as Record<string, unknown>;
  if (env.v !== TICKET_PAYLOAD_VERSION) return null;
  const t = env.ticket;
  if (!t || typeof t !== "object" || Array.isArray(t)) return null;
  const ticket = t as Record<string, unknown>;
  if (typeof ticket.paperWidthMm !== "number") return null;
  if (typeof ticket.stationLine !== "string") return null;
  if (typeof ticket.destinationLine !== "string") return null;
  if (typeof ticket.metaLine !== "string") return null;
  if (typeof ticket.footer !== "string") return null;
  if (!Array.isArray(ticket.items)) return null;
  const items: ThermalTicketItem[] = [];
  for (const rawItem of ticket.items) {
    if (!rawItem || typeof rawItem !== "object") return null;
    const i = rawItem as Record<string, unknown>;
    if (typeof i.qty !== "number" || typeof i.name !== "string") return null;
    items.push({
      qty: i.qty,
      name: i.name,
      modifiers: Array.isArray(i.modifiers)
        ? i.modifiers.filter((m): m is string => typeof m === "string")
        : [],
      notes: typeof i.notes === "string" ? i.notes : null,
      guestName: typeof i.guestName === "string" ? i.guestName : null,
    });
  }
  return {
    paperWidthMm: ticket.paperWidthMm,
    stationLine: ticket.stationLine,
    destinationLine: ticket.destinationLine,
    metaLine: ticket.metaLine,
    noticeLine:
      typeof ticket.noticeLine === "string" ? ticket.noticeLine : null,
    items,
    orderNote: typeof ticket.orderNote === "string" ? ticket.orderNote : null,
    footer: ticket.footer,
  };
}

/** Sangría de los renglones colgados (modificadores, notas, comensal). */
const INDENT = "   ";

/**
 * Bytes ESC/POS completos de una comanda, listos para escribir tal cual
 * al socket TCP:9100 de la impresora. El agente NO interpreta nada.
 */
export function renderTicket(ticket: ThermalTicket): Buffer {
  const cols = columnsForWidth(ticket.paperWidthMm);
  // A doble ancho entra la mitad de texto por renglón.
  const bigCols = Math.floor(cols / 2);
  const chunks: Buffer[] = [];

  chunks.push(INIT, selectCodePage());

  // ── Encabezado ──────────────────────────────────────────────────────
  chunks.push(align("center"), bold(true), textSize(2, 2));
  for (const l of wrap(ticket.stationLine, bigCols)) chunks.push(line(l));
  chunks.push(NORMAL_SIZE);
  chunks.push(separator(cols));

  chunks.push(textSize(2, 2));
  for (const l of wrap(ticket.destinationLine, bigCols)) chunks.push(line(l));
  chunks.push(NORMAL_SIZE, bold(false));

  for (const l of wrap(ticket.metaLine, cols)) chunks.push(line(l));
  if (ticket.noticeLine) {
    chunks.push(bold(true));
    for (const l of wrap(ticket.noticeLine, cols)) chunks.push(line(l));
    chunks.push(bold(false));
  }

  // ── Ítems ───────────────────────────────────────────────────────────
  chunks.push(align("left"));
  chunks.push(separator(cols));
  ticket.items.forEach((item, index) => {
    // Un renglón en blanco entre platos: con modificadores y notas
    // colgadas, sin él la comanda es un bloque de texto y el cocinero se
    // salta líneas. No va antes del primero para no desperdiciar papel.
    if (index > 0) chunks.push(LF);
    // Doble ALTO y no doble ancho: el cocinero lee el plato de lejos
    // pero siguen entrando 48/32 columnas, que es lo que evita que
    // "Hamburguesa doble con tocineta" se parta en cuatro renglones.
    chunks.push(bold(true), textSize(1, 2));
    for (const l of wrap(`${item.qty}x ${item.name}`, cols, { cont: INDENT })) {
      chunks.push(line(l));
    }
    chunks.push(NORMAL_SIZE, bold(false));

    const hung = { first: INDENT, cont: INDENT + "  " };
    for (const mod of item.modifiers) {
      for (const l of wrap(`- ${mod}`, cols, hung)) chunks.push(line(l));
    }
    if (item.notes) {
      chunks.push(bold(true));
      for (const l of wrap(`"${item.notes}"`, cols, hung)) chunks.push(line(l));
      chunks.push(bold(false));
    }
    if (item.guestName) {
      for (const l of wrap(item.guestName.toUpperCase(), cols, {
        first: INDENT,
      })) {
        chunks.push(line(l));
      }
    }
  });

  // ── Nota de la mesa + pie ───────────────────────────────────────────
  if (ticket.orderNote) {
    chunks.push(separator(cols), bold(true));
    for (const l of wrap(ticket.orderNote, cols)) chunks.push(line(l));
    chunks.push(bold(false));
  }
  chunks.push(separator(cols));
  chunks.push(align("center"));
  for (const l of wrap(ticket.footer, cols)) chunks.push(line(l));

  // ── Cierre ──────────────────────────────────────────────────────────
  // Alimentar antes de cortar: el cortador está unos milímetros por
  // encima del cabezal, sin este feed el corte se come el pie.
  chunks.push(align("left"), feed(4), cut(), LF);
  return Buffer.concat(chunks);
}
