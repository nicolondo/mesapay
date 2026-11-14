// CUDS — Código Único de Documento Soporte (Anexo Técnico DS v1.1, §14.1,
// págs. 213-216). SHA-384 de la concatenación, en este orden:
//
//   NumDS + FecDS + HorDS + ValDS + CodImp("01") + ValImp + ValTot +
//   NumSNO + NITABS + Software-PIN + TipoAmbiente
//
// NumSNO es la identificación del VENDEDOR (no obligado) y NITABS la del
// ADQUIRIENTE (el comercio): al revés que en la factura. La línea
// "Composición del CUDS" del anexo copia por error los nombres de la factura
// (NitOFE, NumAdq); manda la tabla de definiciones y el ejemplo de la pág.
// 215, que este módulo reproduce en su test. No usa clave técnica: usa el PIN
// del software. La nota de ajuste se calcula igual sobre /CreditNote.
import { createHash } from "crypto";

export type CudsInputs = {
  /** Prefijo + número (cbc:ID). */
  documentNumber: string;
  issueDate: string;
  /** "HH:MM:SS-05:00". */
  issueTime: string;
  /** LegalMonetaryTotal/LineExtensionAmount con 2 decimales. */
  lineExtensionAmount: string;
  /** TaxTotal/TaxAmount del IVA ("0.00" si no hay IVA). */
  ivaAmount: string;
  /** LegalMonetaryTotal/PayableAmount. */
  payableAmount: string;
  /** Identificación del vendedor, sin DV ni separadores. */
  sellerId: string;
  /** NIT del adquiriente sin DV. */
  buyerNit: string;
  softwarePin: string;
  /** ProfileExecutionID: "1" producción · "2" pruebas. */
  environment: "1" | "2";
};

/** Cadena exacta que se hashea (expuesta para el test del ejemplo oficial). */
export function cudsPlainText(i: CudsInputs): string {
  return (
    i.documentNumber +
    i.issueDate +
    i.issueTime +
    i.lineExtensionAmount +
    "01" +
    i.ivaAmount +
    i.payableAmount +
    i.sellerId +
    i.buyerNit +
    i.softwarePin +
    i.environment
  );
}

export function computeCuds(i: CudsInputs): string {
  return createHash("sha384").update(cudsPlainText(i), "utf8").digest("hex");
}
