// Incidente del 2026-11-26: impresión a los 48 s de un cobro aprobado.
// 15 s por decisión del dueño tras desactivar Kushki el comprobante del datáfono.
// Pendiente de confirmar con datos reales.
export const POST_APPROVAL_PRINT_SECONDS = 15;

// Older print relays send only the English busy message.
export function isTerminalBusy(code?: string | null, message?: string | null) {
  return /(?:^|\/)(?:TERMINAL_BUSY|TER-003)$/i.test(code?.trim() ?? "") ||
    /^terminal is busy(?:[.\s]|$)/i.test(message?.trim() ?? "");
}
