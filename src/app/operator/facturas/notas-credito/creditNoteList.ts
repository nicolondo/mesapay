import type { CreditNoteDto } from "@/lib/dian/creditNotes/types";

export type CreditNoteDisplayState = "draft" | "to_send" | "pending" | "signed" | "sent" | "accepted" | "rejected" | "error" | "abandoned" | "not_received";
const KNOWN: readonly string[] = ["draft", "to_send", "pending", "signed", "sent", "accepted", "rejected", "error", "abandoned"];

/**
 * Estado que ve el comercio. Una nota firmada sin salida no es un «error de
 * envío»: el rechazo definitivo (incluido el conflicto de numeración) se
 * muestra como rechazada y la consistentemente no encontrada como «No
 * recibida por la DIAN».
 */
export function creditNoteDisplayState(note: Pick<CreditNoteDto, "abandonedAt" | "document"> & { failure?: CreditNoteDto["failure"] }): CreditNoteDisplayState {
  if (note.abandonedAt) return "abandoned";
  if (note.failure === "not_received") return "not_received";
  if (note.failure === "numbering_conflict" || note.failure === "dian_rejected") return "rejected";
  const state = note.document?.state ?? "draft";
  return (KNOWN.includes(state) ? state : "pending") as CreditNoteDisplayState;
}

/**
 * Descartar no borra el registro fiscal: la nota sólo sale de la lista
 * principal. Por defecto se ocultan; «Ver descartadas (N)» las muestra.
 */
export function visibleCreditNotes<T extends Pick<CreditNoteDto, "abandonedAt">>(notes: T[], showAbandoned: boolean): { visible: T[]; abandonedCount: number } {
  const abandonedCount = notes.filter(note => note.abandonedAt).length;
  return { visible: showAbandoned ? notes : notes.filter(note => !note.abandonedAt), abandonedCount };
}

/** Marcadores internos que el detalle explica con su propio mensaje, no como regla DIAN. */
const FAILURE_MARKERS = new Set(["dian_numbering_conflict", "dian_not_received"]);
export function detailErrorMessages(document: Pick<NonNullable<CreditNoteDto["document"]>, "errors" | "lastError"> | null | undefined, failure: CreditNoteDto["failure"] | undefined): string[] {
  const messages = [...(document?.errors ?? []), ...(document?.lastError ? [document.lastError] : [])].map(message => message.trim()).filter(Boolean);
  return [...new Set(failure ? messages.filter(message => !FAILURE_MARKERS.has(message)) : messages)];
}
