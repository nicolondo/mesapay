import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { sameExtraEmails } from "@/lib/invoiceEmails";

/**
 * "Recordar mis datos" de la factura PERSONALIZADA — reglas PURAS (sin DB).
 *
 * El dueño: "que la próxima vez tenga que poner solo la cédula y traiga
 * todos los datos". En cada lugar donde se pide factura personalizada el
 * primer paso es tipo + número de documento; si ese documento ya está
 * guardado en ESTE comercio (un `BillingCustomer`), se reutiliza.
 *
 * ── Privacidad: el comensal es anónimo ───────────────────────────────
 * Escribir una cédula no puede devolver los datos de otra persona. Al
 * comensal sólo le llega una versión ENMASCARADA (`maskName`, `maskEmail`)
 * para que reconozca los suyos, y un token corto, firmado, ligado a la orden
 * y de un solo uso (`signLookupToken`): la factura se arma en el servidor con
 * el registro guardado. El id del cliente nunca sale (no se puede enumerar).
 * Una solicitud armada así queda `fromSavedCustomer`: a quien no es personal
 * se le muestra enmascarada y no se le da el enlace de la factura — le llega
 * al correo guardado.
 *
 * Desde el comensal NUNCA se aplican crédito, descuento del cliente ni
 * bonos: sólo se copian los datos de facturación.
 *
 * ── Quién puede cambiar un registro guardado (`decideMemoryAction`) ──
 *  - `manager` (operador / administradores: BILLING_CUSTOMER_WRITE_ROLES):
 *    corrige cualquier cliente, como en Clientes. Lo que toca queda como
 *    del personal (`selfService = false`).
 *  - `diner` (comensal anónimo) y `assistant` (mesero, datáfono: personal
 *    sin permiso de editar Clientes): crean registros nuevos de
 *    autoservicio y sólo actualizan registros de AUTOSERVICIO SIN
 *    beneficios. Un cliente que creó o editó el personal, o que tiene
 *    crédito, descuento, bonos o cartera, no lo cambia nadie que sólo sepa
 *    la cédula: los datos nuevos se usan en ESA factura y nada más.
 *
 * ── La casilla "Recordar mis datos" ──────────────────────────────────
 * Marcada por defecto. Desmarcada: la factura sale igual con lo escrito
 * (está en la solicitud, que es lo que leen la emisión y la contabilidad),
 * pero no se crea ni actualiza ningún registro; si había uno de
 * autoservicio sin beneficios, deja de ofrecerse en la búsqueda del
 * comensal (`rememberOptOutAt`). Los del personal no se tocan.
 */

/** Cuánto vive el token de "Usar estos datos". */
export const LOOKUP_TOKEN_TTL_MS = 15 * 60_000;

/**
 * Tiempo mínimo de respuesta de la búsqueda del comensal: encontrado y no
 * encontrado tardan lo mismo (no se puede saber por el reloj si una cédula
 * está guardada).
 */
export const LOOKUP_MIN_RESPONSE_MS = 450;

/** Límites de la búsqueda del comensal: [intentos, ventana en segundos]. */
export const LOOKUP_LIMITS = {
  perOrder: [5, 15 * 60],
  perSession: [8, 15 * 60],
  perIp: [30, 15 * 60],
} as const;

/** Una orden admite búsqueda hasta este tiempo después de pagada. */
export const LOOKUP_PAID_WINDOW_MS = 24 * 3600_000;

const MASK = "•••";

function firstChars(word: string, n: number): string {
  const chars = Array.from(word);
  return chars.slice(0, chars.length <= n ? 1 : n).join("");
}

/**
 * "Juan Pérez Gómez" → "Ju••• P. G.". Lo justo para que la persona
 * reconozca su nombre; no alcanza para conocer el de otra.
 */
export function maskName(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return MASK;
  const [first, ...rest] = words;
  const initials = rest
    .map((w) => Array.from(w).find((c) => /\p{L}|\p{N}/u.test(c)))
    .filter((c): c is string => !!c)
    .slice(0, 3)
    .map((c) => c.toLocaleUpperCase() + ".");
  return [firstChars(first, 2) + MASK, ...initials].join(" ");
}

