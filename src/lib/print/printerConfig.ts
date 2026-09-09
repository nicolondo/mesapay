/**
 * Validación del SET de impresoras que publica el agente.
 *
 * ── Por qué la IP no se edita en la web ─────────────────────────────────
 * La dirección de cada impresora se escribe en la config del PROGRAMA que
 * corre en el local, no acá. Quien instala está parado frente a la
 * impresora: es el único que puede ver que el router le cambió la IP y
 * arreglarlo en el momento. Una pantalla web editando IPs sería un
 * formulario que sólo se toca cuando algo ya se rompió, y desde otra
 * ciudad. Así que el agente PUBLICA su config con
 * `POST /api/print-agent/printers` y la web la MUESTRA.
 *
 * Este módulo es puro a propósito (sin DB, sin `server-only`): es la
 * parte que hay que poder testear sin levantar nada, igual que
 * `claim.ts` y `routing.ts`.
 */

import { z } from "zod";
import { PrepStation, PrinterKind } from "@prisma/client";

/** Las estaciones válidas, tomadas del enum de Prisma para que no deriven. */
export const PREP_STATIONS = Object.values(PrepStation) as [
  PrepStation,
  ...PrepStation[],
];

/** Qué imprime cada impresora: comanda de cocina o tirilla del cliente. */
export const PRINTER_KINDS = Object.values(PrinterKind) as [
  PrinterKind,
  ...PrinterKind[],
];

/**
 * Tope de impresoras por agente. No es una restricción de producto: es
 * para que un agente con la config corrupta no pueda mandar 10.000 filas
 * en un request.
 */
export const MAX_PRINTERS_PER_AGENT = 32;

/**
 * ¿`host` es una IPv4 o un hostname usable?
 *
 * Se validan las dos formas porque hay locales que le ponen IP fija a la
 * térmica y otros que la resuelven por nombre (mDNS/DNS del router). Lo
 * que NO se acepta es cualquier cosa: un `host` con espacios, con `:` o
 * con `/` es casi siempre alguien pegando "192.168.1.50:9100" o una URL
 * entera en el campo, y eso hay que devolvérselo al instalador ahora y
 * no dejar que falle recién cuando haya una comanda esperando.
 */
export function isValidPrinterHost(host: string): boolean {
  if (host.length === 0 || host.length > 253) return false;
  if (isIPv4(host)) return true;
  return isHostname(host);
}

function isIPv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => {
    if (!/^\d{1,3}$/.test(p)) return false;
    // "01" no es un octeto: en muchas libs se interpreta como octal y
    // termina apuntando a otra máquina.
    if (p.length > 1 && p.startsWith("0")) return false;
    return Number(p) <= 255;
  });
}

function isHostname(host: string): boolean {
  // Un hostname que es sólo dígitos y puntos pero no pasó isIPv4 es una
  // IP mal escrita ("192.168.1.300"), no un nombre.
  if (/^[\d.]+$/.test(host)) return false;
  const labels = host.split(".");
  return labels.every(
    (l) => l.length > 0 && l.length <= 63 && /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(l),
  );
}

/**
 * `localKey` = cómo llama el programa a esa impresora en su config local.
 * Corto, sin espacios y estable: es la llave del upsert, así que si
 * cambia se crea una impresora nueva en vez de actualizar la vieja.
 */
const localKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9._:-]+$/);

