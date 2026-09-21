import { Prisma } from "@prisma/client";

/**
 * Qué tablas forman "los datos de un comercio" para la copia de seguridad.
 *
 * La lista NO se escribe a mano: sale del DMMF de Prisma (el esquema en
 * memoria), así que un modelo nuevo con `restaurantId` entra solo, y un
 * hijo nuevo colgado de uno de esos (p. ej. una línea de un documento)
 * también, mientras llegue por una relación OBLIGATORIA. Lo único manual
 * es la lista de exclusiones de abajo — y cada una lleva su porqué.
 *
 * Reglas:
 *   (a) entra todo modelo con un campo escalar `restaurantId`;
 *   (b) entra todo modelo sin `restaurantId` que tenga una relación
 *       obligatoria (to-one, FK en el propio modelo) hacia un modelo que
 *       ya está en el conjunto — iterando hasta el punto fijo
 *       (OrderItem → Order, JournalLine → JournalEntry,
 *       SupplierPriceHistory → SupplierIngredient → Supplier, …);
 *   (c) se descartan los de EXCLUDED_MODELS y, por transitividad, sus hijos.
 *
 * La fila `Restaurant` en sí no está en esta lista: se respalda aparte y
 * al restaurar se ACTUALIZA (nunca se borra). Ver restore.ts.
 */
export const EXCLUDED_MODELS: ReadonlySet<string> = new Set([
  // No se respalda a sí mismo: un snapshot que contuviera los demás
  // snapshots crecería en cadena.
  "RestaurantBackup",
  // Log de eventos SSE: regenerable, id BigInt autoincrement y enorme
  // (una fila por cambio de estado de cada cuenta).
  "PlatformEvent",
  // Sesiones y tokens: credenciales vivas, no datos del negocio. Revivir un
  // token vencido/revocado desde una copia vieja sería un agujero.
  "DinerSession",
  "DinerMagicLink",
  "PasswordResetToken",
  "PushSubscription",
  // Acceso: las cuentas del personal (roles, contraseñas) las administra la
  // plataforma. Restaurarlas podría borrar al usuario que está restaurando
  // o revivir una contraseña vieja. Las referencias a usuarios que ya no
  // existen se sanean al restaurar (ver restore.ts).
  "User",
  // Plataforma, no comercio: cobros de la membresía, suscripción, comisiones
  // del comercial y CRM de ventas. Restaurar un comercio no puede reescribir
  // lo que la plataforma le cobró ni el pipeline comercial.
  "MembershipPayment",
  "BillingSubscription",
  "CommissionEntry",
  "CrmLead",
  // Bitácora de auditoría: append-only por definición. Restaurarla borraría
  // el rastro de lo que pasó después de la copia (incluida la restauración).
  "AuditEvent",
  // Alta de pagos con Kushki: los documentos viven en disco/SFTP y su estado
  // pertenece al onboarding (plataforma), igual que las llaves del
  // Restaurant que tampoco se restauran. Los eventos de webhook son un
  // registro de idempotencia: volver a un estado viejo permitiría aplicar
  // dos veces un webhook ya procesado.
  "KushkiDocument",
  "KushkiWebhookEvent",
  // Credenciales DIAN (certificado, PIN del software): mismo criterio que
  // las llaves Kushki. Un certificado renovado no puede volver atrás.
  "DianConfig",
]);

export type DmmfModel = (typeof Prisma.dmmf.datamodel.models)[number];
export type DmmfField = DmmfModel["fields"][number];

export type ForeignKey = {
  /** Campo escalar con la FK (p. ej. "orderId"). */
  field: string;
  /** Campo objeto de la relación (p. ej. "order"). */
  relation: string;
  /** Modelo destino (p. ej. "Order"). */
  target: string;
  /** Campo referenciado en el destino (siempre "id" hoy). */
  targetField: string;
  required: boolean;
};

export type TenantModel = {
  name: string;
  /** Nombre del delegate en el cliente (`db.orderItem`). */
  delegate: string;
  /** Campo @id, para paginar de forma estable. */
  idField: string;
  /**
   * Cómo llegar desde este modelo al `restaurantId`: `[]` si lo tiene
   * directo; si no, la cadena de relaciones hasta uno que sí
   * (`["supplierItem", "supplier"]` para SupplierPriceHistory).
   */
  ownerPath: string[];
  /** Campos escalares/enum del modelo (sin relaciones). */
  fields: DmmfField[];
  /** FKs definidas en este modelo. */
  foreignKeys: ForeignKey[];
};

export const RESTAURANT_MODEL = "Restaurant";

export function delegateName(model: string): string {
  return model.charAt(0).toLowerCase() + model.slice(1);
}

function dmmfModels(): DmmfModel[] {
  return Prisma.dmmf.datamodel.models as DmmfModel[];
}