/**
 * "juan.perez@gmail.com" → "ju***@gm***.com"; "ana@empresa.com.co" →
 * "an***@em***.com.co". Se conserva sólo el sufijo del dominio.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return "***";
  const local = email.slice(0, at);
  const labels = email.slice(at + 1).toLowerCase().split(".").filter(Boolean);
  if (labels.length < 2) return `${firstChars(local, 2)}***@***`;
  const last = labels[labels.length - 1];
  const secondLast = labels[labels.length - 2];
  // Sufijo de dos niveles para los de país con segundo nivel genérico
  // (com.co, gov.co, com.br): el "host" queda en el label anterior.
  const suffixSize = labels.length >= 3 && last.length === 2 && secondLast.length <= 3 ? 2 : 1;
  const suffix = labels.slice(-suffixSize).join(".");
  const host = labels[labels.length - suffixSize - 1];
  return `${firstChars(local, 2)}***@${firstChars(host, 2)}***.${suffix}`;
}

export type InvoiceSummaryRow = {
  status: "pending" | "generated" | "rejected";
  customerName: string;
  docType: "CC" | "CE" | "NIT" | "PA";
  docNumber: string;
  email: string;
  ccEmails?: string[];
  fromSavedCustomer?: boolean;
};

export type InvoiceSummaryView = Omit<InvoiceSummaryRow, "fromSavedCustomer"> & { masked?: true };

/**
 * Resumen de la solicitud tal como lo puede ver quien mira. El personal ve
 * todo; a quien no es personal, una solicitud armada con un cliente guardado
 * le llega enmascarada (el documento sí: es lo que él mismo escribió).
 */
export function invoiceSummaryFor(row: InvoiceSummaryRow, viewerIsStaff: boolean): InvoiceSummaryView {
  const base = {
    status: row.status,
    customerName: row.customerName,
    docType: row.docType,
    docNumber: row.docNumber,
    email: row.email,
    ccEmails: row.ccEmails ?? [],
  };
  if (viewerIsStaff || !row.fromSavedCustomer) return base;
  return {
    ...base,
    customerName: maskName(row.customerName),
    email: maskEmail(row.email),
    ccEmails: base.ccEmails.map(maskEmail),
    masked: true,
  };
}

// ── Elegir el registro ───────────────────────────────────────────────

export type CandidateCustomer = {
  id: string;
  docNumber: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  municipalityCode: string | null;
  updatedAt: Date;
};

/**
 * Hay un índice único por (comercio, tipo, número), pero los clientes
 * cargados antes de que el número se guardara normalizado (#484) pueden
 * tener puntos o el DV ("901.944.469-1"), y entonces conviven con su forma
 * normalizada. No se borran ni se fusionan: para autocompletar gana el que
 * ya está normalizado, después el más completo y después el más reciente.
 */
export function pickBestCustomer<T extends CandidateCustomer>(rows: readonly T[], normalizedDoc: string): T | null {
  if (rows.length === 0) return null;
  const completeness = (r: CandidateCustomer) =>
    [r.email, r.phone, r.address, r.municipalityCode].filter((v) => v && v.trim()).length;
  return [...rows].sort((a, b) => {
    const exact = Number(b.docNumber === normalizedDoc) - Number(a.docNumber === normalizedDoc);
    if (exact) return exact;
    const complete = completeness(b) - completeness(a);
    if (complete) return complete;
    return b.updatedAt.getTime() - a.updatedAt.getTime();
  })[0];
}

// ── Quién puede cambiar qué ──────────────────────────────────────────

export type MemoryActor = "diner" | "assistant" | "manager";

export type ExistingCustomer = {
  selfService: boolean;
  creditEnabled: boolean;
  discountEnabled: boolean;
  /** Bonos, cargos o abonos de crédito colgados del cliente. */
  hasBenefitHistory: boolean;
  customerName: string;
  email: string;
  ccEmails: string[];
  rememberOptOutAt: Date | null;
};

export type MemoryField = "customerName" | "email" | "ccEmails";

export type MemoryAction =
  | { kind: "none"; reason: "not_remembered" | "unchanged" | "protected" }
  | { kind: "create"; selfService: boolean }
  | { kind: "update"; fields: MemoryField[]; selfService: boolean }
  | { kind: "opt_out" };

