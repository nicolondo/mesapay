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
  const count = await db.ledgerAccount.count({ where: { restaurantId } });
  if (count > 0) return;
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
