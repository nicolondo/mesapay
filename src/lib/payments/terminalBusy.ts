// Older print relays send only the English busy message.
export function isTerminalBusy(code?: string | null, message?: string | null) {
  return /(?:^|\/)(?:TERMINAL_BUSY|TER-003)$/i.test(code?.trim() ?? "") ||
    /^terminal is busy(?:[.\s]|$)/i.test(message?.trim() ?? "");
}
