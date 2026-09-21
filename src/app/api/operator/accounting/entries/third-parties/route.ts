import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["accounting"];

const TAKE = 10;

export type ThirdPartyHit = {
  name: string;
  taxId: string | null;
  kind: "supplier" | "customer";
};

/**
 * Selector de tercero del comprobante manual: busca por nombre (o NIT) en
 * proveedores del comercio y en clientes de facturación, y devuelve sólo
 * `{name, taxId, kind}` — el asiento guarda el texto, no la referencia.
 */
async function GETHandler(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { searchParams } = new URL(req.url);
  const q = (searchParams.get("q") ?? "").trim().slice(0, 80);
  const [suppliers, customers] = await Promise.all([
    db.supplier.findMany({
      where: {
        restaurantId: ctx.restaurantId,
        active: true,
        ...(q && {
          OR: [
            { name: { contains: q, mode: "insensitive" } },
            { taxId: { contains: q } },
          ],
        }),
      },
      orderBy: { name: "asc" },
      take: TAKE,
      select: { name: true, taxId: true },
    }),
    db.billingCustomer.findMany({
      where: {
        restaurantId: ctx.restaurantId,
        ...(q && {
          OR: [
            { customerName: { contains: q, mode: "insensitive" } },
            { docNumber: { contains: q } },
          ],
        }),
      },
      orderBy: { customerName: "asc" },
      take: TAKE,
      select: { customerName: true, docNumber: true },
    }),
  ]);
  const items: ThirdPartyHit[] = [
    ...suppliers.map((s) => ({ name: s.name, taxId: s.taxId ?? null, kind: "supplier" as const })),
    ...customers.map((c) => ({ name: c.customerName, taxId: c.docNumber || null, kind: "customer" as const })),
  ];
  return NextResponse.json({ items });
}

export const GET = secureApi(GETHandler);
