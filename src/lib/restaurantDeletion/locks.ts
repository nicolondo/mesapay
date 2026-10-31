import type { Prisma } from "@prisma/client";
import { tenantModels, topologicalOrder, type TenantModel } from "@/lib/backups/tables";

type Client = Prisma.TransactionClient;

/**
 * Congelar los datos del comercio durante el borrado, sin REPEATABLE READ.
 *
 * Con REPEATABLE READ el archivo y el borrado saldrían del mismo instante,
 * pero cualquier fila que otro proceso actualice en el medio —el latido de
 * un agente de impresión prendido, cada pocos segundos— aborta la
 * transacción por serialización: un comercio con un PC encendido no se
 * podría borrar nunca. En READ COMMITTED se logra lo mismo con locks:
 *
 *   1. FOR UPDATE sobre la fila del Restaurant: todo INSERT con FK directa al
 *      comercio toma FOR KEY SHARE sobre ella y queda esperando.
 *   2. FOR UPDATE sobre cada fila del comercio que es PADRE de otra (cuentas,
 *      rondas, cobros, asientos, insumos…): un hijo nuevo (un cobro sobre una
 *      cuenta existente) también toma FOR KEY SHARE sobre su padre y espera.
 *
 * Desde ahí no puede aparecer ninguna fila nueva del comercio hasta el commit
 * (y al commit, su padre ya no existe: el INSERT falla). Lo que se lee para el
 * archivo es exactamente lo que se borra; a lo sumo una hoja (el latido)
 * cambia una columna en el medio. Los que esperan un lock lo consiguen al
 * terminar y encuentran la fila borrada.
 *
 * Los identificadores salen del DMMF (sin @@map en el esquema: modelo =
 * tabla, campo = columna) y se validan; el comercio va como parámetro $1.
 */
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]*$/;

function ident(name: string): string {
  if (!IDENTIFIER.test(name)) throw new Error(`restaurant_delete_bad_identifier:${name}`);
  return `"${name}"`;
}

/** Modelos del comercio que son destino de una FK de otro modelo del comercio. */
export function parentModels(): TenantModel[] {
  const models = tenantModels();
  const names = new Set(models.map((m) => m.name));
  const parents = new Set<string>();
  for (const m of models) for (const fk of m.foreignKeys) if (names.has(fk.target)) parents.add(fk.target);
  const byName = new Map(models.map((m) => [m.name, m]));
  // Padres antes que hijos: el mismo orden en que los toma cualquier otro
  // proceso que inserte (primero valida el padre), para no cruzarse.
  return topologicalOrder()
    .insert.filter((n) => parents.has(n))
    .map((n) => byName.get(n)!);
}

/**
 * `SELECT count(*) FROM (SELECT 1 FROM "M" t0 [JOIN …] WHERE tN."restaurantId" = $1 FOR UPDATE OF t0) s`
 * — el lock se toma en la subconsulta; afuera sólo se cuenta, para no traer
 * miles de filas a Node.
 */
export function lockStatement(model: TenantModel): string {
  const byName = new Map(tenantModels().map((m) => [m.name, m]));
  const joins: string[] = [];
  let current = model;
  for (let i = 0; i < model.ownerPath.length; i++) {
    const relation = model.ownerPath[i];
    const fk = current.foreignKeys.find((k) => k.relation === relation);
    if (!fk) throw new Error(`restaurant_delete_owner_path:${model.name}.${relation}`);
    const next = byName.get(fk.target);
    if (!next) throw new Error(`restaurant_delete_owner_path:${fk.target}`);
    joins.push(
      `JOIN ${ident(next.name)} t${i + 1} ON t${i + 1}.${ident(fk.targetField)} = t${i}.${ident(fk.field)}`,
    );
    current = next;
  }
  const owner = `t${model.ownerPath.length}`;
  return (
    `SELECT count(*) AS n FROM (SELECT 1 FROM ${ident(model.name)} t0 ${joins.join(" ")} ` +
    `WHERE ${owner}."restaurantId" = $1 FOR UPDATE OF t0) s`
  ).replace(/\s+/g, " ");
}

/** Toma los locks de las filas padre del comercio (ver arriba). Devuelve filas bloqueadas por modelo. */
export async function lockParentRows(client: Client, restaurantId: string): Promise<Record<string, number>> {
  const locked: Record<string, number> = {};
  for (const model of parentModels()) {
    const rows = await client.$queryRawUnsafe<{ n: bigint | number }[]>(lockStatement(model), restaurantId);
    locked[model.name] = Number(rows?.[0]?.n ?? 0);
  }
  return locked;
}
