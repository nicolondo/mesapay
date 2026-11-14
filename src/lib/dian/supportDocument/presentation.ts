// Representación gráfica del documento soporte y de la nota de ajuste
// (art. 22 Res. 000167 de 2021 y §12 del anexo técnico). Puro: arma los
// literales fiscales y el contenido del código QR.
import { centsToDianAmount } from "@/lib/dian/crypto";
import { computeSupportDocTotals } from "./xml";
import { supportDocQrUrl } from "./constants";
import type { SupportDocSnapshot } from "./types";

/**
 * Denominación EXPRESA que exige la norma (art. 4 num. 1 y art. 5 num. 1
 * Res. 000167): es un literal fiscal, va igual en cualquier idioma.
 */
export const DS_DENOMINATION = "Documento soporte en adquisiciones efectuadas a no obligados a facturar";
export const NAS_DENOMINATION =
  "Nota de ajuste del documento soporte en adquisiciones efectuadas a sujetos no obligados a expedir factura o documento equivalente";

/**
 * Contenido del QR de la representación gráfica (anexo §12.2.1, págs.
 * 199-200): número, fecha y hora, identificación del vendedor y del
 * adquiriente, valores, CUDS y la URL de consulta. Los nombres de campo son
 * los del anexo. Nunca lleva el PIN del software (el ejemplo de la caja de
 * herramientas lo incluye por error; §14.2 exige reservarlo).
 */
export function supportDocQrText(args: {
  documentNumber: string;
  environment: "1" | "2";
  cuds: string;
  snapshot: SupportDocSnapshot;
}): string {
  const s = args.snapshot;
  const totals = computeSupportDocTotals(s.lines);
  const A = centsToDianAmount;
  return [
    `NumDS: ${args.documentNumber}`,
    `FecDS: ${s.issueDate ?? ""}`,
    `HorDS: ${s.issueTime ?? ""}`,
    `NumSNO: ${s.seller.companyId}`,
    `NITABS: ${s.buyer.nit}`,
    `ValDS: ${A(totals.lineExtensionCents)}`,
    `ValIva: ${A(totals.ivaCents)}`,
    `ValTolDS: ${A(totals.payableCents)}`,
    `CUDS: ${args.cuds}`,
    supportDocQrUrl(args.cuds, args.environment),
  ].join("\n");
}
