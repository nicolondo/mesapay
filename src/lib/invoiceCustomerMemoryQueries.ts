import "server-only";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { recordAuditEvent } from "@/lib/auditLog";
import { billingCustomerSchema } from "@/lib/billingCustomers";
import type { InvoiceRequestFields } from "@/lib/invoiceRequestInput";
import {
  LOOKUP_TOKEN_TTL_MS,
  decideMemoryAction,
  hashLookupToken,
  pickBestCustomer,
  signLookupToken,
  verifyLookupToken,
  type MemoryAction,
  type MemoryActor,
} from "@/lib/invoiceCustomerMemory";

/**
 * Lado con base de datos de "Recordar mis datos" (las reglas están en
 * src/lib/invoiceCustomerMemory.ts). Nada de acá escribe la cédula en los
 * logs: la auditoría guarda el id del registro, la orden y QUÉ campos
 * cambiaron, nunca los valores.
 */

type DocType = "CC" | "CE" | "NIT" | "PA";

const customerSelect = {
  id: true,
  restaurantId: true,
  customerName: true,
  docType: true,
  docNumber: true,
  verificationDigit: true,
  email: true,
  ccEmails: true,
  phone: true,
  address: true,
  municipalityCode: true,
  city: true,
  department: true,
  country: true,
  creditEnabled: true,
  creditLimitCents: true,
  creditTermsDays: true,
  discountEnabled: true,
  discountBps: true,
  selfService: true,
  rememberOptOutAt: true,
  updatedAt: true,
  _count: { select: { voucherBatches: true, voucherStatements: true, creditCharges: true, creditPayments: true } },
} satisfies Prisma.BillingCustomerSelect;

export type SavedCustomerRow = Prisma.BillingCustomerGetPayload<{ select: typeof customerSelect }>;

export function hasBenefitHistory(row: SavedCustomerRow): boolean {
  const c = row._count;
  return c.voucherBatches + c.voucherStatements + c.creditCharges + c.creditPayments > 0;
}

/**
 * El cliente guardado para ese documento en ESE comercio (nunca en otro),
 * o null. `docNumber` llega ya normalizado. Además de la coincidencia exacta
 * busca, dentro del mismo comercio y tipo, las filas viejas guardadas con
 * puntos, espacios o "-DV" (ver `pickBestCustomer`).
 *
 * `forDiner`: la búsqueda del comensal no ofrece los registros que él
 * mismo pidió dejar de recordar.
 */
