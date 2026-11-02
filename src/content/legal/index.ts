/**
 * Registro de los documentos legales públicos (/privacidad y /terminos).
 * Sin texto a la vista: los títulos y la interfaz van por i18n (`legal`).
 */
import { PRIVACIDAD } from "./privacidad";
import { TERMINOS } from "./terminos";
import type { LegalDocument, LegalDocumentId } from "./types";

export type { LegalDocument, LegalDocumentId } from "./types";
export { legalBody } from "./types";

/** Único canal de contacto para privacidad, derechos del titular y términos. */
export const LEGAL_CONTACT_EMAIL = "info@mesapay.co";

export const LEGAL_DOCUMENTS: Record<LegalDocumentId, LegalDocument> = {
  privacidad: PRIVACIDAD,
  terminos: TERMINOS,
};

/** Ruta pública de cada documento (en el dominio principal). */
export const LEGAL_PATHS: Record<LegalDocumentId, string> = {
  privacidad: "/privacidad",
  terminos: "/terminos",
};
