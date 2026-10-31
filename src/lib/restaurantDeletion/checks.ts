import { Prisma } from "@prisma/client";
import { RESTAURANT_MODEL, tenantModels } from "@/lib/backups/tables";
import { delegate } from "@/lib/backups/snapshot";
import { REPLACEABLE_PENDING_METHODS } from "@/lib/payments/methods";
import { PLATFORM_MODEL_POLICY, PLATFORM_ROLES, UPLOAD_COLUMNS, tenantDeletionWhere } from "./policy";

type Client = Prisma.TransactionClient;
type CountDelegate = { count(args: { where: Record<string, unknown> }): Promise<number> };

function counter(client: Client, delegateName: string): CountDelegate {
  return delegate(client, { delegate: delegateName }) as unknown as CountDelegate;
}

/**
 * Lo que impide borrar: plata o documentos fiscales EN CURSO. Borrar con
 * algo de esto vivo deja un cobro o una factura a mitad de camino sin nadie
 * que la termine (el webhook o el barrido llegarían a un comercio que ya no
 * existe). Hay que resolverlo antes; el diálogo lo explica por código y,
 * cuando existe una transición segura, la ofrece (ver resolution.ts).
 *
 * Los cobros y los links pendientes se separan en dos códigos según haya o
 * no plata en vuelo en un proveedor: la suma es la misma de siempre (no se
 * relaja nada), pero sólo lo que NO está en vuelo se puede anular desde el
 * diálogo.
 */
export type BlockerCode =
  /** Solicitudes del comensal sin dinero en vuelo (efectivo, datáfono propio): se pueden declinar. */
  | "payments_pending"
  /** Pendientes con el proveedor (PSE, tarjeta en línea, Smart POS…): no se tocan. */
  | "payments_in_flight"
  | "refunds_in_flight"
  | "financial_operations_open"
  | "payouts_in_flight"
  /** Links vigentes sin ningún intento de pago: se pueden anular. */
  | "payment_links_pending"
  /** Links vigentes con un PSE iniciado (`providerRef`): el banco todavía puede aprobarlo. */
  | "payment_links_in_flight"
  | "dian_pending"
  | "dian_error"
  | "subscription_active"
  | "cross_tenant_references";
export type DeletionBlocker = { code: BlockerCode; count: number; detail?: string[] };

/** Avisos: no bloquean, pero el admin tiene que saberlo antes de confirmar. */
export type WarningCode =
  | "kushki_onboarding_in_progress"
  | "kushki_active"
  | "dian_rejected"
  | "group_member"
  | "platform_users_detached"
  | "wallet_balance";
export type DeletionWarning = {
  code: WarningCode;
  count?: number;
  text?: string;
  amountCents?: number;
  currency?: string;
};

/** Documentos DIAN reales (no los del set de pruebas de habilitación, que no tienen ni orden ni tirilla). */
const REAL_DIAN_DOCUMENT = {
  OR: [
    { simpleInvoiceId: { not: null } },
    { orderId: { not: null } },
    { creditNote: { is: { abandonedAt: null } } },
  ],
};

/** Estados de la emisión que el barrido o un reintento todavía van a tocar. */
export const DIAN_IN_FLIGHT_STATES = ["to_send", "sent", "pending"] as const;

/**
 * Cobros pendientes que son sólo una SOLICITUD del comensal (ver
 * `REPLACEABLE_PENDING_METHODS`): lo mismo que el staff declina al cobrar por
 * otra vía. Lo comparten el bloqueo y la acción que los anula, para que
 * cuenten exactamente lo mismo.
 */
export function pendingPaymentRequestsWhere(restaurantId: string) {
  return {
    order: { restaurantId },
    status: "pending",
    method: { in: [...REPLACEABLE_PENDING_METHODS] },
  } satisfies Prisma.PaymentWhereInput;
}

/** Links de pago que bloquean el borrado: pendientes y sin vencer. */
function openPaymentLinksWhere(restaurantId: string, now: Date) {
  return {
    restaurantId,
    status: "pending",
    OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
  } satisfies Prisma.PaymentLinkWhereInput;
}

/**
 * Links vigentes sin ningún intento de pago en curso: nadie inició un PSE
 * (`providerRef` vacío), así que anularlos no deja plata a mitad de camino.
 */
export function cancellablePaymentLinksWhere(restaurantId: string, now: Date) {
  return { ...openPaymentLinksWhere(restaurantId, now), providerRef: null } satisfies Prisma.PaymentLinkWhereInput;
}