export const reportedPrinterSchema = z.object({
  localKey: localKeySchema,
  label: z.string().trim().min(1).max(80),
  host: z.string().trim().min(1).max(253).refine(isValidPrinterHost),
  port: z.number().int().min(1).max(65535).default(9100),
  /**
   * OPCIONAL con default `comanda`, y tiene que seguir siéndolo: el
   * programa que corre en el local se escribió contra el contrato de
   * antes y no manda este campo. Un agente viejo, sin actualizar, debe
   * poder seguir publicando sus impresoras de cocina exactamente igual.
   */
  kind: z.enum(PRINTER_KINDS).default("comanda"),
  /**
   * Obligatoria en una impresora de comanda (`invalidKindStations` lo
   * verifica), prohibida en una de factura: una tirilla del cliente no
   * sale de una estación de preparación.
   */
  station: z.enum(PREP_STATIONS).nullish(),
  /**
   * Sólo con `station: "bar"` y sólo si el comercio definió
   * `Restaurant.barSubStations`. Que exista se valida en la ruta (hace
   * falta la fila del restaurante); acá sólo la forma.
   */
  barSubStation: z.string().trim().min(1).max(60).nullish(),
  /** null = hereda `Restaurant.printPaperWidthMm`. */
  paperWidthMm: z.number().int().min(20).max(120).nullish(),
  active: z.boolean().default(true),
});

export const printersReportSchema = z.object({
  printers: z.array(reportedPrinterSchema).max(MAX_PRINTERS_PER_AGENT),
});

export type ReportedPrinter = z.infer<typeof reportedPrinterSchema>;

/**
 * Los `localKey` repetidos dentro del MISMO body. Sin esto la última fila
 * ganaría en silencio y el instalador se quedaría preguntando por qué su
 * segunda impresora no aparece — con el agravante de que la fila que
 * "desaparece" es la que se copió y pegó mal.
 */
export function duplicateLocalKeys(printers: { localKey: string }[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const p of printers) {
    if (seen.has(p.localKey)) dupes.add(p.localKey);
    seen.add(p.localKey);
  }
  return [...dupes];
}

/**
 * Qué está mal en la combinación `kind` + `station` de cada impresora.
 *
 * Las dos formas de romperlo dejan una impresora que se ve perfecta en la
 * pantalla y no imprime NUNCA, que es el peor de los errores posibles:
 *
 *  - `comanda` sin estación: el ruteo no la engancha a nada, la cocina se
 *    queda esperando comandas que nadie encoló.
 *  - `factura` con estación: sugiere que va a recibir comandas, y no. Y
 *    una comanda saliendo por la impresora de la caja (o una factura por
 *    la de la parrilla) es un error que el cliente ve.
 *
 * Se devuelve el `localKey` y no un índice porque el instalador está
 * mirando SU archivo de configuración: ahí las impresoras se llaman
 * "cocina" y "caja", no "printers[2]".
 */
export type KindStationProblem = {
  localKey: string;
  kind: PrinterKind;
  problem: "station_required" | "station_not_allowed";
};

export function invalidKindStations(
  printers: Array<Pick<ReportedPrinter, "localKey" | "kind" | "station">>,
): KindStationProblem[] {
  const out: KindStationProblem[] = [];
  for (const p of printers) {
    const station = p.station ?? null;
    if (p.kind === "comanda" && station === null) {
      out.push({ localKey: p.localKey, kind: p.kind, problem: "station_required" });
    }
    if (p.kind === "factura" && station !== null) {
      out.push({
        localKey: p.localKey,
        kind: p.kind,
        problem: "station_not_allowed",
      });
    }
  }
  return out;
}

/**
 * Sub-estaciones que el body menciona y el comercio no tiene definidas.
 * Una impresora apuntando a una sub-estación inexistente no recibiría
 * NUNCA un trabajo (`printerMatches` no la haría coincidir con nada) y
 * eso desde la web se ve como "la impresora está bien, pero no imprime".
 *
 * `barSubStation` en una impresora que no es de barra también es un
 * error: el ruteo la ignoraría. Eso incluye a las de FACTURA, que no
 * tienen estación — una tirilla del cliente no sale de la barra.
 */
export function invalidSubStations(
  printers: Pick<ReportedPrinter, "station" | "barSubStation">[],
  allowed: string[],
): string[] {
  const set = new Set(allowed);
  const bad = new Set<string>();
  for (const p of printers) {
    const sub = p.barSubStation ?? null;
    if (!sub) continue;
    if (p.station !== "bar" || !set.has(sub)) bad.add(sub);
  }
  return [...bad];
}
