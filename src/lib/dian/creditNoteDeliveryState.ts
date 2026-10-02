/** Fiscal payloads are immutable. Recover uncertain sends by CUDE first. */
export const CREDIT_NOTE_LEASE_MS = 15 * 60_000;
export const CREDIT_NOTE_POLL_MS = 60_000;

export function creditNoteDeliveryDecision(
  note: {
    state: string;
    hasPayload: boolean;
    abandoned: boolean;
    leaseExpiresAt: Date | null;
  },
  now: Date,
): "prepare" | "lookup" | "skip" {
  if (note.abandoned || (note.leaseExpiresAt && note.leaseExpiresAt > now)) return "skip";
  if (!["to_send", "sent", "error", "pending"].includes(note.state)) return "skip";
  if (note.hasPayload) return "lookup";
  return note.state === "pending" ? "skip" : "prepare";
}

export function creditNoteLeaseWhere(id: string, restaurantId: string, now: Date) {
  return {
    id,
    restaurantId,
    kind: "credit_note",
    state: { in: ["to_send", "error", "sent", "pending"] },
    creditNote: { is: { abandonedAt: null } },
    OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
  };
}