async function countOpenFinancialOperations(client: Client, restaurantId: string): Promise<number> {
  // FinancialOperation no tiene FK: se llega al comercio por Payment → Order.
  const rows = await client.$queryRaw<{ n: bigint | number }[]>`
    SELECT count(*) AS n FROM "FinancialOperation" f
    JOIN "Payment" p ON p.id = f."paymentId"
    JOIN "Order" o ON o.id = p."orderId"
    WHERE o."restaurantId" = ${restaurantId} AND f.status IN ('pending', 'uncertain')`;
  return Number(rows?.[0]?.n ?? 0);
}

/**
 * Filas de OTRO comercio que apuntan a filas de este (una referencia cruzada
 * entre comercios). No debería existir ninguna —cada comercio es una isla—,
 * pero si existiera, borrar acá cascadearía (o se trabaría) en datos ajenos.
 * Se recorren todas las FKs entre modelos del comercio, derivadas del DMMF.
 */
export async function crossTenantReferences(client: Client, restaurantId: string): Promise<string[]> {
  const models = tenantModels();
  const byName = new Map(models.map((m) => [m.name, m]));
  const found: string[] = [];
  for (const child of models) {
    for (const fk of child.foreignKeys) {
      const parent = byName.get(fk.target);
      if (!parent) continue;
      const n = await counter(client, child.delegate).count({
        where: {
          [fk.relation]: { is: tenantDeletionWhere(parent, restaurantId) },
          NOT: tenantDeletionWhere(child, restaurantId),
        },
      });
      if (n > 0) found.push(`${child.name}.${fk.field}`);
    }
  }
  return found;
}

export async function findBlockers(client: Client, restaurantId: string, now: Date = new Date()): Promise<DeletionBlocker[]> {
  const blockers: DeletionBlocker[] = [];
  const add = (code: BlockerCode, count: number) => {
    if (count > 0) blockers.push({ code, count });
  };
  add("payments_pending", await client.payment.count({ where: pendingPaymentRequestsWhere(restaurantId) }));
  add(
    "payments_in_flight",
    await client.payment.count({
      where: { order: { restaurantId }, status: "pending", method: { notIn: [...REPLACEABLE_PENDING_METHODS] } },
    }),
  );
  add(
    "refunds_in_flight",
    await client.payment.count({ where: { order: { restaurantId }, refundReservedCents: { gt: 0 } } }),
  );
  add("financial_operations_open", await countOpenFinancialOperations(client, restaurantId));
  add("payouts_in_flight", await client.payout.count({ where: { restaurantId, status: "initialized" } }));
  add("payment_links_pending", await client.paymentLink.count({ where: cancellablePaymentLinksWhere(restaurantId, now) }));
  add(
    "payment_links_in_flight",
    await client.paymentLink.count({
      where: { ...openPaymentLinksWhere(restaurantId, now), providerRef: { not: null } },
    }),
  );
  add(
    "dian_pending",
    await client.dianDocument.count({
      where: { restaurantId, state: { in: [...DIAN_IN_FLIGHT_STATES] }, ...REAL_DIAN_DOCUMENT },
    }),
  );
  add(
    "dian_error",
    await client.dianDocument.count({ where: { restaurantId, state: "error", ...REAL_DIAN_DOCUMENT } }),
  );
  const subscription = await client.billingSubscription.findUnique({
    where: { restaurantId },
    select: { status: true },
  });
  if (subscription && subscription.status !== "canceled") {
    blockers.push({ code: "subscription_active", count: 1, detail: [subscription.status] });
  }
  const cross = await crossTenantReferences(client, restaurantId);
  if (cross.length) blockers.push({ code: "cross_tenant_references", count: cross.length, detail: cross });
  return blockers;
}

