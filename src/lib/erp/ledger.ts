import { db } from "@/lib/db";
import {
  DEMOTED_TO_PARENT,
  PUC_NIIF_G2,
  pucLevel,
  pucParentCode,
} from "./pucNiif";

/**
 * Siembra el plan de cuentas base (PUC NIIF Grupo 2) para un comercio la
 * primera vez e incorpora las cuentas NUEVAS del catálogo a comercios ya
 * sembrados. Idempotente y perezosa (se llama al abrir contabilidad).
 *
 * Diff por CÓDIGOS (no por count): un comercio con cuentas propias del
 * contador puede superar el tamaño del catálogo y aun así faltarle cuentas
 * nuevas. También degrada a agrupadora las subcuentas que el catálogo abrió
 * por tarifa (DEMOTED_TO_PARENT) — sus movimientos históricos siguen válidos.
 */
export async function ensureChartOfAccounts(
  restaurantId: string,
): Promise<void> {
  const existing = await db.ledgerAccount.findMany({
    where: { restaurantId },
    select: { code: true, postable: true },
  });
  const byCode = new Map(existing.map((r) => [r.code, r]));

  const missing = PUC_NIIF_G2.filter((a) => !byCode.has(a.code));
  if (missing.length > 0) {
    await db.ledgerAccount.createMany({
      data: missing.map((a) => ({
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

  const demote = DEMOTED_TO_PARENT.filter(
    (code) => byCode.get(code)?.postable === true,
  );
  if (demote.length > 0) {
    await db.ledgerAccount.updateMany({
      where: { restaurantId, code: { in: demote } },
      data: { postable: false },
    });
  }
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
