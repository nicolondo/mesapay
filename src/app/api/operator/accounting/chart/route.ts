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
 * la primera vez.
 */
export async function GET() {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const accounts = await loadChartOfAccounts(ctx.restaurantId);
  return NextResponse.json({ accounts });
}

const importSchema = z.object({ csv: z.string().min(3).max(500_000) });

/**
 * Importa el plan de cuentas propio del contador (CSV pegado). Es ADITIVO:
 * crea las cuentas que faltan y actualiza nombre/naturaleza de las que ya
 * están, pero NUNCA borra ni desactiva.
 *
 * Tampoco baja `postable` de una cuenta existente: el motor de asientos
 * escribe contra códigos base fijos (posting.ts) y los estados financieros
 * sólo suman las cuentas imputables (reports.ts) — cerrar una cuenta base
 * dejaría movimientos fuera del P&G. Abrirla (false→true) sí se permite.
 */
export async function POST(req: Request) {
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
    select: { code: true, name: true, nature: true, postable: true },
  });
  const byCode = new Map(existing.map((a) => [a.code, a]));

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
  for (const r of rows) {
    if (r.synthesized) continue;
    const cur = byCode.get(r.code);
    if (!cur) continue;
    const postable = cur.postable || r.postable;
    if (
      cur.name === r.name &&
      cur.nature === r.nature &&
      cur.postable === postable
    ) {
      continue;
    }
    await db.ledgerAccount.update({
      where: { restaurantId_code: { restaurantId, code: r.code } },
      data: { name: r.name, nature: r.nature, postable, active: true },
    });
    updated++;
  }

  const parentsCreated = toCreate.filter((r) => r.synthesized).length;
  return NextResponse.json({
    ok: true,
    created: toCreate.length - parentsCreated,
    parentsCreated,
    updated,
    issues,
  });
}
