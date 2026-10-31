import path from "node:path";
import { unlink } from "node:fs/promises";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { delegate } from "@/lib/backups/snapshot";
import type { SnapshotRow } from "@/lib/backups/serialize";
import { FOREIGN_UPLOAD_COLUMNS, UPLOAD_COLUMNS } from "./policy";

type Client = Prisma.TransactionClient;

export const UPLOAD_URL_PREFIX = "/uploads/";

/** Raíz de los archivos subidos: la misma que usan las rutas de subida. */
export function uploadRoot(): string {
  return process.env.UPLOAD_DIR || path.join(process.cwd(), "public", "uploads");
}

/**
 * `/uploads/abc.webp` → ruta absoluta DENTRO de la raíz de subidas, o null si
 * la URL no es de un archivo subido (una foto externa `https://…`), intenta
 * salirse de la raíz (`..`) o apunta a la carpeta del CRM, que es de la
 * plataforma y nunca se toca desde un comercio.
 */
export function resolveUploadPath(url: unknown, root: string = uploadRoot()): string | null {
  if (typeof url !== "string" || !url.startsWith(UPLOAD_URL_PREFIX)) return null;
  const relative = url.slice(UPLOAD_URL_PREFIX.length).split(/[?#]/)[0];
  if (!relative || relative.includes("\0") || relative.includes("\\")) return null;
  if (relative === "crm" || relative.startsWith("crm/")) return null;
  const base = path.resolve(root);
  const absolute = path.resolve(base, relative);
  if (!absolute.startsWith(base + path.sep)) return null;
  return absolute;
}

export type ArchivedData = {
  restaurant: SnapshotRow;
  tables: Record<string, SnapshotRow[]>;
  platform: Record<string, SnapshotRow[]>;
};

export type UploadRef = { url: string; archive: false | "purchase-invoices" | "onboarding" };

/**
 * Archivos subidos que referencian las filas del comercio (las que se van a
 * borrar), sin repetir. Si una URL aparece en una columna que se conserva y
 * en otra que no, gana la que se conserva.
 */
export function collectUploadRefs(data: ArchivedData): UploadRef[] {
  const refs = new Map<string, UploadRef>();
  for (const column of UPLOAD_COLUMNS) {
    const rows =
      column.model === "Restaurant"
        ? [data.restaurant]
        : (data.tables[column.model] ?? data.platform[column.model] ?? []);
    for (const row of rows) {
      const url = row?.[column.field];
      if (typeof url !== "string" || !url.startsWith(UPLOAD_URL_PREFIX)) continue;
      const previous = refs.get(url);
      if (!previous || (!previous.archive && column.archive)) refs.set(url, { url, archive: column.archive });
    }
  }
  return [...refs.values()];
}

/**
 * URLs que alguna fila que QUEDA en la base sigue usando (otro comercio con
 * la misma foto, el logo de un grupo, un documento del CRM). Esos archivos no
 * se borran del disco.
 */
export async function stillReferencedUrls(client: Client, urls: readonly string[]): Promise<Set<string>> {
  const used = new Set<string>();
  if (!urls.length) return used;
  for (const column of [...UPLOAD_COLUMNS, ...FOREIGN_UPLOAD_COLUMNS]) {
    const d = delegate(client, { delegate: column.model.charAt(0).toLowerCase() + column.model.slice(1) });
    for (let i = 0; i < urls.length; i += 500) {
      const rows = await d.findMany({
        where: { [column.field]: { in: urls.slice(i, i + 500) } },
        select: { [column.field]: true },
      });
      for (const row of rows) {
        const value = row[column.field];
        if (typeof value === "string") used.add(value);
      }
    }
  }
  return used;
}

export type FileRemovalReport = { deleted: number; kept: number; missing: number; failed: number };

/**
 * Borra del disco los archivos del comercio. Se llama SÓLO después del
 * commit: si el borrado de la base fallara, los archivos siguen ahí. Cada
 * archivo se intenta por separado; un fallo se loguea y no frena al resto
 * (el comercio ya no existe: un archivo huérfano es basura, no un error del
 * borrado). Nunca toca nada fuera de la raíz de subidas.
 */
export async function removeUploadedFiles(
  urls: readonly string[],
  deps: { client?: Client; remove?: (absolutePath: string) => Promise<void>; root?: string } = {},
): Promise<FileRemovalReport> {
  const report: FileRemovalReport = { deleted: 0, kept: 0, missing: 0, failed: 0 };
  if (!urls.length) return report;
  const remove = deps.remove ?? ((p: string) => unlink(p));
  let used: Set<string>;
  try {
    used = await stillReferencedUrls(deps.client ?? db, urls);
  } catch (error) {
    // Sin poder confirmar que nadie más los usa, no se borra ninguno.
    console.error("restaurant_delete_files_check_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    report.kept = urls.length;
    return report;
  }
  for (const url of urls) {
    const absolute = resolveUploadPath(url, deps.root);
    if (!absolute || used.has(url)) {
      report.kept++;
      continue;
    }
    try {
      await remove(absolute);
      report.deleted++;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        report.missing++;
        continue;
      }
      report.failed++;
      console.error("restaurant_delete_file_failed", {
        url,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return report;
}
