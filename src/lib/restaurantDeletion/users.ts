import { Prisma, type Role } from "@prisma/client";
import { tenantModel } from "@/lib/backups/tables";
import { delegate } from "@/lib/backups/snapshot";
import { PLATFORM_MODEL_POLICY, STAFF_ROLES, USER_OWNED_MODELS, tenantDeletionWhere } from "./policy";

type Client = Prisma.TransactionClient;
type FindDelegate = {
  findMany(args: {
    where: Record<string, unknown>;
    select: Record<string, boolean>;
    distinct?: string[];
  }): Promise<Record<string, unknown>[]>;
};

export type UserRow = { id: string; role: Role };

export type UserPlan = {
  /** Personal del comercio sin referencias afuera: se borra. */
  deleteIds: string[];
  /** Roles de plataforma (o desconocidos): sólo restaurantId → null. NUNCA se borran. */
  detachIds: string[];
  /**
   * Personal con filas de OTRO comercio o de la plataforma que lo
   * referencian (p. ej. abrió un turno en otro local): borrarlo tocaría datos
   * ajenos (o lo frenaría un RESTRICT). Se desvincula y se desactiva.
   */
  disableIds: string[];
};

/**
 * Qué pasa con cada usuario que tiene `restaurantId` = el comercio. Pura,
 * para poder testear la regla de oro sin base: un rol que no sea de personal
 * del comercio (platform_admin, group_admin, comerciales, o un rol nuevo que
 * nadie clasificó) NUNCA termina en `deleteIds`.
 */
export function planUsers(users: readonly UserRow[], withForeignReferences: ReadonlySet<string>): UserPlan {
  const plan: UserPlan = { deleteIds: [], detachIds: [], disableIds: [] };
  for (const user of users) {
    if (!STAFF_ROLES.includes(user.role)) plan.detachIds.push(user.id);
    else if (withForeignReferences.has(user.id)) plan.disableIds.push(user.id);
    else plan.deleteIds.push(user.id);
  }
  return plan;
}

const IN_CHUNK = 1000;

/**
 * Usuarios de `userIds` que alguna fila que NO se borra con el comercio
 * referencia. Recorre todas las FKs hacia User del DMMF (así una tabla nueva
 * entra sola): para los modelos del comercio y los de plataforma que se
 * borran, cuenta sólo las filas de OTROS comercios; para los que se
 * conservan (CRM, comisiones…), cualquier fila. Las tablas que se van con el
 * usuario (sus tokens, sus suscripciones push) no cuentan.
 *
 * Devuelve usuario → ["Shift.openedById", …] para el reporte.
 */
export async function usersWithForeignReferences(
  client: Client,
  restaurantId: string,
  userIds: readonly string[],
): Promise<Map<string, string[]>> {
  const found = new Map<string, string[]>();
  if (!userIds.length) return found;
  for (const model of Prisma.dmmf.datamodel.models) {
    if (USER_OWNED_MODELS.has(model.name)) continue;
    for (const field of model.fields) {
      if (field.kind !== "object" || field.isList || field.type !== "User") continue;
      const scalar = field.relationFromFields?.[0];
      if (!scalar || (field.relationFromFields?.length ?? 0) !== 1) continue;

      const owned = ownedRowsWhere(model.name, restaurantId);
      const d = delegate(client, { delegate: model.name.charAt(0).toLowerCase() + model.name.slice(1) }) as unknown as FindDelegate;
      for (let i = 0; i < userIds.length; i += IN_CHUNK) {
        const chunk = userIds.slice(i, i + IN_CHUNK);
        const where: Record<string, unknown> = { [scalar]: { in: chunk } };
        // User.managerId: un usuario del mismo lote no es "ajeno".
        if (model.name === "User") where.id = { notIn: [...userIds] };
        else if (owned) where.NOT = owned;
        const rows = await d.findMany({ where, select: { [scalar]: true }, distinct: [scalar] });
        for (const row of rows) {
          const id = row[scalar];
          if (typeof id !== "string") continue;
          found.set(id, [...(found.get(id) ?? []), `${model.name}.${scalar}`]);
        }
      }
    }
  }
  return found;
}

/** Filas de un modelo que este borrado elimina (null = no elimina ninguna: se conservan). */
function ownedRowsWhere(modelName: string, restaurantId: string): Record<string, unknown> | null {
  const tenant = tenantModel(modelName);
  if (tenant) return tenantDeletionWhere(tenant, restaurantId);
  const policy = PLATFORM_MODEL_POLICY[modelName];
  if (policy?.action === "delete") {
    const hasRestaurantId = Prisma.dmmf.datamodel.models
      .find((m) => m.name === modelName)
      ?.fields.some((f) => f.kind === "scalar" && f.name === "restaurantId");
    return hasRestaurantId ? { restaurantId } : null;
  }
  return null;
}