export async function findWarnings(client: Client, restaurantId: string): Promise<DeletionWarning[]> {
  const warnings: DeletionWarning[] = [];
  const restaurant = await client.restaurant.findUnique({
    where: { id: restaurantId },
    select: { kushkiOnboardingStatus: true, group: { select: { name: true } } },
  });
  if (!restaurant) return warnings;
  if (["docs_uploaded", "submitted", "in_review"].includes(restaurant.kushkiOnboardingStatus)) {
    warnings.push({ code: "kushki_onboarding_in_progress", text: restaurant.kushkiOnboardingStatus });
  }
  if (restaurant.kushkiOnboardingStatus === "active") warnings.push({ code: "kushki_active" });
  if (restaurant.group) warnings.push({ code: "group_member", text: restaurant.group.name });
  const rejected = await client.dianDocument.count({ where: { restaurantId, state: "rejected", ...REAL_DIAN_DOCUMENT } });
  if (rejected > 0) warnings.push({ code: "dian_rejected", count: rejected });
  const platformUsers = await client.user.count({ where: { restaurantId, role: { in: [...PLATFORM_ROLES] } } });
  if (platformUsers > 0) warnings.push({ code: "platform_users_detached", count: platformUsers });
  const lastWallet = await client.walletMovement.findFirst({
    where: { restaurantId },
    orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }],
    select: { balanceAfterCents: true, currency: true },
  });
  if (lastWallet && lastWallet.balanceAfterCents !== 0) {
    warnings.push({ code: "wallet_balance", amountCents: lastWallet.balanceAfterCents, currency: lastWallet.currency });
  }
  return warnings;
}

/** Lo que el diálogo muestra: cuánto se va a borrar, por categoría. */
export type DeletionCounts = {
  orders: number;
  payments: number;
  invoices: number;
  dianInvoices: number;
  creditNotes: number;
  users: number;
  ingredients: number;
  journalEntries: number;
  files: number;
};

const UPLOAD_PREFIX = "/uploads/";

export async function countUploadReferences(client: Client, restaurantId: string): Promise<number> {
  const tenants = new Map(tenantModels().map((m) => [m.name, m]));
  let total = 0;
  for (const column of UPLOAD_COLUMNS) {
    if (column.model === RESTAURANT_MODEL) {
      const row = await client.restaurant.findUnique({ where: { id: restaurantId }, select: { [column.field]: true } });
      const value = (row as Record<string, unknown> | null)?.[column.field];
      if (typeof value === "string" && value.startsWith(UPLOAD_PREFIX)) total++;
      continue;
    }
    const tenant = tenants.get(column.model);
    const scope = tenant ? tenantDeletionWhere(tenant, restaurantId) : { restaurantId };
    total += await counter(client, column.model.charAt(0).toLowerCase() + column.model.slice(1)).count({
      where: { ...scope, [column.field]: { startsWith: UPLOAD_PREFIX } },
    });
  }
  return total;
}

export async function countDeletion(client: Client, restaurantId: string): Promise<DeletionCounts> {
  return {
    orders: await client.order.count({ where: { restaurantId } }),
    payments: await client.payment.count({ where: { order: { restaurantId } } }),
    invoices: await client.simpleInvoice.count({ where: { restaurantId } }),
    dianInvoices: await client.dianDocument.count({ where: { restaurantId, kind: "invoice" } }),
    creditNotes: await client.creditNote.count({ where: { restaurantId } }),
    users: await client.user.count({ where: { restaurantId } }),
    ingredients: await client.ingredient.count({ where: { restaurantId } }),
    journalEntries: await client.journalEntry.count({ where: { restaurantId } }),
    files: await countUploadReferences(client, restaurantId),
  };
}

/**
 * Modelos con `restaurantId` propio cuyas filas el borrado tiene que haber
 * eliminado ANTES del DELETE final del comercio: los del comercio, los de
 * plataforma con política `delete` y los usuarios. Si alguno no quedó en
 * cero, el DELETE del Restaurant los borraría en cascada sin pasar por el
 * archivo final (o traería un User de plataforma): se aborta.
 */
export function modelsThatMustBeEmpty(): string[] {
  const names = new Set(tenantModels().filter((m) => m.ownerPath.length === 0).map((m) => m.name));
  for (const [name, policy] of Object.entries(PLATFORM_MODEL_POLICY)) {
    if (policy.action === "delete" || policy.action === "users") names.add(name);
  }
  return [...names].filter((name) =>
    Prisma.dmmf.datamodel.models
      .find((m) => m.name === name)
      ?.fields.some((f) => f.kind === "scalar" && f.name === "restaurantId"),
  );
}

export async function remainingRows(client: Client, restaurantId: string): Promise<Record<string, number>> {
  const left: Record<string, number> = {};
  for (const name of modelsThatMustBeEmpty()) {
    const n = await counter(client, name.charAt(0).toLowerCase() + name.slice(1)).count({ where: { restaurantId } });
    if (n > 0) left[name] = n;
  }
  return left;
}
