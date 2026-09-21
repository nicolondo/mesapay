import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { isValidNitDv } from "@/lib/erp/exogena";
import { DOC_TYPES_MANUALES } from "@/lib/erp/exogena/normativa";
import { exogenaContext, isResponse } from "../_shared";

export const dynamic = "force-dynamic";

/** Centavos: hasta 2^53 (columna BigInt). */
const cents = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

const createSchema = z.object({
  year: z.number().int().min(2020).max(2100),
  name: z.string().trim().min(1).max(200),
  docType: z.enum(DOC_TYPES_MANUALES),
  docNumber: z.string().trim().min(1).max(30),
  dv: z.string().trim().regex(/^\d$/).optional(),
  /** Participación en basis points (100 % = 10000). */
  sharePctBps: z.number().int().min(0).max(10_000),
  nominalCents: cents,
  premiumCents: cents.optional(),
});

/**
 * Alta de un socio/accionista (formato 1010) del año gravable. El número
 * va numérico (salvo pasaporte) y, si es NIT con DV, el DV tiene que
 * corresponder (módulo 11): 400 `invalid_doc` / `invalid_dv`.
 */
async function POSTHandler(req: Request) {
  const ctx = await exogenaContext();
  if (isResponse(ctx)) return ctx;
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const b = parsed.data;
  const digits = b.docNumber.replace(/[\s.]/g, "");
  if (b.docType !== "PA" && !/^\d+$/.test(digits)) {
    return NextResponse.json({ error: "invalid_doc" }, { status: 400 });
  }
  if (b.docType === "NIT" && b.dv && !isValidNitDv(digits, b.dv)) {
    return NextResponse.json({ error: "invalid_dv" }, { status: 400 });
  }
  const row = await db.exogenaShareholder.create({
    data: {
      restaurantId: ctx.restaurantId,
      year: b.year,
      name: b.name,
      docType: b.docType,
      docNumber: b.docType === "PA" ? b.docNumber : digits,
      dv: b.docType === "NIT" ? (b.dv ?? null) : null,
      sharePctBps: b.sharePctBps,
      nominalCents: BigInt(b.nominalCents),
      premiumCents: BigInt(b.premiumCents ?? 0),
    },
    select: { id: true },
  });
  return NextResponse.json({ ok: true, id: row.id }, { status: 201 });
}

/** Borra una fila propia: `?id=`. */
async function DELETEHandler(req: Request) {
  const ctx = await exogenaContext();
  if (isResponse(ctx)) return ctx;
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!id) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const r = await db.exogenaShareholder.deleteMany({
    where: { id, restaurantId: ctx.restaurantId },
  });
  if (r.count === 0) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export const POST = secureApi(POSTHandler);
export const DELETE = secureApi(DELETEHandler);
