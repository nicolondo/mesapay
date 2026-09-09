import path from "path";
import { readFile } from "fs/promises";
import { db } from "@/lib/db";
import { sftpConfigured, uploadFileToSftp } from "@/lib/sftp";
import { computeNitDv } from "@/lib/erp/exogena";

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

function safeFileName(name: string): string {
  const clean = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .slice(0, 120);
  return clean || "documento";
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
      fileUrl: true,
      fileName: true,
      sftpUploadedAt: true,
      restaurant: { select: { legalName: true, taxId: true } },
    },
  });
  if (!doc || doc.sftpUploadedAt) return; // ya entregado o inexistente

  try {
    const data = await readFile(localPathForUrl(doc.fileUrl));
    const legal = identity ?? doc.restaurant;
    const folder = folderNameForRestaurant(legal.legalName, legal.taxId);
    // Nombre remoto único y reconocible: <tipo>_<sufijo>_<nombre original>.
    const remoteName = `${doc.kind}_${doc.id.slice(-6)}_${safeFileName(doc.fileName)}`;
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
