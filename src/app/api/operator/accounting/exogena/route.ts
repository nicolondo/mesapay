import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import {
  buildFormato1001Txt,
  computeNitDv,
  type Formato1001Issue,
  type Formato1001Row,
} from "@/lib/erp/exogena";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["accounting"];

/**
 * Información exógena — formato 1001 (pagos a terceros) del año: agrega por
 * proveedor las COMPRAS recibidas (neto + IVA de las líneas, retefuente del
 * encabezado) y los GASTOS manuales con proveedor. `?format=txt` descarga el
 * TXT; sin formato devuelve el resumen JSON con los issues (NIT faltante o
 * inválido) para corregir antes de descargar.
 */
export async function GET(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { searchParams } = new URL(req.url);
  const year = Number(searchParams.get("year") ?? new Date().getUTCFullYear());
  if (!Number.isInteger(year) || year < 2020 || year > 2100) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const from = new Date(Date.UTC(year, 0, 1));
  const to = new Date(Date.UTC(year + 1, 0, 1));

  const [orders, expenses] = await Promise.all([
    db.purchaseOrder.findMany({
      where: {
        restaurantId: ctx.restaurantId,
        receivedAt: { gte: from, lt: to },
      },
      select: {
        retefuenteCents: true,
        supplier: { select: { id: true, name: true, taxId: true } },
        items: { select: { receivedCostCents: true, taxPct: true } },
      },
    }),
    db.expense.findMany({
      where: {
        restaurantId: ctx.restaurantId,
        date: { gte: from, lt: to },
        supplierId: { not: null },
      },
      select: {
        amountCents: true,
        supplier: { select: { id: true, name: true, taxId: true } },
      },
    }),
  ]);

  // Agregado por tercero (proveedor).
  type Agg = {
    name: string;
    taxId: string | null;
    pagoCents: number;
    retefuenteCents: number;
  };
  const bySupplier = new Map<string, Agg>();
  const bump = (
    id: string,
    name: string,
    taxId: string | null,
    pagoCents: number,
    reteCents: number,
  ) => {
    const cur = bySupplier.get(id) ?? {
      name,
      taxId,
      pagoCents: 0,
      retefuenteCents: 0,
    };
    cur.pagoCents += pagoCents;
    cur.retefuenteCents += reteCents;
    bySupplier.set(id, cur);
  };
  for (const o of orders) {
    if (!o.supplier) continue;
    // Bruto = neto recibido + IVA por línea (taxPct).
    let gross = 0;
    for (const it of o.items) {
      gross += Math.round(it.receivedCostCents * (1 + it.taxPct / 100));
    }
    if (gross <= 0 && o.retefuenteCents <= 0) continue;
    bump(o.supplier.id, o.supplier.name, o.supplier.taxId, gross, o.retefuenteCents);
  }
  for (const e of expenses) {
    if (!e.supplier) continue;
    bump(e.supplier.id, e.supplier.name, e.supplier.taxId, e.amountCents, 0);
  }

  const rows: Formato1001Row[] = [];
  const issues: Formato1001Issue[] = [];
  for (const agg of bySupplier.values()) {
    const nit = (agg.taxId ?? "").replace(/\D/g, "");
    if (!nit) {
      issues.push({
        name: agg.name,
        reason: "missing_nit",
        pagoPesos: Math.round(agg.pagoCents / 100),
      });
      continue;
    }
    if (computeNitDv(nit) === null) {
      issues.push({
        name: agg.name,
        reason: "invalid_nit",
        pagoPesos: Math.round(agg.pagoCents / 100),
      });
      continue;
    }
    rows.push({
      concepto: "5004",
      nit,
      name: agg.name,
      pagoPesos: Math.round(agg.pagoCents / 100),
      retefuentePesos: Math.round(agg.retefuenteCents / 100),
    });
  }
  rows.sort((a, b) => b.pagoPesos - a.pagoPesos);

  if (searchParams.get("format") === "txt") {
    const txt = buildFormato1001Txt(rows);
    return new NextResponse(txt, {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "content-disposition": `attachment; filename="exogena-1001-${year}.txt"`,
      },
    });
  }

  return NextResponse.json({
    year,
    rows,
    issues,
    totalPagoPesos: rows.reduce((s, r) => s + r.pagoPesos, 0),
  });
}
