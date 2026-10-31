import { createHash } from "node:crypto";
import path from "node:path";
import { readFile } from "node:fs/promises";
import JSZip from "jszip";
import type { SnapshotData } from "@/lib/backups/snapshot";
import type { SnapshotRow } from "@/lib/backups/serialize";
import { formatInvoiceNumber, type InvoiceSnapshot } from "@/lib/invoice";
import { ARCHIVE_REDACTED_FIELDS } from "./policy";
import { resolveUploadPath, type UploadRef } from "./files";

/**
 * Archivo final de un comercio eliminado: un ZIP que se guarda en
 * `DeletedRestaurantArchive.archive` (tabla de plataforma, fuera de las del
 * comercio). Contenido:
 *
 *   manifest.json               quién, cuándo, conteos, qué se quitó, índice
 *   data/restaurant.json        { snapshot, platform }:
 *                                 snapshot = MISMO formato que las copias de
 *                                 seguridad (SnapshotData v1, src/lib/backups)
 *                                 platform = tablas de plataforma del comercio
 *                                 (usuarios, alta Kushki, config DIAN, pagos
 *                                 de la mensualidad, comisiones, auditoría…)
 *   fiscal/index.csv            un renglón por documento DIAN
 *   fiscal/invoices/<n>/        signed-xml.zip       XML firmado tal cual se envió
 *   fiscal/credit-notes/<n>/    dian-response.xml    respuesta (ApplicationResponse)
 *                               attached-document.xml el AttachedDocument, si se generó
 *                               document.json        la fila DIAN + la factura / nota
 *   files/purchase-invoices/    facturas de compra subidas (soporte contable)
 *   files/onboarding/           documentos del alta con Kushki
 *
 * Los secretos (ARCHIVE_REDACTED_FIELDS) salen como null. Los nombres de
 * carpeta y las claves son identificadores técnicos, no texto de interfaz.
 */
export const ARCHIVE_FORMAT = "mesapay-deleted-restaurant";
export const ARCHIVE_FORMAT_VERSION = 1;
/** Tope del ZIP final. Más grande no se guarda en una fila: no se borra nada. */
export const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;
/** Conservación mínima de los documentos fiscales en Colombia (art. 632 E.T.). */
export const FISCAL_RETENTION_YEARS = 5;

export type ArchiveInput = {
  restaurantId: string;
  restaurant: { name: string; slug: string; legalName: string | null; taxId: string | null; country: string | null };
  deletedAt: Date;
  deletedBy: { id: string | null; email: string };
  /** Snapshot del comercio, tal cual lo arma `takeSnapshot` (sin redactar). */
  snapshot: SnapshotData;
  /** Filas de las tablas de plataforma del comercio, serializadas (sin redactar). */
  platform: Record<string, SnapshotRow[]>;
  summary: Record<string, number>;
  /** Qué se hizo con cada usuario del comercio (ver users.ts). */
  users: { deleted: string[]; detached: string[]; disabled: { id: string; references: string[] }[] };
  uploads: readonly UploadRef[];
  uploadRoot?: string;
  readUpload?: (absolutePath: string) => Promise<Buffer>;
};

export type ArchiveManifest = {
  format: typeof ARCHIVE_FORMAT;
  formatVersion: typeof ARCHIVE_FORMAT_VERSION;
  generatedAt: string;
  restaurant: ArchiveInput["restaurant"] & { id: string };
  deletedBy: ArchiveInput["deletedBy"];
  summary: Record<string, number>;
  users: ArchiveInput["users"];
  tables: Record<string, number>;
  platformTables: Record<string, number>;
  snapshotVersion: number;
  redactedFields: string[];
  fiscal: { documents: number; invoices: number; creditNotes: number; retentionYears: number };
  files: { archived: { url: string; path: string; bytes: number }[]; missing: string[]; notArchived: number };
};

export type ArchiveResult = { zip: Buffer; sha256: string; manifest: ArchiveManifest };

/** Copia de las filas con los secretos en null; anota `Modelo.campo` en `redacted`. */
export function redactRows(model: string, rows: readonly SnapshotRow[], redacted: Set<string>): SnapshotRow[] {
  const fields = ARCHIVE_REDACTED_FIELDS[model];
  if (!fields?.length) return [...rows];
  return rows.map((row) => {
    const copy = { ...row };
    for (const field of fields) {
      if (field in copy && copy[field] != null) {
        copy[field] = null;
        redacted.add(`${model}.${field}`);
      }
    }
    return copy;
  });
}

function safeSegment(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+/, "_").slice(0, 120);
  return cleaned || "_";
}

function uniquePath(base: string, used: Set<string>, extension = ""): string {
  let candidate = `${base}${extension}`;
  for (let n = 2; used.has(candidate); n++) candidate = `${base}-${n}${extension}`;
  used.add(candidate);
  return candidate;
}

