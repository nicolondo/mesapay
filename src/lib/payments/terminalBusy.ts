// Incidente del 2026-11-26: impresión a los 48 s de un cobro aprobado.
// 15 s por decisión del dueño tras desactivar Kushki el comprobante del datáfono.
// Pendiente de confirmar con datos reales.
export const POST_APPROVAL_PRINT_SECONDS = 15;

// A cloud refusal has the same code with or without a provider type prefix.
// TER-003 is also displayed as busy, but is an answer from the physical POS.
export const CLOUD_BUSY_CODE = "TERMINAL_BUSY";
export function isCloudTerminalBusy(code?: string | null) {
  return code?.split("/").pop()?.trim().toUpperCase() === CLOUD_BUSY_CODE;
}

// Older print relays send only the English busy message.
export function isTerminalBusy(code?: string | null, message?: string | null) {
  return isCloudTerminalBusy(code) || /(?:^|\/)TER-003$/i.test(code?.trim() ?? "") ||
    /^terminal is busy(?:[.\s]|$)/i.test(message?.trim() ?? "");
}
