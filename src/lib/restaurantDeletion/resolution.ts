import type { BlockerCode } from "./checks";

/**
 * Qué puede hacer el admin con cada bloqueo del borrado, desde el mismo
 * diálogo. Archivo sin dependencias de servidor (sólo tipos): lo usan la
 * ruta de acciones y el diálogo.
 *
 *   action   → hay una transición segura que YA existe en el sistema y el
 *              diálogo la ofrece con un botón (ver resolve.ts).
 *   operator → no se fuerza desde acá (plata en vuelo, estado incierto o
 *              documento fiscal). El diálogo explica qué hacer y ofrece
 *              entrar como el comercio en la pantalla donde se resuelve.
 *   manual   → no se fuerza y no hay pantalla que lo resuelva: sólo el texto.
 */
export const BLOCKER_ACTIONS = ["decline_pending_payments", "cancel_payment_links", "cancel_subscription"] as const;
export type BlockerAction = (typeof BLOCKER_ACTIONS)[number];

export function isBlockerAction(value: unknown): value is BlockerAction {
  return typeof value === "string" && (BLOCKER_ACTIONS as readonly string[]).includes(value);
}

/** Pantallas del panel del comercio a las que se entra como el comercio. */
export type OperatorDestination = "payments_review" | "wallet" | "invoices";

export const OPERATOR_DESTINATION_PATH: Record<OperatorDestination, string> = {
  // Cobros → "Requiere revisión": ahí se concilian los pagos y reembolsos en
  // vuelo con la respuesta del proveedor (src/lib/payments/reconciliation.ts).
  payments_review: "/operator/payments?status=review",
  wallet: "/operator/wallet",
  invoices: "/operator/facturas",
};

export type BlockerResolution =
  | { kind: "action"; action: BlockerAction }
  | { kind: "operator"; destination: OperatorDestination }
  | { kind: "manual" };

// `Record` sobre el union a propósito: un bloqueo nuevo no compila hasta que
// alguien decida cómo se resuelve.
const RESOLUTION: Record<BlockerCode, BlockerResolution> = {
  payments_pending: { kind: "action", action: "decline_pending_payments" },
  payments_in_flight: { kind: "operator", destination: "payments_review" },
  refunds_in_flight: { kind: "operator", destination: "payments_review" },
  financial_operations_open: { kind: "operator", destination: "payments_review" },
  // Un retiro `initialized` ya salió hacia Kushki (la fila se crea después
  // del Transfer Out): no hay cómo cancelarlo, sólo esperar su webhook.
  payouts_in_flight: { kind: "operator", destination: "wallet" },
  payment_links_pending: { kind: "action", action: "cancel_payment_links" },
  // PSE iniciado: el banco todavía puede aprobarlo. Ninguna pantalla lo cierra.
  payment_links_in_flight: { kind: "manual" },
  // Fiscales: nunca desde acá.
  dian_pending: { kind: "operator", destination: "invoices" },
  dian_error: { kind: "operator", destination: "invoices" },
  subscription_active: { kind: "action", action: "cancel_subscription" },
  cross_tenant_references: { kind: "manual" },
};

export function resolutionFor(code: BlockerCode): BlockerResolution {
  return RESOLUTION[code] ?? { kind: "manual" };
}

/** Por qué el botón "Eliminar definitivamente" no se habilita (null = se habilita). */
export type DeleteDisabledReason = "blocked" | "slug_mismatch";

export type DeleteGate = {
  /** El campo del slug NUNCA se deshabilita: se puede enfocar y escribir siempre. */
  slugFieldDisabled: false;
  canDelete: boolean;
  reason: DeleteDisabledReason | null;
};

/**
 * Estado del pie del diálogo. Primero los bloqueos (aunque el slug ya
 * coincida, no se puede borrar), después el slug exacto (sin recortar
 * espacios: el servidor compara igual). Es comodidad: el servidor vuelve a
 * validar todo dentro de la transacción del borrado.
 */
export function deleteGate(args: { blockerCount: number; slugInput: string; slug: string }): DeleteGate {
  if (args.blockerCount > 0) return { slugFieldDisabled: false, canDelete: false, reason: "blocked" };
  if (args.slugInput !== args.slug) return { slugFieldDisabled: false, canDelete: false, reason: "slug_mismatch" };
  return { slugFieldDisabled: false, canDelete: true, reason: null };
}
