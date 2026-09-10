import path from "path";
import { readFile } from "fs/promises";
import { db } from "@/lib/db";
import { sftpConfigured, uploadFileToSftp } from "@/lib/sftp";
import { computeNitDv } from "@/lib/erp/exogena";
import type { KushkiDocumentKind } from "@prisma/client";

export { sftpConfigured };

export type SftpMerchantIdentity = {
  legalName: string | null | undefined;
  taxId: string | null | undefined;
};

/** Razón social normalizada + NIT sin DV; los espacios del nombre se conservan. */
export function folderNameForRestaurant(
  legalName: string | null | undefined,
  taxId: string | null | undefined,
): string {
  const name = (legalName ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/\./g, "")
    .replace(/[^A-Z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const match = /^(\d{1,15})(?:-(\d))?$/.exec(
    (taxId ?? "").replace(/[.\s]/g, ""),
  );
  if (!name || !match) throw new Error("sftp_missing_legal_identity");
  const [, nit, dv] = match;
  if (dv !== undefined && computeNitDv(nit) !== dv)
    throw new Error("sftp_invalid_nit_dv");
  // Keep the complete NIT even when a legal name reaches the filesystem limit.
  return `${name.slice(0, 200).trim()} - ${nit}`;
}

/** fileUrl (/uploads/onboarding/xxx) → ruta local en disco. */
function localPathForUrl(fileUrl: string): string {
  const base =
    process.env.UPLOAD_DIR || path.join(process.cwd(), "public", "uploads");
  const rel = fileUrl.replace(/^\/uploads\//, "");
  return path.join(base, rel);
}

// Nombres del intercambio con Kushki, independientes del idioma de la interfaz.
const DOCUMENT_LABELS: Record<KushkiDocumentKind, string> = {
  rut: "RUT",
  cedula_rep_legal: "Cedula del representante legal",
  camara_comercio: "Camara de comercio",
  bank_cert: "Certificacion bancaria",
  origen_fondos: "Certificacion de origen de fondos",
  estados_financieros: "Estados financieros",
  estatutos: "Estatutos de la sociedad",
  other: "Documento adicional",
};
const DOCUMENT_EXTENSIONS: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

/** Nombre del tipo y extensión real, sin identificadores ni nombre original. */
export function fileNameForSftpDocument(doc: {
  id: string;
  kind: KushkiDocumentKind;
  mimeType: string;
}): string {
  const label = DOCUMENT_LABELS[doc.kind];
  const extension = DOCUMENT_EXTENSIONS[doc.mimeType];
  if (!label || !extension || !/^[a-zA-Z0-9_-]{1,80}$/.test(doc.id)) {
    throw new Error("sftp_invalid_document_identity");
  }
  return `${label}.${extension}`;
}

/**
 * Entrega best-effort de un documento de onboarding al SFTP, en una carpeta
 * con el nombre del comercio. Actualiza sftpUploadedAt/sftpError/sftpAttempts.
 * NO lanza — el caller (upload o cron) sigue igual si falla.
 */
export async function deliverDocumentToSftp(
  documentId: string,
  identity?: SftpMerchantIdentity,
): Promise<void> {
  if (!sftpConfigured()) return;
  const doc = await db.kushkiDocument.findUnique({
    where: { id: documentId },
    select: {
      id: true,
      kind: true,
      restaurantId: true,
      fileUrl: true,
      mimeType: true,
      sftpUploadedAt: true,
      restaurant: { select: { legalName: true, taxId: true } },
    },
  });
  if (!doc || doc.sftpUploadedAt) return; // ya entregado o inexistente

  try {
    // A type-only name is ambiguous when several active uploads would target
    // the same remote file. Keep delivery pending instead of losing a document.
    const siblings = await db.kushkiDocument.findMany({
      where: { restaurantId: doc.restaurantId, kind: doc.kind },
      select: { id: true, kind: true, mimeType: true },
    });
    const remoteName = fileNameForSftpDocument(doc);
    if (
      siblings.some(
        (other) =>
          other.id !== doc.id && fileNameForSftpDocument(other) === remoteName,
      )
    ) {
      throw new Error("sftp_document_name_conflict");
    }
    const data = await readFile(localPathForUrl(doc.fileUrl));
    const legal = identity ?? doc.restaurant;
    const folder = folderNameForRestaurant(legal.legalName, legal.taxId);
    await uploadFileToSftp({ folder, fileName: remoteName, data });
    await db.kushkiDocument.update({
      where: { id: doc.id },
      data: {
        sftpUploadedAt: new Date(),
        sftpError: null,
        sftpAttempts: { increment: 1 },
      },
    });
    console.log(
      `[onboarding/sftp] delivered ${doc.id} → ${folder}/${remoteName}`,
    );
  } catch (err) {
    const msg =
      err instanceof Error
        ? err.message.slice(0, 200)
        : String(err).slice(0, 200);
    console.error("[onboarding/sftp] upload failed", documentId, msg);
    await db.kushkiDocument
      .update({
        where: { id: documentId },
        data: { sftpError: msg, sftpAttempts: { increment: 1 } },
      })
      .catch(() => undefined);
  }
}

/**
 * Entrega todos los documentos de un comercio que aún no llegaron al SFTP.
 * Best-effort: no lanza. Devuelve cuántos quedaron entregados en total.
 */
export async function deliverPendingDocsToSftp(
  restaurantId: string,
  identity?: SftpMerchantIdentity,
): Promise<{ configured: boolean; delivered: number; total: number }> {
  const docs = await db.kushkiDocument.findMany({
    where: { restaurantId },
    select: { id: true, sftpUploadedAt: true },
  });
  if (!sftpConfigured()) {
    return { configured: false, delivered: 0, total: docs.length };
  }
  for (const d of docs) {
    if (!d.sftpUploadedAt) await deliverDocumentToSftp(d.id, identity);
  }
  const after = await db.kushkiDocument.count({
    where: { restaurantId, sftpUploadedAt: { not: null } },
  });
  return { configured: true, delivered: after, total: docs.length };
}

/**
 * Entrega el manifiesto de datos del comercio (razón social, NIT, contacto,
 * cuenta bancaria) como JSON en la carpeta del comercio. Es la data
 * estructurada que Kushki necesita junto a los documentos KYC — antes iba por
 * la API de partner; ahora viaja por SFTP con el resto. Nombre fijo para que
 * un re-envío sobrescriba. Best-effort: no lanza.
 */
export async function deliverOnboardingManifest(
  restaurantId: string,
  manifest: Record<string, unknown>,
): Promise<boolean> {
  if (!sftpConfigured()) return false;
  try {
    if (Array.isArray(manifest.documents)) {
      const names = manifest.documents.map((d: { fileName?: string }) => d.fileName);
      if (new Set(names).size !== names.length)
        throw new Error("sftp_document_name_conflict");
    }
    const folder = folderNameForRestaurant(
      typeof manifest.legalName === "string" ? manifest.legalName : null,
      typeof manifest.taxId === "string" ? manifest.taxId : null,
    );
    const data = Buffer.from(JSON.stringify(manifest, null, 2), "utf8");
    await uploadFileToSftp({ folder, fileName: "datos-comercio.json", data });
    console.log(
      `[onboarding/sftp] manifest delivered → ${folder}/datos-comercio.json`,
      { restaurantId },
    );
    return true;
  } catch (err) {
    console.error(
      "[onboarding/sftp] manifest failed",
      err instanceof Error ? err.message.slice(0, 200) : err,
    );
    return false;
  }
}
