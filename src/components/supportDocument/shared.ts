// Tipos y utilidades compartidos por el panel del documento soporte. Los
// tipos espejan las respuestas de /api/operator/support-documents (se
// importan como `type`: no arrastran código del server al navegador).
import type { SupportDocPanel, SupportDocSupplierView, SupportDocView } from "@/lib/dian/supportDocument/view";
import type { SupportDocSourceType } from "@/lib/dian/supportDocument/types";

export type { SupportDocPanel, SupportDocSupplierView, SupportDocView, SupportDocSourceType };

export type ApiError = { error?: string; detail?: string[] };

export const inputCls =
  "w-full h-10 px-3 rounded-lg border border-op-border bg-op-bg text-sm focus:outline-none focus:border-op-text/40";

export const labelCls = "block font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted mb-1";

/** Clase del distintivo según el estado DIAN. */
export function stateTone(state: string, voided = false): string {
  if (voided) return "bg-paper text-op-muted";
  if (state === "accepted") return "bg-ok/15 text-ok";
  if (state === "rejected") return "bg-danger/15 text-danger";
  if (state === "error") return "bg-[#C98A2E]/15 text-[#7F5A1F]";
  return "bg-paper text-op-muted";
}

export const ERROR_CODES = new Set([
  "module_disabled",
  "not_enabled",
  "no_config",
  "no_certificate",
  "certificate_expired",
  "missing_software",
  "master_key_missing",
  "decrypt_failed",
  "missing_resolution",
  "resolution_expired",
  "numbering_exhausted",
  "test_set_missing",
  "emisor_incomplete",
  "source_not_found",
  "source_not_ready",
  "no_supplier",
  "supplier_not_flagged",
  "supplier_incomplete",
  "inc_not_supported",
  "iva_mismatch",
  "operation_in_future",
  "operation_too_old",
  "empty_document",
  "already_exists",
  "not_found",
  "not_adjustable",
  "adjustment_exceeds",
  "reason_too_short",
  "invalid_reason",
  "not_resendable",
  "environment_changed",
]);
