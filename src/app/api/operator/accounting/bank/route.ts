import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { z } from "zod";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { getAccountingConfig, isMonthClosed } from "@/lib/erp/cierre";
import { loadAccountMap } from "@/lib/erp/ledger";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["accounting"];

/** Cuenta banco contra la que concilia todo (la del PUC sembrado). */
const BANK_CODE = "111005";

function fold(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

/** Extracto pendiente + reglas (para el tab Bancos). */
export async function GET() {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const [lines, rules] = await Promise.all([
    db.bankStatementLine.findMany({
      where: { restaurantId: ctx.restaurantId, status: "pending" },
      orderBy: { date: "desc" },
      take: 200,
    }),
    db.bankRecRule.findMany({
      where: { restaurantId: ctx.restaurantId },
      orderBy: { createdAt: "asc" },
    }),
  ]);
  return NextResponse.json({ lines, rules });
}

/**
 * Parser de extracto CSV, tolerante a los formatos de banca colombiana:
 * separador `;` o `,` o tab; fecha dd/mm/yyyy o yyyy-mm-dd; monto con coma
 * o punto decimal, paréntesis o signo para débitos; encabezado opcional.
 * Devuelve null para las filas que no parsean (se reportan como omitidas).
 */
function parseCsvLine(
  rawLine: string,
): { date: Date; description: string; amountCents: number } | null {
  const sep = rawLine.includes(";") ? ";" : rawLine.includes("\t") ? "\t" : ",";
  const cells = rawLine.split(sep).map((c) => c.trim().replace(/^"|"$/g, ""));
  if (cells.length < 2) return null;

  // Fecha: primera celda que parsee como dd/mm/yyyy o yyyy-mm-dd.
  let date: Date | null = null;
  let dateIdx = -1;
  for (let i = 0; i < cells.length && i < 3; i++) {
    const c = cells[i]!;
    let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(c);
    if (m) {
      date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
      dateIdx = i;
      break;
    }
    m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(c);
    if (m) {
      date = new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1])));
      dateIdx = i;
      break;
    }
  }
  if (!date || isNaN(date.getTime())) return null;

  // Monto: última celda numérica. "1.234.567,89" / "1,234,567.89" / "(500)".
  let amountCents: number | null = null;
  let amountIdx = -1;
  for (let i = cells.length - 1; i >= 0; i--) {
    if (i === dateIdx) continue;
    let c = cells[i]!;
    if (c === "") continue;
    let negative = false;
    if (/^\(.*\)$/.test(c)) {
      negative = true;
      c = c.slice(1, -1);
    }
    if (c.startsWith("-")) {
      negative = true;
      c = c.slice(1);
    }
    if (!/^[\d.,$\s]+$/.test(c) || !/\d/.test(c)) continue;
    c = c.replace(/[$\s]/g, "");
    // Última puntuación = separador decimal si deja 1-2 dígitos.
    const lastSep = Math.max(c.lastIndexOf(","), c.lastIndexOf("."));
    let pesos: number;
    if (lastSep > -1 && c.length - lastSep - 1 <= 2) {
      const intPart = c.slice(0, lastSep).replace(/[.,]/g, "");
      const decPart = c.slice(lastSep + 1);
      pesos = Number(`${intPart}.${decPart}`);
    } else {
      pesos = Number(c.replace(/[.,]/g, ""));
    }
    if (!isFinite(pesos)) continue;
    amountCents = Math.round(pesos * 100) * (negative ? -1 : 1);
    amountIdx = i;
    break;
  }
  if (amountCents == null || amountCents === 0) return null;

  const description =
    cells
      .filter((_, i) => i !== dateIdx && i !== amountIdx)
      .filter(Boolean)
      .join(" · ")
      .slice(0, 300) || "(sin descripción)";
  return { date, description, amountCents };
}

const importSchema = z.object({ csv: z.string().min(3).max(2_000_000) });
const ruleSchema = z.object({
  addRule: z.object({
    pattern: z.string().min(2).max(120),
    accountCode: z.string().min(4).max(10),
  }),
});

/** Importa un CSV de extracto (body {csv}) o crea una regla (body {addRule}). */
export async function POST(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const body = await req.json().catch(() => null);

  const asRule = ruleSchema.safeParse(body);
  if (asRule.success) {
    const map = await loadAccountMap(ctx.restaurantId);
    if (!map.get(asRule.data.addRule.accountCode)) {
      return NextResponse.json({ error: "account_not_found" }, { status: 400 });
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
  const rows = parsed.data.csv.split(/\r?\n/).filter((l) => l.trim() !== "");
  const batch = randomBytes(6).toString("hex");
  const data: Array<{
    restaurantId: string;
    date: Date;
    description: string;
    amountCents: number;
    importBatch: string;
  }> = [];
  let skipped = 0;
  for (const row of rows) {
    const p = parseCsvLine(row);
    if (!p) {
      skipped++;
      continue;
    }
    data.push({ restaurantId: ctx.restaurantId, importBatch: batch, ...p });
  }
  if (data.length > 0) {
    await db.bankStatementLine.createMany({ data });
  }
  return NextResponse.json({ ok: true, imported: data.length, skipped });
}

const patchSchema = z.object({
  lineId: z.string().optional(),
  action: z.enum(["ignore", "journalize", "applyRules", "deleteRule"]),
  accountCode: z.string().min(4).max(10).optional(),
  ruleId: z.string().optional(),
});

/**
 * Acciones de conciliación: ignorar línea, contabilizarla contra una cuenta,
 * aplicar las reglas a todas las pendientes o borrar una regla.
 */
export async function PATCH(req: Request) {
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

  const cfg = await getAccountingConfig(restaurantId);

  async function journalizeLine(
    line: { id: string; date: Date; description: string; amountCents: number },
    accountCode: string,
  ): Promise<"ok" | "month_closed" | "account_not_found"> {
    const month = line.date.toISOString().slice(0, 7);
    if (isMonthClosed(cfg.closedThrough, month)) return "month_closed";
    const map = await loadAccountMap(restaurantId);
    const bankId = map.get(BANK_CODE);
    const otherId = map.get(accountCode);
    if (!bankId || !otherId) return "account_not_found";
    const abs = Math.abs(line.amountCents);
    // Abono (entra al banco): D banco · C cuenta. Cargo: D cuenta · C banco.
    const lines =
      line.amountCents > 0
        ? [
            { accountId: bankId, accountCode: BANK_CODE, debitCents: abs, creditCents: 0 },
            { accountId: otherId, accountCode, debitCents: 0, creditCents: abs },
          ]
        : [
            { accountId: otherId, accountCode, debitCents: abs, creditCents: 0 },
            { accountId: bankId, accountCode: BANK_CODE, debitCents: 0, creditCents: abs },
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
    for (const line of pending) {
      const desc = fold(line.description);
      const rule = rules.find((r) => desc.includes(fold(r.pattern)));
      if (!rule) continue;
      const r = await journalizeLine(line, rule.accountCode);
      if (r === "ok") applied++;
      else if (r === "month_closed") skippedClosed++;
    }
    return NextResponse.json({ ok: true, applied, skippedClosed });
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
