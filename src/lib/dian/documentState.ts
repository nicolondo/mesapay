// Máquina de estados de DianDocument (ERP B1.4) — mapeo puro entre el
// resultado de un web service (DianResult) y el estado persistido del
// documento. Sin DB: el caller (B1.6) lee/escribe DianDocument y usa
// esto para decidir la transición. Estados del schema:
//   to_send | sent | pending | accepted | rejected | error
import type { DianResult } from "@/lib/dian/soap";

export type DianDocState =
  | "to_send"
  | "sent"
  | "pending"
  | "accepted"
  | "rejected"
  | "error";

export type StateTransition = {
  state: DianDocState;
  cufe?: string | null;
  trackId?: string | null;
  errors: string[];
  /** ¿Volver a consultar (GetStatus)? Solo desde pending. */
  poll: boolean;
  /** ¿La factura quedó fiscalmente válida (para la tirilla/email)? */
  fiscal: boolean;
};

/**
 * Estado tras enviar (SendBillSync / SendTestSetAsync). error se
 * distingue de rejected: error = falla de canal/timeout (reintentable);
 * rejected = la DIAN evaluó y no aceptó (requiere corregir).
 */
export function transitionAfterSend(
  result: DianResult,
  fallbackCufe?: string | null,
): StateTransition {
  switch (result.state) {
    case "accepted":
      return {
        state: "accepted",
        cufe: result.cufe ?? fallbackCufe ?? null,
        errors: [],
        poll: false,
        fiscal: true,
      };
    case "pending":
      return {
        state: "pending",
        cufe: fallbackCufe ?? null,
        trackId: result.zipKey ?? null,
        errors: [],
        poll: true,
        fiscal: false,
      };
    case "rejected":
      return {
        state: "rejected",
        cufe: result.cufe ?? fallbackCufe ?? null,
        errors: result.errors.length ? result.errors : ["Rechazada por la DIAN"],
        poll: false,
        fiscal: false,
      };
    case "error":
      return {
        state: "error",
        cufe: fallbackCufe ?? null,
        errors: result.errors.length ? result.errors : ["La DIAN no respondió"],
        poll: false,
        fiscal: false,
      };
  }
}

/**
 * Estado tras consultar (GetStatus / GetStatusZip) un documento pending.
 * Sigue pending si la DIAN aún procesa; un error de canal NO tumba el
 * documento (sigue pending, se reintenta después).
 */
export function transitionAfterPoll(
  result: DianResult,
  current: { cufe?: string | null; trackId?: string | null },
): StateTransition {
  if (result.state === "error") {
    return {
      state: "pending",
      cufe: current.cufe ?? null,
      trackId: current.trackId ?? null,
      errors: [],
      poll: true,
      fiscal: false,
    };
  }
  const t = transitionAfterSend(result, current.cufe);
  // Conserva el trackId al seguir pending.
  if (t.state === "pending") t.trackId = t.trackId ?? current.trackId ?? null;
  return t;
}

/** ¿Se puede (re)enviar un documento en este estado? */
export function canSend(state: DianDocState): boolean {
  return state === "to_send" || state === "error" || state === "rejected";
}