function foreignKeysOf(model: DmmfModel): ForeignKey[] {
  const keys: ForeignKey[] = [];
  for (const f of model.fields) {
    if (f.kind !== "object" || f.isList) continue;
    const from = f.relationFromFields ?? [];
    const to = f.relationToFields ?? [];
    if (from.length !== 1 || to.length !== 1) continue; // FK compuesta: no hay ninguna hoy
    const scalar = model.fields.find((s) => s.name === from[0]);
    keys.push({
      field: from[0],
      relation: f.name,
      target: f.type,
      targetField: to[0],
      required: scalar?.isRequired ?? f.isRequired,
    });
  }
  return keys;
}

let cache: TenantModel[] | null = null;

/** Modelos que se respaldan, en el orden del esquema (sin `Restaurant`). */
export function tenantModels(): TenantModel[] {
  if (cache) return cache;
  const all = dmmfModels();
  const owner = new Map<string, string[]>(); // modelo → ownerPath

  for (const m of all) {
    if (EXCLUDED_MODELS.has(m.name) || m.name === RESTAURANT_MODEL) continue;
    if (m.fields.some((f) => f.kind === "scalar" && f.name === "restaurantId")) {
      owner.set(m.name, []);
    }
  }
  // Punto fijo: hijos alcanzables por relación obligatoria hacia el conjunto.
  let changed = true;
  while (changed) {
    changed = false;
    for (const m of all) {
      if (owner.has(m.name) || EXCLUDED_MODELS.has(m.name) || m.name === RESTAURANT_MODEL) continue;
      const parent = m.fields.find(
        (f) =>
          f.kind === "object" &&
          !f.isList &&
          f.isRequired &&
          (f.relationFromFields?.length ?? 0) > 0 &&
          owner.has(f.type),
      );
      if (!parent) continue;
      owner.set(m.name, [parent.name, ...owner.get(parent.type)!]);
      changed = true;
    }
  }

  cache = all
    .filter((m) => owner.has(m.name))
    .map((m) => {
      const id = m.fields.find((f) => f.isId);
      if (!id) throw new Error(`backup_model_without_id:${m.name}`);
      return {
        name: m.name,
        delegate: delegateName(m.name),
        idField: id.name,
        ownerPath: owner.get(m.name)!,
        fields: m.fields.filter((f) => f.kind !== "object"),
        foreignKeys: foreignKeysOf(m),
      };
    });
  return cache;
}

export function tenantModel(name: string): TenantModel | undefined {
  return tenantModels().find((m) => m.name === name);
}

export function backupModelNames(): string[] {
  return tenantModels().map((m) => m.name);
}

/** Campos escalares/enum de `Restaurant` (para respaldar y actualizar la fila). */
export function restaurantFields(): DmmfField[] {
  const m = dmmfModels().find((x) => x.name === RESTAURANT_MODEL);
  if (!m) throw new Error("backup_restaurant_model_missing");
  return m.fields.filter((f) => f.kind !== "object");
}

/**
 * `where` que selecciona las filas de un comercio para este modelo:
 * `{ restaurantId }` o, para los hijos, la relación anidada
 * (`{ order: { restaurantId } }`). Sirve igual para findMany y deleteMany.
 */
export function ownerWhere(model: TenantModel, restaurantId: string): Record<string, unknown> {
  let where: Record<string, unknown> = { restaurantId };
  for (let i = model.ownerPath.length - 1; i >= 0; i--) {
    where = { [model.ownerPath[i]]: where };
  }
  return where;
}

/**
 * Orden padres→hijos según las FKs entre los modelos respaldados (para
 * insertar) y su inverso (para borrar). Las FKs hacia modelos fuera del
 * conjunto (Restaurant, User, …) no cuentan: esas filas no se tocan.
 * Falla cerrado si apareciera un ciclo — no hay ninguno hoy.
 */
export function topologicalOrder(): { insert: string[]; delete: string[] } {
  const models = tenantModels();
  const inSet = new Set(models.map((m) => m.name));
  const indegree = new Map<string, number>(models.map((m) => [m.name, 0]));
  const children = new Map<string, string[]>(models.map((m) => [m.name, []]));
  const seen = new Set<string>();
  for (const m of models) {
    for (const fk of m.foreignKeys) {
      if (!inSet.has(fk.target) || fk.target === m.name) continue;
      const edge = `${fk.target}->${m.name}`;
      if (seen.has(edge)) continue;
      seen.add(edge);
      children.get(fk.target)!.push(m.name);
      indegree.set(m.name, indegree.get(m.name)! + 1);
    }
  }
  // Kahn con cola estable (orden del esquema entre iguales).
  const queue = models.map((m) => m.name).filter((n) => indegree.get(n) === 0);
  const insert: string[] = [];
  while (queue.length) {
    const n = queue.shift()!;
    insert.push(n);
    for (const c of children.get(n)!) {
      const d = indegree.get(c)! - 1;
      indegree.set(c, d);
      if (d === 0) queue.push(c);
    }
  }
  if (insert.length !== models.length) {
    const stuck = models.map((m) => m.name).filter((n) => !insert.includes(n));
    throw new Error(`backup_relation_cycle:${stuck.join(",")}`);
  }
  return { insert, delete: [...insert].reverse() };
}
