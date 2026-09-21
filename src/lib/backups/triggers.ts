import { Prisma } from "@prisma/client";
import type { Client } from "./snapshot";

/**
 * Triggers DE USUARIO de las tablas que se recargan al restaurar.
 *
 * Los triggers de negocio de la base (`reserve_payment` valida que un cobro
 * no supere el saldo de la cuenta; `order_event` publica un PlatformEvent por
 * cada orden que cambia) están pensados para operaciones INCREMENTALES: una
 * fila nueva contra un estado ya consistente. Recargar un comercio entero
 * desde un snapshot no es eso: el snapshot es consistente por construcción
 * (se leyó de un solo instante), y evaluarlo fila por fila mientras el estado
 * se está reconstruyendo produce rechazos falsos (una cuenta cancelada con su
 * cobro aprobado histórico → `order_closed`) y efectos secundarios que no
 * corresponden (miles de eventos SSE por órdenes que no cambiaron).
 *
 * Por eso, dentro de la transacción de restauración, se DESACTIVAN los
 * triggers de usuario de esas tablas y se reactivan al final. Sólo los de
 * usuario (`tgisinternal = false`): los internos de las FKs siguen activos
 * (tocarlos exige superusuario y además queremos que las FKs se verifiquen).
 * Los CHECK a nivel de fila tampoco se tocan: si uno falla, el snapshot trae
 * una fila inválida y eso SÍ tiene que abortar.
 *
 * `ALTER TABLE … DISABLE TRIGGER` pide ser dueño de la tabla (el rol de la
 * app lo es: corrió las migraciones), no superusuario — a diferencia de
 * `session_replication_role`, que en producción no está disponible. Es DDL
 * transaccional: si la restauración falla y la transacción se revierte, los
 * triggers vuelven solos a su estado; por eso el ENABLE final sólo hace
 * falta en el camino feliz. Ojo: el ALTER toma un lock SHARE ROW EXCLUSIVE
 * sobre la tabla hasta el commit, así que mientras un comercio restaura, las
 * demás escrituras en esas tablas (hoy `Order` y `Payment`) esperan.
 *
 * Se respeta el estado previo de cada trigger: los que ya estaban
 * desactivados no se tocan, y los `ALWAYS` / `REPLICA` vuelven como estaban.
 */
export type UserTrigger = {
  table: string;
  trigger: string;
  /** pg_trigger.tgenabled: O = origin (normal), A = always, R = replica, D = disabled. */
  enabled: "O" | "A" | "R" | "D";
};

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Identificador entre comillas dobles; sólo acepta nombres que vienen de pg_catalog. */
export function quoteIdentifier(name: string): string {
  if (!IDENTIFIER.test(name)) throw new Error(`backup_invalid_identifier:${name}`);
  return `"${name}"`;
}

/** Triggers de usuario de las tablas dadas, en el esquema actual. */
export async function listUserTriggers(tx: Client, tables: readonly string[]): Promise<UserTrigger[]> {
  if (!tables.length) return [];
  const rows = await tx.$queryRaw<UserTrigger[]>`
    SELECT c.relname AS "table", t.tgname AS "trigger", t.tgenabled::text AS "enabled"
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE NOT t.tgisinternal
      AND n.nspname = current_schema()
      AND c.relname IN (${Prisma.join([...tables])})
    ORDER BY c.relname, t.tgname`;
  return rows;
}

export function disableStatement(t: UserTrigger): string {
  return `ALTER TABLE ${quoteIdentifier(t.table)} DISABLE TRIGGER ${quoteIdentifier(t.trigger)}`;
}

/** Vuelve al estado que tenía (`ENABLE` = origin, `ENABLE ALWAYS`, `ENABLE REPLICA`). */
export function enableStatement(t: UserTrigger): string {
  const mode = t.enabled === "A" ? "ENABLE ALWAYS" : t.enabled === "R" ? "ENABLE REPLICA" : "ENABLE";
  return `ALTER TABLE ${quoteIdentifier(t.table)} ${mode} TRIGGER ${quoteIdentifier(t.trigger)}`;
}

/**
 * Desactiva los triggers de usuario activos de `tables` y devuelve la lista
 * para reactivarlos con `enableUserTriggers`. Los ya desactivados se saltan.
 */
export async function disableUserTriggers(tx: Client, tables: readonly string[]): Promise<UserTrigger[]> {
  const active = (await listUserTriggers(tx, tables)).filter((t) => t.enabled !== "D");
  for (const t of active) await tx.$executeRaw(Prisma.sql([disableStatement(t)]));
  return active;
}

export async function enableUserTriggers(tx: Client, triggers: readonly UserTrigger[]): Promise<void> {
  for (const t of triggers) await tx.$executeRaw(Prisma.sql([enableStatement(t)]));
}
