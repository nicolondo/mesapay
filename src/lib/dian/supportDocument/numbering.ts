// Consecutivos del documento soporte y de la nota de ajuste, y nombres de
// archivo. Todo dentro de la transacción que crea (o reenvía) el documento:
// si la transacción se cae, el número no se gasta.
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { SupportDocError } from "./errors";
import type { SupportDocKind } from "./types";

type Tx = Prisma.TransactionClient;

const MAX_INT = 2147483647;

/**
 * Asigna el siguiente número de la serie (NIT + ambiente + tipo + prefijo).
 * Un solo UPDATE condicionado: dos generaciones simultáneas nunca reciben el
 * mismo número. El DS arranca en el "desde" de la autorización y se agota en
 * el "hasta" (DSAD05b-e: número fuera del rango = rechazo). La nota de
 * ajuste usa numeración interna (art. 5 num. 2 Res. 000167) desde 1.
 */
export async function allocateNumber(
  tx: Tx,
  args: {
    issuerNit: string;
    environment: "1" | "2";
    kind: SupportDocKind;
    prefix: string;
    from: number;
    to: number;
  },
): Promise<{ seriesId: string; number: number }> {
  const to = Math.min(args.to, MAX_INT - 1);
  await tx.$executeRaw`
    INSERT INTO "SupportDocumentSeries" ("id", "issuerNit", "environment", "kind", "prefix", "nextNumber")
    VALUES (${randomUUID()}, ${args.issuerNit}, ${args.environment}, ${args.kind}, ${args.prefix}, ${args.from})
    ON CONFLICT ("issuerNit", "environment", "kind", "prefix") DO NOTHING`;
  const rows = await tx.$queryRaw<{ id: string; assigned: number }[]>`
    UPDATE "SupportDocumentSeries"
       SET "nextNumber" = GREATEST("nextNumber", ${args.from}) + 1
     WHERE "issuerNit" = ${args.issuerNit} AND "environment" = ${args.environment}
       AND "kind" = ${args.kind} AND "prefix" = ${args.prefix}
       AND GREATEST("nextNumber", ${args.from}) <= ${to}
    RETURNING "id", ("nextNumber" - 1)::int AS "assigned"`;
  const row = rows[0];
  if (!row) throw new SupportDocError("numbering_exhausted");
  return { seriesId: row.id, number: Number(row.assigned) };
}

/**
 * Nombres del XML y del ZIP (Anexo DS §8.4, pág. 114):
 *   ds  + NIT(10) + PPP + AA + consecutivo hexadecimal(8) → documento soporte
 *   nas + …                                               → nota de ajuste
 * PPP "000" = software propio (mismo criterio que las notas crédito). El ZIP
 * usa "z" + el mismo tallo, como en la factura (el anexo DS no lo define).
 */
export function supportDocFileNames(
  kind: SupportDocKind,
  issuerNit: string,
  year: number,
  sequence: number,
): { xmlFileName: string; zipFileName: string } {
  if (!/^\d{1,10}$/.test(issuerNit)) throw new Error("support_doc_invalid_nit");
  const stem =
    issuerNit.padStart(10, "0") +
    "000" +
    String(year).slice(-2) +
    sequence.toString(16).toUpperCase().padStart(8, "0");
  return {
    xmlFileName: `${kind === "support_document" ? "ds" : "nas"}${stem}.xml`,
    zipFileName: `z${stem}.zip`,
  };
}

/**
 * Consecutivo anual de nombres de archivo por NIT y ambiente. Comparte el
 * contador con las notas crédito (`CreditNoteFileSeries`, tabla de
 * plataforma): así ningún ZIP de este NIT repite nombre en el año, sea nota
 * crédito, documento soporte o nota de ajuste.
 */
export async function nextFileSequence(
  tx: Tx,
  issuerNit: string,
  environment: "1" | "2",
  year: number,
): Promise<number> {
  const nit = issuerNit.padStart(10, "0");
  await tx.$executeRaw`
    INSERT INTO "CreditNoteFileSeries" ("issuerNit", "environment", "year", "lastNumber")
    VALUES (${nit}, ${environment}, ${year}, 0)
    ON CONFLICT ("issuerNit", "environment", "year") DO NOTHING`;
  const rows = await tx.$queryRaw<{ lastNumber: number }[]>`
    UPDATE "CreditNoteFileSeries" SET "lastNumber" = "lastNumber" + 1
     WHERE "issuerNit" = ${nit} AND "environment" = ${environment} AND "year" = ${year}
       AND "lastNumber" < ${MAX_INT}
    RETURNING "lastNumber"`;
  if (!rows[0]) throw new SupportDocError("numbering_exhausted");
  return Number(rows[0].lastNumber);
}
