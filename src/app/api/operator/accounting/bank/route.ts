import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { z } from "zod";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { getAccountingConfig, isMonthClosed } from "@/lib/erp/cierre";
import { loadAccountIndex, type AccountIndexEntry } from "@/lib/erp/ledger";
import { resolvePostableCode } from "@/lib/erp/chart";
import { dedupeBankLines, foldText, parseBankStatement } from "@/lib/erp/bankStatement";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["accounting"];

/** Cuenta base de bancos del PUC sembrado; con auxiliares, la imputable de abajo. */
const BANK_BASE_CODE = "111005";

const fold = foldText;

/** Cuenta del banco por defecto: la imputable de 111005 (o la auxiliar convencional). */
function defaultBankCode(index: ReadonlyMap<string, AccountIndexEntry>): string | null {
  return resolvePostableCode(index, BANK_BASE_CODE);
}

/** ¿Puede recibir el movimiento? Existe, es imputable y está activa. */
function postableActive(index: ReadonlyMap<string, AccountIndexEntry>, code: string): boolean {
  const a = index.get(code);
  return a != null && a.postable && a.active;
}

/** Extracto pendiente + reglas (para el tab Bancos). */
async function GETHandler() {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const [lines, rules, index] = await Promise.all([
    db.bankStatementLine.findMany({
      where: { restaurantId: ctx.restaurantId, status: "pending" },
      orderBy: { date: "desc" },
      take: 200,
    }),
    db.bankRecRule.findMany({
      where: { restaurantId: ctx.restaurantId },
      orderBy: { createdAt: "asc" },
    }),
    loadAccountIndex(ctx.restaurantId),
  ]);
  return NextResponse.json({ lines, rules, defaultBankAccountCode: defaultBankCode(index) });
}

const importSchema = z.object({ csv: z.string().min(3).max(2_000_000) });
const ruleSchema = z.object({
  addRule: z.object({
    pattern: z.string().min(2).max(120),
    accountCode: z.string().min(4).max(10),
  }),
});

/** Importa un CSV de extracto (body {csv}) o crea una regla (body {addRule}). */
async function POSTHandler(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const body = await req.json().catch(() => null);

  const asRule = ruleSchema.safeParse(body);
  if (asRule.success) {
    const index = await loadAccountIndex(ctx.restaurantId);
    if (!index.get(asRule.data.addRule.accountCode)) {
      return NextResponse.json({ error: "account_not_found" }, { status: 400 });
    }
    if (!postableActive(index, asRule.data.addRule.accountCode)) {
      return NextResponse.json({ error: "account_not_postable" }, { status: 400 });
    }
    await db.bankRecRule.create({
      data: { restaurantId: ctx.restaurantId, ...asRule.data.addRule },
    });
    const rules = await db.bankRecRule.findMany({
      where: { restaurantId: ctx.restaurantId },
      orderBy: { createdAt: "asc" },
    });
    return NextResponse.json({ ok: true, rules });
  }

  const parsed = importSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const { lines: parsedLines, skipped, byHeader } = parseBankStatement(parsed.data.csv);
  // Pegar el mismo extracto dos veces no duplica: se compara contra lo ya
  // importado en esas fechas (cualquier estado: pendiente, contabilizado o
  // ignorado).
  let fresh = parsedLines;
  let duplicates = 0;
  if (parsedLines.length > 0) {
    const times = parsedLines.map((l) => l.date.getTime());
    const existing = await db.bankStatementLine.findMany({
      where: {
        restaurantId: ctx.restaurantId,
        date: { gte: new Date(Math.min(...times)), lte: new Date(Math.max(...times)) },
      },
      select: { date: true, amountCents: true, description: true },
    });
    ({ fresh, duplicates } = dedupeBankLines(parsedLines, existing));
  }
  const batch = randomBytes(6).toString("hex");
  if (fresh.length > 0) {
    await db.bankStatementLine.createMany({
      data: fresh.map((l) => ({ restaurantId: ctx.restaurantId, importBatch: batch, ...l })),
    });
  }
  return NextResponse.json({ ok: true, imported: fresh.length, skipped, duplicates, byHeader });
}

const patchSchema = z.object({
  lineId: z.string().optional(),
  action: z.enum(["ignore", "journalize", "applyRules", "deleteRule"]),
  accountCode: z.string().min(4).max(10).optional(),
  /** Cuenta del banco (11xx imputable). Sin ella, la imputable de 111005. */
  bankAccountCode: z.string().min(4).max(10).optional(),
  ruleId: z.string().optional(),
});

/**
 * Acciones de conciliación: ignorar línea, contabilizarla contra una cuenta,
 * aplicar las reglas a todas las pendientes o borrar una regla.
 */
