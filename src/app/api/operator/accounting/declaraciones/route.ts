import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { getAccountingConfig, isMonthClosed } from "@/lib/erp/cierre";
import { loadAccountMap } from "@/lib/erp/ledger";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["accounting"];

/**
 * Cuenta del PASIVO que se cancela al pagar cada impuesto. IVA se paga desde
 * el auxiliar de la tarifa dominante (el contador reclasifica si mezcla);
 * el crédito va contra el banco.
 */
const FORM_ACCOUNT: Record<string, string> = {
  iva: "24080501",
  inc: "241205",
  retefuente: "236505",
  ica: "241605",
};

const BANK_CODE = "111005";

/** Declaraciones registradas del año. */
export async function GET(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { searchParams } = new URL(req.url);
  const year = Number(searchParams.get("year") ?? new Date().getUTCFullYear());
  const filings = await db.taxFiling.findMany({
    where: {
      restaurantId: ctx.restaurantId,
      period: { startsWith: String(year) },
    },
    orderBy: [{ period: "desc" }, { form: "asc" }],
  });
  return NextResponse.json({ year, filings });
}

const createSchema = z.object({
  form: z.enum(["iva", "inc", "retefuente", "ica"]),
  period: z.string().regex(/^\d{4}-\d{2}$/),
  declaredCents: z.number().int().min(0).max(2_000_000_000),
  paidDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  notes: z.string().max(500).optional(),
});

/**
 * Registra la declaración/pago de un impuesto: guarda el trámite y, si el
 * monto es > 0, contabiliza el pago (D cuenta del impuesto · C banco) con
 * fuente `taxpay`. Respeta el candado de cierre.
 */
export async function POST(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const b = parsed.data;
  const paidAt = new Date(`${b.paidDate}T12:00:00Z`);
  const payMonth = b.paidDate.slice(0, 7);

  const cfg = await getAccountingConfig(ctx.restaurantId);
  if (isMonthClosed(cfg.closedThrough, payMonth)) {
    return NextResponse.json({ error: "month_closed" }, { status: 409 });
  }

  // Evitar doble registro del mismo impuesto-período.
  const dup = await db.taxFiling.findFirst({
    where: { restaurantId: ctx.restaurantId, form: b.form, period: b.period },
    select: { id: true },
  });
  if (dup) {
    return NextResponse.json({ error: "already_filed" }, { status: 409 });
  }

  const map = await loadAccountMap(ctx.restaurantId);
  const taxCode = FORM_ACCOUNT[b.form]!;
  const taxId = map.get(taxCode);
  const bankId = map.get(BANK_CODE);
  if (!taxId || !bankId) {
    return NextResponse.json({ error: "account_not_found" }, { status: 500 });
  }

  const filing = await db.$transaction(async (tx) => {
    let entryId: string | null = null;
    if (b.declaredCents > 0) {
      const entry = await tx.journalEntry.create({
        data: {
          restaurantId: ctx.restaurantId,
          date: paidAt,
          source: "taxpay",
          sourceRef: `${b.form}-${b.period}`,
          memo: `Pago ${b.form.toUpperCase()} ${b.period}`,
          status: "posted",
          lines: {
            create: [
              {
                accountId: taxId,
                accountCode: taxCode,
                debitCents: b.declaredCents,
                creditCents: 0,
              },
              {
                accountId: bankId,
                accountCode: BANK_CODE,
                debitCents: 0,
                creditCents: b.declaredCents,
              },
            ],
          },
        },
        select: { id: true },
      });
      entryId = entry.id;
    }
    return tx.taxFiling.create({
      data: {
        restaurantId: ctx.restaurantId,
        form: b.form,
        period: b.period,
        declaredCents: b.declaredCents,
        paidAt,
        entryId,
        notes: b.notes ?? null,
      },
    });
  });

  return NextResponse.json({ ok: true, filing }, { status: 201 });
}

/** Borra un registro de declaración (y su asiento de pago si existe). */
export async function DELETE(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id") ?? "";
  const filing = await db.taxFiling.findFirst({
    where: { id, restaurantId: ctx.restaurantId },
  });
  if (!filing) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const cfg = await getAccountingConfig(ctx.restaurantId);
  const payMonth = filing.paidAt.toISOString().slice(0, 7);
  if (isMonthClosed(cfg.closedThrough, payMonth)) {
    return NextResponse.json({ error: "month_closed" }, { status: 409 });
  }
  await db.$transaction(async (tx) => {
    if (filing.entryId) {
      await tx.journalEntry.deleteMany({
        where: { id: filing.entryId, restaurantId: ctx.restaurantId },
      });
    }
    await tx.taxFiling.delete({ where: { id: filing.id } });
  });
  return NextResponse.json({ ok: true });
}
