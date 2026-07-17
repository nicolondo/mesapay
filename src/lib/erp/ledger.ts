import { db } from "@/lib/db";
import { PUC_NIIF_G2, pucLevel, pucParentCode } from "./pucNiif";

/**
 * Siembra el plan de cuentas base (PUC NIIF Grupo 2) para un comercio la
 * primera vez. Idempotente: si ya tiene cuentas, no hace nada. Se llama
 * perezosamente al abrir la vista de contabilidad (sin migración de datos).
 */
export async function ensureChartOfAccounts(
  restaurantId: string,
): Promise<void> {
  // Idempotente: siembra la primera vez Y agrega cuentas nuevas del catálogo a
  // comercios ya sembrados (el unique code evita duplicados). Cuando el
  // comercio ya tiene todas las cuentas del catálogo, es sólo un count.
  const count = await db.ledgerAccount.count({ where: { restaurantId } });
  if (count >= PUC_NIIF_G2.length) return;
  await db.ledgerAccount.createMany({
    data: PUC_NIIF_G2.map((a) => ({
      restaurantId,
      code: a.code,
      name: a.name,
      type: a.type,
      nature: a.nature,
      level: pucLevel(a.code),
      parentCode: pucParentCode(a.code),
      postable: a.postable ?? false,
    })),
    skipDuplicates: true,
  });
}

/** Mapa código→id de las cuentas del comercio (para armar asientos). */
export async function loadAccountMap(
  restaurantId: string,
): Promise<Map<string, string>> {
  await ensureChartOfAccounts(restaurantId);
  const rows = await db.ledgerAccount.findMany({
    where: { restaurantId },
    select: { id: true, code: true },
  });
  return new Map(rows.map((r) => [r.code, r.id]));
}

export type ChartAccount = {
  code: string;
  name: string;
  type: string;
  nature: string;
  level: number;
  parentCode: string | null;
  postable: boolean;
};

/** Plan de cuentas del comercio (ordenado por código), sembrando si hace falta. */
export async function loadChartOfAccounts(
  restaurantId: string,
): Promise<ChartAccount[]> {
  await ensureChartOfAccounts(restaurantId);
  return db.ledgerAccount.findMany({
    where: { restaurantId, active: true },
    orderBy: { code: "asc" },
    select: {
      code: true,
      name: true,
      type: true,
      nature: true,
      level: true,
      parentCode: true,
      postable: true,
    },
  });
}