export async function findSavedCustomer(
  restaurantId: string,
  docType: DocType,
  docNumber: string,
  opts: { forDiner?: boolean } = {},
): Promise<SavedCustomerRow | null> {
  const compact = Prisma.sql`regexp_replace(upper("docNumber"), '[.[:space:]]', '', 'g')`;
  const normalized = docType === "NIT" ? Prisma.sql`regexp_replace(${compact}, '-[0-9]$', '')` : compact;
  const legacy = await db.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "BillingCustomer"
    WHERE "restaurantId" = ${restaurantId}
      AND "docType" = ${docType}::"InvoiceDocType"
      AND "docNumber" <> ${docNumber}
      AND ${normalized} = ${docNumber}
    LIMIT 20`;
  const rows = await db.billingCustomer.findMany({
    where: {
      restaurantId,
      docType,
      OR: [{ docNumber }, ...(legacy.length ? [{ id: { in: legacy.map((r) => r.id) } }] : [])],
      ...(opts.forDiner ? { rememberOptOutAt: null } : {}),
    },
    select: customerSelect,
  });
  return pickBestCustomer(rows, docNumber);
}

/** Crea el token de "Usar estos datos" para esta orden. Devuelve el token en claro (sólo viaja al cliente). */
export async function createLookupToken(restaurantId: string, orderId: string, billingCustomerId: string): Promise<string> {
  const token = signLookupToken(restaurantId, orderId);
  const now = Date.now();
  // Limpieza de paso: los vencidos de esta orden ya no sirven.
  await db.invoiceCustomerLookup.deleteMany({ where: { orderId, expiresAt: { lt: new Date(now) } } });
  await db.invoiceCustomerLookup.create({
    data: {
      tokenHash: hashLookupToken(token),
      restaurantId,
      orderId,
      billingCustomerId,
      expiresAt: new Date(now + LOOKUP_TOKEN_TTL_MS),
    },
  });
  return token;
}

export type ConsumedLookup =
  | { ok: true; customer: SavedCustomerRow }
  | { ok: false; error: "saved_customer_expired" };

/**
 * Canjea el token: tiene que ser de ESTA orden y ESTE comercio, no vencido
 * y no usado. El "un solo uso" lo da el `updateMany` condicionado: de dos
 * canjes simultáneos sólo uno marca `usedAt`.
 */
export async function consumeLookupToken(token: string, restaurantId: string, orderId: string): Promise<ConsumedLookup> {
  if (!verifyLookupToken(token, restaurantId, orderId)) return { ok: false, error: "saved_customer_expired" };
  const tokenHash = hashLookupToken(token);
  const now = new Date();
  const row = await db.invoiceCustomerLookup.findUnique({
    where: { tokenHash },
    select: { billingCustomerId: true },
  });
  if (!row) return { ok: false, error: "saved_customer_expired" };
  const claimed = await db.invoiceCustomerLookup.updateMany({
    where: { tokenHash, restaurantId, orderId, usedAt: null, expiresAt: { gt: now } },
    data: { usedAt: now },
  });
  if (claimed.count !== 1) return { ok: false, error: "saved_customer_expired" };
  const customer = await db.billingCustomer.findFirst({
    where: { id: row.billingCustomerId, restaurantId },
    select: customerSelect,
  });
  if (!customer) return { ok: false, error: "saved_customer_expired" };
  return { ok: true, customer };
}

export type MemoryOutcome = MemoryAction & { customerId?: string };

/**
 * `editableBySelfService` como filtro de la escritura: si entre la lectura
 * y el UPDATE el personal le dio crédito, descuento o un bono, o lo editó,
 * el cambio del comensal no lo pisa.
 */
const SELF_SERVICE_EDITABLE = {
  selfService: true,
  creditEnabled: false,
  discountEnabled: false,
  voucherBatches: { none: {} },
  voucherStatements: { none: {} },
  creditCharges: { none: {} },
  creditPayments: { none: {} },
} satisfies Prisma.BillingCustomerWhereInput;

const DINER_AUDIT_ACTOR = { userId: null, email: "diner", role: "diner" } as const;

/**
 * Aplica "Recordar mis datos" tras guardar una solicitud con datos ESCRITOS
 * (no con "Usar estos datos"). Nunca rompe la solicitud: si algo falla, la
 * factura sale igual y sólo se pierde el recordatorio.
 */
export async function rememberInvoiceCustomer(args: {
  restaurantId: string;
  orderId: string;
  actor: MemoryActor;
  remember: boolean;
  fields: InvoiceRequestFields;
  /** Quien pide mandó la lista de correos adicionales (el personal); el comensal no. */
  ccEmailsProvided: boolean;
}): Promise<MemoryOutcome> {
  const { restaurantId, orderId, actor, remember, fields } = args;
  try {
    // Manda el DOCUMENTO escrito, no el cliente elegido en el buscador: si
    // el personal eligió uno y después cambió el número, es otra persona.
    const existing = await findSavedCustomer(restaurantId, fields.docType, fields.docNumber);
    const action = decideMemoryAction({
      actor,
      remember,
      existing: existing
        ? {
            selfService: existing.selfService,
            creditEnabled: existing.creditEnabled,
            discountEnabled: existing.discountEnabled,
            hasBenefitHistory: hasBenefitHistory(existing),
            customerName: existing.customerName,
            email: existing.email,
            ccEmails: existing.ccEmails,
            rememberOptOutAt: existing.rememberOptOutAt,
          }
        : null,
      incoming: {
        customerName: fields.customerName,
        email: fields.email,
        ...(args.ccEmailsProvided ? { ccEmails: fields.ccEmails } : {}),
      },
    });
    const auditActor = actor === "diner" ? { actor: { ...DINER_AUDIT_ACTOR } } : {};
    const now = new Date();

    if (action.kind === "create") {
      // Misma validación y normalización que el alta en Clientes.
      const parsed = billingCustomerSchema.safeParse({
        customerName: fields.customerName,
        docType: fields.docType,
        docNumber: fields.docNumber,
        email: fields.email,
        ccEmails: fields.ccEmails,
      });
      if (!parsed.success) return { kind: "none", reason: "unchanged" };
      try {
        const created = await db.billingCustomer.create({
          data: {
            ...parsed.data,
            restaurantId,
            selfService: action.selfService,
            rememberConsentAt: now,
          },
          select: { id: true },
        });
        await recordAuditEvent({
          kind: action.selfService ? "billing_customer.self_service.create" : "billing_customer.create",
          restaurantId,
          target: { type: "billing_customer", id: created.id },
          diff: { after: { source: "invoice_request", orderId, actor } },
          ...auditActor,
        });
        return { ...action, customerId: created.id };
      } catch (error) {
        // Dos solicitudes simultáneas con el mismo documento: la otra ganó.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          return { kind: "none", reason: "unchanged" };
        }
        throw error;
      }
    }

    if (!existing) return action;

    if (action.kind === "update") {
      const data: Prisma.BillingCustomerUpdateManyMutationInput = {
        rememberConsentAt: now,
        rememberOptOutAt: null,
        selfService: action.selfService,
      };
      if (action.fields.includes("customerName")) data.customerName = fields.customerName;
      if (action.fields.includes("email")) data.email = fields.email.trim().toLowerCase();
      if (action.fields.includes("ccEmails")) data.ccEmails = fields.ccEmails;
      // Condicionado a que siga siendo editable por quien lo cambia.
      const guard: Prisma.BillingCustomerWhereInput =
        actor === "manager" ? { id: existing.id, restaurantId } : { id: existing.id, restaurantId, ...SELF_SERVICE_EDITABLE };
      const updated = await db.billingCustomer.updateMany({ where: guard, data });
      if (updated.count === 0) return { kind: "none", reason: "protected" };
      await recordAuditEvent({
        kind: actor === "manager" ? "billing_customer.update" : "billing_customer.self_service.update",
        restaurantId,
        target: { type: "billing_customer", id: existing.id },
        diff: { after: { source: "invoice_request", orderId, actor, fields: action.fields } },
        ...auditActor,
      });
      return { ...action, customerId: existing.id };
    }

    if (action.kind === "opt_out") {
      const updated = await db.billingCustomer.updateMany({
        where: { id: existing.id, restaurantId, ...SELF_SERVICE_EDITABLE },
        data: { rememberOptOutAt: now },
      });
      if (updated.count === 0) return { kind: "none", reason: "protected" };
      await recordAuditEvent({
        kind: "billing_customer.remember_opt_out",
        restaurantId,
        target: { type: "billing_customer", id: existing.id },
        diff: { after: { source: "invoice_request", orderId, actor } },
        ...auditActor,
      });
      return { ...action, customerId: existing.id };
    }

    return { ...action, customerId: existing.id };
  } catch (error) {
    console.error("[invoice-customer-memory] no se pudo recordar el cliente", {
      orderId,
      error: error instanceof Error ? error.name : "unknown",
    });
    return { kind: "none", reason: "unchanged" };
  }
}

/** Constancia de que una factura se armó con un cliente guardado ("Usar estos datos"). */
export async function auditSavedCustomerUse(restaurantId: string, orderId: string, customerId: string, actor: MemoryActor) {
  await recordAuditEvent({
    kind: "billing_customer.saved_use",
    restaurantId,
    target: { type: "billing_customer", id: customerId },
    diff: { after: { source: "invoice_request", orderId, actor } },
    ...(actor === "diner" ? { actor: { ...DINER_AUDIT_ACTOR } } : {}),
  });
}

/**
 * La factura de esta orden salió (o va a salir) con un cliente guardado que
 * el comensal eligió sin escribir sus datos: a quien no es personal no se le
 * entrega el enlace de la factura (ni la tirilla), que trae el nombre
 * completo. Le llega al correo guardado.
 */
export async function orderInvoicedFromSavedCustomer(orderId: string): Promise<boolean> {
  const request = await db.invoiceRequest.findFirst({
    where: { orderId, status: { not: "rejected" } },
    orderBy: { createdAt: "desc" },
    select: { fromSavedCustomer: true },
  });
  return !!request?.fromSavedCustomer;
}
