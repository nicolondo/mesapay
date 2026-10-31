import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { parseChartCsv } from "@/lib/erp/chartImport";
import { ensureChartOfAccounts, loadChartOfAccounts } from "@/lib/erp/ledger";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["accounting"];

/**
 * Plan de cuentas del comercio (PUC NIIF Grupo 2). Lo siembra perezosamente
 * la primera vez. Sólo las activas, salvo `?all=1` (la pantalla del plan
 * las muestra marcadas para poder reactivarlas).
 */
async function GETHandler(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const includeInactive = new URL(req.url).searchParams.get("all") === "1";
  const accounts = await loadChartOfAccounts(ctx.restaurantId, { includeInactive });
  return NextResponse.json({ accounts });
}

const importSchema = z.object({ csv: z.string().min(3).max(500_000) });

/**
 * Importa el plan de cuentas propio del contador (CSV pegado). Es ADITIVO:
 * crea las cuentas que faltan y actualiza nombre/naturaleza de las que ya
 * están, pero NUNCA borra ni desactiva — y tampoco REACTIVA: una cuenta que
 * el comercio desactivó sigue inactiva aunque venga en el archivo (antes el
 * import la reactivaba en silencio). Se reactiva desde el plan de cuentas.
 *
 * La naturaleza de una cuenta que ya tiene movimientos no se cambia: daría
 * vuelta el signo de su saldo en los reportes. Se cuenta en `natureKept`.
 *
 * Tampoco baja `postable` de una cuenta existente: el motor de asientos
 * escribe contra códigos base fijos (posting.ts) y los estados financieros
 * sólo suman las cuentas imputables (reports.ts) — cerrar una cuenta base
 * dejaría movimientos fuera del P&G. Abrirla (false→true) sí se permite.
 */
async function POSTHandler(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const restaurantId = ctx.restaurantId;
  const body = await req.json().catch(() => null);
  const parsed = importSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }

  const { rows, issues } = parseChartCsv(parsed.data.csv);
  if (rows.length === 0) {
    return NextResponse.json({ error: "empty", issues }, { status: 400 });
  }

  // El catálogo base debe existir antes de mezclar: define los códigos que
  // el motor de asientos necesita.
  await ensureChartOfAccounts(restaurantId);
  const existing = await db.ledgerAccount.findMany({
    where: { restaurantId },
    select: { code: true, name: true, nature: true, postable: true, active: true },
  });
  const byCode = new Map(existing.map((a) => [a.code, a]));
  // Cuentas existentes cuya naturaleza cambiaría y que ya tienen movimientos.
  const natureChanges = rows
    .filter((r) => !r.synthesized)
    .filter((r) => {
      const cur = byCode.get(r.code);
      return cur != null && cur.nature !== r.nature;
    })
    .map((r) => r.code);
  const withMovements = new Set(
    natureChanges.length
      ? (
          await db.journalLine.groupBy({
            by: ["accountCode"],
            where: { accountCode: { in: natureChanges }, entry: { restaurantId } },
          })
        ).map((g) => g.accountCode)
      : [],
  );

  const toCreate = rows.filter((r) => !byCode.has(r.code));
  if (toCreate.length > 0) {
    await db.ledgerAccount.createMany({
      data: toCreate.map((r) => ({
        restaurantId,
        code: r.code,
        name: r.name,
        type: r.type,
        nature: r.nature,
        level: r.level,
        parentCode: r.parentCode,
        postable: r.postable,
      })),
      skipDuplicates: true,
    });
  }

  // Las agrupadoras generadas no renombran nada: su nombre es una suposición
  // tomada de la hija, y la del catálogo base es mejor.
  let updated = 0;
  let natureKept = 0;
  let inactiveKept = 0;
  for (const r of rows) {
    if (r.synthesized) continue;
    const cur = byCode.get(r.code);
    if (!cur) continue;
    if (!cur.active) inactiveKept++;
    const postable = cur.postable || r.postable;
    const lockNature = cur.nature !== r.nature && withMovements.has(r.code);
    if (lockNature) natureKept++;
    const nature = lockNature ? cur.nature : r.nature;
    if (cur.name === r.name && cur.nature === nature && cur.postable === postable) {
      continue;
    }
    // Sin `active`: el import no reactiva lo que el comercio desactivó.
    await db.ledgerAccount.update({
      where: { restaurantId_code: { restaurantId, code: r.code } },
      data: { name: r.name, nature, postable },
    });
    updated++;
  }

  const parentsCreated = toCreate.filter((r) => r.synthesized).length;
  return NextResponse.json({
    ok: true,
    created: toCreate.length - parentsCreated,
    parentsCreated,
    updated,
    natureKept,
    inactiveKept,
    issues,
  });
}

export const GET = secureApi(GETHandler);

export const POST = secureApi(POSTHandler);
