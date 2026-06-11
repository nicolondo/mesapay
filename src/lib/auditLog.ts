// Audit log helper — los endpoints que mutan estado sensible lo
// invocan al final de la acción. Lee la sesión actual para
// denormalizar actor y arma una línea human-readable que va a la
// columna `summary` (lo que se renderea en /admin/audit).
//
// Diseño:
//   - Nunca rompe la operación principal. Si grabar audit falla, se
//     loggea y se sigue.
//   - El `kind` es un slug estable — ver AUDIT_KIND_LABEL más abajo
//     para los actuales. Cuando agregues una acción nueva, añade el
//     kind y su label aquí.
//   - `diff` es opcional. Para acciones simples (toggle, set valor
//     único) basta con `summary`. Para cambios de varios campos
//     (ej: identidad del comercio) conviene guardar before/after.

import { db } from "./db";
import { auth } from "@/auth";

export type AuditKind =
  // Plan + facturación del comercio
  | "membership.plan.update"
  | "membership.payment.record"
  | "membership.suspend"
  | "membership.unsuspend"
  | "membership.service_mode.update"
  | "membership.pickup.toggle"
  | "membership.pickup.hours.update"
  // Catálogo de planes (plataforma)
  | "plan_catalog.update"
  // Configuración global de la plataforma
  | "platform.kushki_mode.update"
  // Identidad / config del comercio (operador o admin override)
  | "restaurant.name.update"
  | "restaurant.identity.update"
  | "restaurant.payment_methods.update"
  | "restaurant.staff_policies.update"
  // Usuarios del comercio
  | "user.create"
  | "user.update"
  | "user.delete"
  // Orden + items (cancel / comp / walkout)
  | "order.cancel"
  | "order_item.cancel"
  | "order_item.comp"
  // Grupos
  | "restaurant.create"
  | "restaurant.group.update"
  | "group.legal_entity.create"
  | "group.legal_entity.update"
  | "group.legal_entity.delete"
  // CRM
  | "crm.lead.convert"
  | "crm.lead.reassign"
  | "crm.export"
  // Catch-all para events nuevos no listados (no rompe el type pero
  // empuja a registrar el kind correcto). Usar con moderación.
  | (string & {});

const AUDIT_KIND_LABEL: Record<string, string> = {
  "membership.plan.update": "Cambió plan",
  "membership.payment.record": "Registró pago",
  "membership.suspend": "Suspendió comercio",
  "membership.unsuspend": "Reactivó comercio",
  "membership.service_mode.update": "Cambió modo de servicio",
  "membership.pickup.toggle": "Cambió pedido anticipado",
  "membership.pickup.hours.update": "Cambió horario de pickup",
  "plan_catalog.update": "Editó plan",
  "platform.kushki_mode.update": "Cambió modo Kushki",
  "restaurant.name.update": "Cambió nombre del comercio",
  "restaurant.identity.update": "Editó identidad",
  "restaurant.payment_methods.update": "Editó medios de pago",
  "restaurant.staff_policies.update": "Editó políticas de staff",
  "restaurant.reservations.update": "Editó configuración de reservas",
  "user.create": "Creó usuario",
  "user.update": "Editó usuario",
  "user.delete": "Borró usuario",
  "order.cancel": "Canceló orden",
  "order_item.cancel": "Canceló plato",
  "order_item.comp": "No cobró plato",
  "restaurant.create": "Creó restaurante",
  "restaurant.group.update": "Cambió grupo del comercio",
  "group.legal_entity.create": "Creó razón social",
  "group.legal_entity.update": "Editó razón social",
  "group.legal_entity.delete": "Borró razón social",
  "crm.lead.convert": "Convirtió lead en restaurante",
  "crm.lead.reassign": "Reasignó lead",
  "crm.export": "Exportó leads CRM",
};

export function labelForKind(kind: string): string {
  return AUDIT_KIND_LABEL[kind] ?? kind;
}

export type AuditDiff = {
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
};

export type AuditTarget = {
  type: string; // "restaurant" | "plan" | "user" | "membership_payment" ...
  id?: string;
};

export type RecordAuditArgs = {
  kind: AuditKind;
  // Comercio afectado. Null/undefined para acciones a nivel
  // plataforma (ej: editar catálogo de planes).
  restaurantId?: string | null;
  target?: AuditTarget;
  // Texto human-readable. Si no se pasa, se usa el label del kind.
  summary?: string;
  diff?: AuditDiff;
  // Override del actor — útil cuando la acción es disparada por un
  // cron del sistema y no hay sesión. La mayoría de los callers no
  // lo pasan y el helper lee la sesión.
  actor?: {
    userId?: string | null;
    email: string;
    role: string;
  };
};

/**
 * Graba un evento de audit. Best-effort — si falla, loggea y
 * devuelve sin romper la operación que lo llamó.
 *
 * Se llama DESPUÉS de que la mutación principal commitó, no antes,
 * para que si la mutación falla no quede un evento huérfano.
 */
export async function recordAuditEvent(args: RecordAuditArgs): Promise<void> {
  try {
    let actorUserId: string | null = args.actor?.userId ?? null;
    let actorEmail: string = args.actor?.email ?? "";
    let actorRole: string = args.actor?.role ?? "system";

    if (!args.actor) {
      const session = await auth();
      if (session?.user) {
        actorUserId = session.user.id ?? null;
        actorEmail = session.user.email ?? "";
        actorRole = session.user.role ?? "unknown";
      } else {
        // Sin sesión y sin override — marcamos como system. Esto
        // sólo debería pasar en crons.
        actorEmail = "system";
        actorRole = "system";
      }
    }

    const summary = args.summary ?? labelForKind(args.kind);
    await db.auditEvent.create({
      data: {
        actorUserId,
        actorEmail,
        actorRole,
        restaurantId: args.restaurantId ?? null,
        kind: args.kind,
        targetType: args.target?.type ?? null,
        targetId: args.target?.id ?? null,
        summary,
        diff: args.diff
          ? (args.diff as unknown as object)
          : undefined,
      },
    });
  } catch (err) {
    // Audit no debe romper el flujo principal.
    console.error("[auditLog] failed to record event", args.kind, err);
  }
}

/**
 * Helper para listar eventos con filtros — consumido por la página
 * /admin/audit y por la sub-sección "actividad reciente" del
 * detalle de un restaurante.
 */
export async function listAuditEvents(opts: {
  restaurantId?: string;
  kind?: string;
  actorEmail?: string;
  since?: Date;
  until?: Date;
  limit?: number;
}) {
  return db.auditEvent.findMany({
    where: {
      ...(opts.restaurantId !== undefined && {
        restaurantId: opts.restaurantId,
      }),
      ...(opts.kind && { kind: opts.kind }),
      ...(opts.actorEmail && { actorEmail: opts.actorEmail }),
      ...(opts.since || opts.until
        ? {
            occurredAt: {
              ...(opts.since && { gte: opts.since }),
              ...(opts.until && { lte: opts.until }),
            },
          }
        : {}),
    },
    orderBy: { occurredAt: "desc" },
    take: Math.min(opts.limit ?? 100, 500),
    include: {
      restaurant: {
        select: { id: true, name: true, slug: true },
      },
    },
  });
}