async function PATCHHandler(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const b = parsed.data;
  const restaurantId = ctx.restaurantId;

  if (b.action === "deleteRule") {
    if (!b.ruleId) return NextResponse.json({ error: "invalid" }, { status: 400 });
    await db.bankRecRule.deleteMany({
      where: { id: b.ruleId, restaurantId: restaurantId },
    });
    return NextResponse.json({ ok: true });
  }

  const [cfg, index] = await Promise.all([
    getAccountingConfig(restaurantId),
    loadAccountIndex(restaurantId),
  ]);
  // La cuenta del banco: la que eligió el operador (un auxiliar por banco) o
  // la imputable de 111005. Antes siempre 111005, aunque tuviera auxiliares.
  const bankCode = b.bankAccountCode ?? defaultBankCode(index);
  if (
    b.action !== "ignore" &&
    (!bankCode || !bankCode.startsWith("11") || !postableActive(index, bankCode))
  ) {
    return NextResponse.json({ error: "bank_account_invalid" }, { status: 400 });
  }

  async function journalizeLine(
    line: { id: string; date: Date; description: string; amountCents: number },
    accountCode: string,
  ): Promise<"ok" | "month_closed" | "account_not_found" | "account_not_postable"> {
    const month = line.date.toISOString().slice(0, 7);
    if (isMonthClosed(cfg.closedThrough, month)) return "month_closed";
    const bankId = index.get(bankCode!)?.id;
    const other = index.get(accountCode);
    if (!bankId || !other) return "account_not_found";
    // La contrapartida también tiene que poder recibir el movimiento: una
    // agrupadora o una cuenta inactiva dejaría el asiento fuera de los
    // reportes.
    if (!postableActive(index, accountCode)) return "account_not_postable";
    const otherId = other.id;
    const abs = Math.abs(line.amountCents);
    const bank = bankCode!;
    // Abono (entra al banco): D banco · C cuenta. Cargo: D cuenta · C banco.
    const lines =
      line.amountCents > 0
        ? [
            { accountId: bankId, accountCode: bank, debitCents: abs, creditCents: 0 },
            { accountId: otherId, accountCode, debitCents: 0, creditCents: abs },
          ]
        : [
            { accountId: otherId, accountCode, debitCents: abs, creditCents: 0 },
            { accountId: bankId, accountCode: bank, debitCents: 0, creditCents: abs },
          ];
    await db.$transaction(async (tx) => {
      const entry = await tx.journalEntry.create({
        data: {
          restaurantId: restaurantId,
          date: line.date,
          source: "bank",
          sourceRef: line.id,
          memo: line.description.slice(0, 200),
          status: "posted",
          lines: { create: lines.map((l) => ({ ...l, memo: null })) },
        },
        select: { id: true },
      });
      await tx.bankStatementLine.update({
        where: { id: line.id },
        data: { status: "journalized", entryId: entry.id },
      });
    });
    return "ok";
  }

  if (b.action === "applyRules") {
    const [rules, pending] = await Promise.all([
      db.bankRecRule.findMany({ where: { restaurantId: restaurantId } }),
      db.bankStatementLine.findMany({
        where: { restaurantId: restaurantId, status: "pending" },
        take: 200,
      }),
    ]);
    let applied = 0;
    let skippedClosed = 0;
    let skippedInvalid = 0;
    for (const line of pending) {
      const desc = fold(line.description);
      const rule = rules.find((r) => desc.includes(fold(r.pattern)));
      if (!rule) continue;
      const r = await journalizeLine(line, rule.accountCode);
      if (r === "ok") applied++;
      else if (r === "month_closed") skippedClosed++;
      else skippedInvalid++;
    }
    return NextResponse.json({ ok: true, applied, skippedClosed, skippedInvalid });
  }

  if (!b.lineId) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const line = await db.bankStatementLine.findFirst({
    where: { id: b.lineId, restaurantId: restaurantId, status: "pending" },
  });
  if (!line) return NextResponse.json({ error: "not_found" }, { status: 404 });

  if (b.action === "ignore") {
    await db.bankStatementLine.update({
      where: { id: line.id },
      data: { status: "ignored" },
    });
    return NextResponse.json({ ok: true });
  }

  if (!b.accountCode) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const r = await journalizeLine(line, b.accountCode);
  if (r !== "ok") {
    return NextResponse.json({ error: r }, { status: 409 });
  }
  return NextResponse.json({ ok: true });
}

export const GET = secureApi(GETHandler);

export const POST = secureApi(POSTHandler);

export const PATCH = secureApi(PATCHHandler);
