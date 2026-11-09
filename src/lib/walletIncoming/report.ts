import "server-only";
import { z } from "zod";
import { addDaysIso, bogotaBusinessDateIso, bogotaDayRange } from "@/lib/bogota";
import type { WalletIncomingReport, WalletIncomingStatus } from "./contracts";

const PAGE_SIZE = 100;
const MAX_PAGES = 5;
const MAX_BODY_BYTES = 1_048_576;
const REQUEST_BUDGET_MS = 30_000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const validDay = (value: string) => DAY.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const dateSchema = z.string().refine(validDay);
const referenceSchema = z.string().min(1).max(200).refine((s) => s.trim() === s);
const rowSchema = z.object({
  ticket_number: referenceSchema, merchant_id: referenceSchema,
  currency_code: z.string().regex(/^[A-Z]{3}$/), created: dateSchema, payment_date: dateSchema,
  transaction_status: z.string().min(1).max(40), transaction_type: z.string().min(1).max(40),
  approved_transaction_amount: z.string().max(40), pay_amount: z.string().max(40),
});
const pageSchema = z.object({ data: z.array(rowSchema).max(PAGE_SIZE), pagination: z.object({
  page: z.number().int().min(1), limit: z.literal(PAGE_SIZE),
  total: z.number().int().min(0).max(1_000_000), totalPages: z.number().int().min(0).max(10_000),
}) });

export type SettlementPeriod = { startDate: string; endDate: string; periodStart: string; periodEnd: string };
export type SettlementRow = WalletIncomingReport & { reference: string; eligible: boolean };
export type SettlementResult = { status: WalletIncomingStatus; rows: SettlementRow[]; complete: boolean };

export function settlementPeriod(now: Date): SettlementPeriod {
  const endDate = addDaysIso(bogotaBusinessDateIso(now), -1);
  const startDate = addDaysIso(endDate, -6);
  return { startDate, endDate, periodStart: bogotaDayRange(startDate).start.toISOString(), periodEnd: now.toISOString() };
}

/** Provider decimal strings are pesos, converted with integer arithmetic. */
export function decimalCents(value: unknown): number {
  if (typeof value !== "string" || !/^-?\d+(?:\.\d{1,2})?$/.test(value) || value.length > 40) throw new Error("invalid_money");
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = (negative ? value.slice(1) : value).split(".");
  const cents = (BigInt(whole) * BigInt(100) + BigInt(fraction.padEnd(2, "0"))) * BigInt(negative ? -1 : 1);
  if (cents > BigInt(Number.MAX_SAFE_INTEGER) || cents < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error("unsafe_money");
  return Number(cents);
}

async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("empty_report");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > MAX_BODY_BYTES) { await reader.cancel(); throw new Error("report_too_large"); }
    chunks.push(next.value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** This POST is a read-only report. Never use it as evidence of a wallet credit. */
export async function readSettlementReport(input: {
  mode: "production" | "sandbox"; privateKey: string; period: SettlementPeriod;
}): Promise<SettlementResult> {
  const failure = (status: WalletIncomingStatus): SettlementResult => ({ status, rows: [], complete: false });
  const origin = input.mode === "production" ? "https://api.kushkipagos.com" : "https://api-uat.kushkipagos.com";
  const deadline = Date.now() + REQUEST_BUDGET_MS;
  const rows: SettlementRow[] = [];
  let merchant: string | undefined;
  let total: number | undefined;
  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return failure("unavailable");
      const response = await fetch(`${origin}/merchant-settlement/v1/settlement?switch=ecommerce`, {
        method: "POST", cache: "no-store", redirect: "error",
        headers: { "Content-Type": "application/json", "Private-Merchant-Id": input.privateKey },
        body: JSON.stringify({ startDate: input.period.startDate, endDate: input.period.endDate, page, limit: PAGE_SIZE }),
        signal: AbortSignal.timeout(Math.min(12_000, remaining)),
      });
      if (!response.ok) {
        if (response.status === 403) {
          const error = z.object({ code: z.literal("E003") }).safeParse(await boundedJson(response).catch(() => null));
          return failure(error.success ? "permission_required" : "unavailable");
        }
        await response.body?.cancel();
        return failure(response.status === 401 ? "credentials_missing" : "unavailable");
      }
      const result = pageSchema.parse(await boundedJson(response));
      const p = result.pagination;
      const expectedPages = Math.ceil(p.total / PAGE_SIZE);
      if (p.page !== page || (p.totalPages !== expectedPages && !(p.total === 0 && p.totalPages === 1)) ||
          (total !== undefined && total !== p.total) || result.data.length !== Math.min(PAGE_SIZE, Math.max(0, p.total - (page - 1) * PAGE_SIZE))) throw new Error("incomplete_pagination");
      total = p.total;
      for (const row of result.data) {
        if ((merchant && merchant !== row.merchant_id) || row.created < input.period.startDate || row.created > input.period.endDate) throw new Error("wrong_report_scope");
        merchant = row.merchant_id;
        const grossCents = decimalCents(row.approved_transaction_amount);
        rows.push({ reference: row.ticket_number, grossCents, netCents: decimalCents(row.pay_amount),
          currency: row.currency_code, paymentDate: row.payment_date,
          eligible: grossCents > 0 && row.transaction_status === "APPROVED" && ["SALE", "CAPTURE"].includes(row.transaction_type) });
      }
      if (page >= p.totalPages) return { status: "available", rows, complete: true };
    }
    return { status: "available", rows, complete: false };
  } catch { return failure("unavailable"); }
}