function csvCell(value: unknown): string {
  const text = value == null ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

type FiscalFile = { path: string; content: Buffer | string };

/**
 * Documentos DIAN del comercio, uno por carpeta: lo que se envió firmado, lo
 * que respondió la DIAN y el AttachedDocument cuando existe. Salen del mismo
 * snapshot que se archiva, así que son exactamente los que se borran.
 */
export function fiscalFiles(tables: Record<string, SnapshotRow[]>): {
  files: FiscalFile[];
  index: string;
  invoices: number;
  creditNotes: number;
} {
  const invoices = new Map((tables.SimpleInvoice ?? []).map((row) => [row.id, row]));
  const notes = new Map((tables.CreditNote ?? []).map((row) => [row.id, row]));
  const used = new Set<string>();
  const files: FiscalFile[] = [];
  const lines = [["kind", "number", "state", "issuedAt", "cufe", "totalCents", "folder"].join(",")];
  let invoiceCount = 0;
  let noteCount = 0;
  for (const doc of tables.DianDocument ?? []) {
    const isNote = doc.kind === "credit_note";
    if (isNote) noteCount++;
    else invoiceCount++;
    const invoice = typeof doc.simpleInvoiceId === "string" ? invoices.get(doc.simpleInvoiceId) : undefined;
    const note = typeof doc.creditNoteId === "string" ? notes.get(doc.creditNoteId) : undefined;
    let number: string | null = null;
    if (isNote && typeof note?.documentNumber === "string") number = note.documentNumber;
    else if (invoice && invoice.snapshot && typeof invoice.snapshot === "object") {
      number = formatInvoiceNumber(invoice.snapshot as InvoiceSnapshot, Number(invoice.invoiceNumber));
    }
    const folder = uniquePath(
      `fiscal/${isNote ? "credit-notes" : "invoices"}/${safeSegment(number ?? String(doc.id))}`,
      used,
    );
    if (typeof doc.xmlZip === "string" && doc.xmlZip) {
      files.push({ path: `${folder}/signed-xml.zip`, content: Buffer.from(doc.xmlZip, "base64") });
    }
    if (typeof doc.responseXml === "string" && doc.responseXml) {
      files.push({ path: `${folder}/dian-response.xml`, content: doc.responseXml });
    }
    if (typeof doc.deliveryXml === "string" && doc.deliveryXml) {
      files.push({ path: `${folder}/attached-document.xml`, content: doc.deliveryXml });
    }
    const { xmlZip: _zip, responseXml: _response, deliveryXml: _delivery, ...meta } = doc;
    void _zip;
    void _response;
    void _delivery;
    files.push({
      path: `${folder}/document.json`,
      content: JSON.stringify({ dianDocument: meta, simpleInvoice: invoice ?? null, creditNote: note ?? null }, null, 2),
    });
    const total = isNote ? note?.totalCents : invoice?.totalCents;
    lines.push(
      [doc.kind, number, doc.state, doc.issuedAt ?? doc.createdAt, doc.cufe, total, folder].map(csvCell).join(","),
    );
  }
  return { files, index: lines.join("\n") + "\n", invoices: invoiceCount, creditNotes: noteCount };
}

export async function buildArchive(input: ArchiveInput): Promise<ArchiveResult> {
  const redacted = new Set<string>();
  const tables: Record<string, SnapshotRow[]> = {};
  for (const [model, rows] of Object.entries(input.snapshot.tables)) tables[model] = redactRows(model, rows, redacted);
  const restaurantRow = redactRows("Restaurant", [input.snapshot.restaurant], redacted)[0];
  const platform: Record<string, SnapshotRow[]> = {};
  for (const [model, rows] of Object.entries(input.platform)) platform[model] = redactRows(model, rows, redacted);

  const zip = new JSZip();
  const snapshot: SnapshotData = { ...input.snapshot, restaurant: restaurantRow, tables };
  zip.file(
    "data/restaurant.json",
    JSON.stringify({ format: ARCHIVE_FORMAT, formatVersion: ARCHIVE_FORMAT_VERSION, snapshot, platform }),
  );

  // Fiscal: del snapshot SIN redactar (las filas DIAN no tienen secretos).
  const fiscal = fiscalFiles(input.snapshot.tables);
  for (const file of fiscal.files) zip.file(file.path, file.content);
  zip.file("fiscal/index.csv", fiscal.index);

  const read = input.readUpload ?? ((p: string) => readFile(p));
  const archived: ArchiveManifest["files"]["archived"] = [];
  const missing: string[] = [];
  const usedNames = new Set<string>();
  let notArchived = 0;
  for (const ref of input.uploads) {
    if (!ref.archive) {
      notArchived++;
      continue;
    }
    const absolute = resolveUploadPath(ref.url, input.uploadRoot);
    if (!absolute) {
      missing.push(ref.url);
      continue;
    }
    let content: Buffer;
    try {
      content = await read(absolute);
    } catch (error) {
      // Ya no está en el disco: se anota. Cualquier otro error (permisos,
      // disco) aborta el export — y con él, el borrado.
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        missing.push(ref.url);
        continue;
      }
      throw error;
    }
    const ext = path.extname(absolute);
    const cleanExt = ext.replace(/[^a-zA-Z0-9.]/g, "").slice(0, 12);
    const name = uniquePath(`files/${ref.archive}/${safeSegment(path.basename(absolute, ext))}`, usedNames, cleanExt);
    zip.file(name, content);
    archived.push({ url: ref.url, path: name, bytes: content.length });
  }

  const platformTables = Object.fromEntries(Object.entries(platform).map(([model, rows]) => [model, rows.length]));
  const tableCounts = Object.fromEntries(Object.entries(tables).map(([model, rows]) => [model, rows.length]));
  const manifest: ArchiveManifest = {
    format: ARCHIVE_FORMAT,
    formatVersion: ARCHIVE_FORMAT_VERSION,
    generatedAt: input.deletedAt.toISOString(),
    restaurant: { id: input.restaurantId, ...input.restaurant },
    deletedBy: input.deletedBy,
    summary: input.summary,
    users: input.users,
    tables: tableCounts,
    platformTables,
    snapshotVersion: input.snapshot.version,
    redactedFields: [...redacted].sort(),
    fiscal: {
      documents: fiscal.invoices + fiscal.creditNotes,
      invoices: fiscal.invoices,
      creditNotes: fiscal.creditNotes,
      retentionYears: FISCAL_RETENTION_YEARS,
    },
    files: { archived, missing, notArchived },
  };
  zip.file("manifest.json", JSON.stringify(manifest, null, 2));

  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
  return { zip: buffer, sha256: createHash("sha256").update(buffer).digest("hex"), manifest };
}