/**
 * Un registro que se deja cambiar desde el celular del comensal: nació del
 * autoservicio y no tiene ningún beneficio comercial.
 */
export function editableBySelfService(c: ExistingCustomer): boolean {
  return c.selfService && !c.creditEnabled && !c.discountEnabled && !c.hasBenefitHistory;
}

function sameEmail(a: string, b: string) {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Qué hacer con el registro guardado al pedir una factura con datos escritos. */
export function decideMemoryAction(args: {
  actor: MemoryActor;
  remember: boolean;
  existing: ExistingCustomer | null;
  /** `ccEmails` ausente = quien pide no los vio ni los mandó (el comensal): no se tocan. */
  incoming: { customerName: string; email: string; ccEmails?: string[] };
}): MemoryAction {
  const { actor, remember, existing, incoming } = args;
  const canEdit = existing ? actor === "manager" || editableBySelfService(existing) : false;
  if (!remember) {
    // Desmarcó la casilla: nada se guarda. Si había un registro de
    // autoservicio sin beneficios que se le estaba ofreciendo, deja de
    // ofrecerse. Los del personal no se tocan.
    if (existing && editableBySelfService(existing) && !existing.rememberOptOutAt) return { kind: "opt_out" };
    return { kind: "none", reason: "not_remembered" };
  }
  if (!existing) return { kind: "create", selfService: actor !== "manager" };
  if (!canEdit) return { kind: "none", reason: "protected" };
  const fields: MemoryField[] = [];
  if (existing.customerName.trim() !== incoming.customerName.trim()) fields.push("customerName");
  if (!sameEmail(existing.email, incoming.email)) fields.push("email");
  if (incoming.ccEmails && !sameExtraEmails(existing.ccEmails, incoming.ccEmails)) fields.push("ccEmails");
  // Un registro que el comensal había dejado de recordar vuelve con la
  // casilla marcada aunque los datos sean los mismos.
  if (fields.length === 0 && !existing.rememberOptOutAt) return { kind: "none", reason: "unchanged" };
  return { kind: "update", fields, selfService: actor === "manager" ? false : existing.selfService };
}

// ── Token de "Usar estos datos" ──────────────────────────────────────

function secret(): string {
  const value = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!value) throw new Error("AUTH_SECRET_required");
  return value;
}

function signature(nonce: string, restaurantId: string, orderId: string): string {
  return createHmac("sha256", secret())
    .update(`invoice-customer-lookup:${restaurantId}:${orderId}:${nonce}`)
    .digest()
    .subarray(0, 16)
    .toString("base64url");
}

/**
 * Token corto (≈45 caracteres): nonce aleatorio + firma HMAC ligada al
 * comercio y a la orden. La firma rechaza en el acto un token de otra orden;
 * el "un solo uso" y el vencimiento los garantiza la fila guardada (sólo
 * con el hash del token).
 */
export function signLookupToken(restaurantId: string, orderId: string): string {
  const nonce = randomBytes(16).toString("base64url");
  return `${nonce}.${signature(nonce, restaurantId, orderId)}`;
}

export function verifyLookupToken(token: string, restaurantId: string, orderId: string): boolean {
  const [nonce, sig, extra] = token.split(".");
  if (!nonce || !sig || extra !== undefined || nonce.length > 64) return false;
  const expected = Buffer.from(signature(nonce, restaurantId, orderId));
  const received = Buffer.from(sig);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

export function hashLookupToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// ── La orden admite búsqueda ─────────────────────────────────────────

/**
 * La búsqueda del comensal sólo vale dentro de una orden viva de ese
 * comercio: abierta, o pagada hace poco (la factura se puede pedir después
 * de pagar). Una cancelada o ya facturada con solicitud generada, no.
 */
export function orderAcceptsLookup(
  order: { status: string; paidAt: Date | null },
  hasGeneratedRequest: boolean,
  now = Date.now(),
): boolean {
  if (order.status === "cancelled" || hasGeneratedRequest) return false;
  if (order.status !== "paid") return true;
  return !!order.paidAt && now - order.paidAt.getTime() <= LOOKUP_PAID_WINDOW_MS;
}
