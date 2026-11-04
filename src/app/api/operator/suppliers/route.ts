import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { normalizePhone } from "@/lib/crm/phone";
import type { ModuleSlug } from "@/lib/modules";
import {
  SUPPLIER_PERSON_TYPES,
  SUPPLIER_TAX_ID_TYPES,
  findSupplierByTaxId,
  normalizeSupplierTaxId,
} from "@/lib/erp/supplierTaxId";

export const dynamic = "force-dynamic";

// Compras O contabilidad: el gasto (módulo contabilidad) elige y crea su
// proveedor ahí mismo, aunque el comercio no use el módulo de compras.
const GATE: ModuleSlug[] = ["purchasing", "accounting"];

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  taxId: z.string().trim().max(40).nullable().optional(),
  /**
   * Tipo de documento de `taxId`. Si viene, el número se normaliza (sin
   * puntos) y el NIT se guarda con su DV calculado ("900123456-7"); un DV
   * escrito que no corresponde se rechaza. Sin tipo, `taxId` queda como
   * texto libre, igual que siempre.
   */
  taxIdType: z.enum(SUPPLIER_TAX_ID_TYPES).nullable().optional(),
  personType: z.enum(SUPPLIER_PERSON_TYPES).nullable().optional(),
  contactName: z.string().trim().max(120).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  email: z.string().trim().email().nullable().optional().or(z.literal("")),
  address: z.string().trim().max(300).nullable().optional(),
  paymentTermsDays: z.number().int().min(0).max(365).nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
});

async function GETHandler() {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const suppliers = await db.supplier.findMany({
    where: { restaurantId: ctx.restaurantId },
    orderBy: [{ active: "desc" }, { name: "asc" }],
    include: { _count: { select: { items: true } } },
  });
  return NextResponse.json({ suppliers });
}

async function POSTHandler(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const b = parsed.data;
  let taxId = b.taxId || null;
  if (taxId && b.taxIdType) {
    const n = normalizeSupplierTaxId(b.taxIdType, taxId);
    if (!n.ok) return NextResponse.json({ error: n.error }, { status: 400 });
    taxId = n.taxId;
  }
  // Duplicados: el 409 trae el proveedor existente para que el formulario
  // ofrezca usarlo en vez de crear otro.
  const dup = await db.supplier.findUnique({
    where: {
      restaurantId_name: { restaurantId: ctx.restaurantId, name: b.name },
    },
    select: { id: true, name: true, taxId: true, active: true },
  });
  if (dup) {
    return NextResponse.json({ error: "name_taken", existing: dup }, { status: 409 });
  }
  if (taxId) {
    // Mismo NIT/cédula = mismo tercero ("900.123.456-7" == "900123456"):
    // dos proveedores con el mismo documento parten la exógena en dos.
    const withTaxId = await db.supplier.findMany({
      where: { restaurantId: ctx.restaurantId, taxId: { not: null } },
      select: { id: true, name: true, taxId: true, active: true },
    });
    const same = findSupplierByTaxId(withTaxId, taxId);
    if (same) {
      return NextResponse.json({ error: "tax_id_taken", existing: same }, { status: 409 });
    }
  }
  const supplier = await db.supplier.create({
    data: {
      restaurantId: ctx.restaurantId,
      name: b.name,
      taxId,
      taxIdType: taxId ? (b.taxIdType ?? null) : null,
      personType: b.personType ?? null,
      contactName: b.contactName || null,
      // Mismo normalizador E.164 del CRM, con el país del comercio.
      phone: b.phone ? normalizePhone(b.phone, ctx.country ?? "CO") : null,
      email: b.email || null,
      address: b.address || null,
      paymentTermsDays: b.paymentTermsDays ?? null,
      notes: b.notes || null,
    },
  });
  return NextResponse.json({ supplier }, { status: 201 });
}

export const GET = secureApi(GETHandler);

export const POST = secureApi(POSTHandler);
