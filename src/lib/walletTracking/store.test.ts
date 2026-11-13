import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/env", () => ({ requireSecretKey: () => "ab".repeat(32) }));
import { recordSourceInTx } from "./store";
const account = { id: "account", scopeKey: "restaurant:r", trackingKey: "identity", mode: "production", currency: "COP" };
const row = { source: "order" as const, sourceId: "p", amountCents: 10000, refundedCents: 0, currency: "COP", trackingKey: "identity", mode: "production", providerRef: "ref", uncertain: false, occurredAt: new Date("2026-11-10T12:00:00Z"), dateBasis: "payment" as const };
function transaction() {
  const entries: Record<string, unknown>[] = [];
  const tx = { walletTrackingEntry: {
    findUnique: vi.fn(async ({ where }: {where:{sourceKey:string}}) => entries.find(e=>e.sourceKey===where.sourceKey) ?? null),
    aggregate: vi.fn(async () => ({ _max: { sourceRefundedCents: entries.reduce((m,e)=>BigInt(e.sourceRefundedCents as bigint)>m?BigInt(e.sourceRefundedCents as bigint):m,BigInt(0)) } })),
    create: vi.fn(async ({data}:{data:Record<string,unknown>}) => { entries.push(data); return data; }),
  } };
  return { entries, tx: tx as never };
}
describe("atomic source ingestion", () => {
  it("records the charge once and only the incremental refund", async () => {
    const {tx, entries}=transaction();
    await recordSourceInTx(tx,account,row);
    await recordSourceInTx(tx,account,{...row,refundedCents:2000});
    await recordSourceInTx(tx,account,{...row,refundedCents:2000});
    await recordSourceInTx(tx,account,{...row,refundedCents:3000});
    expect(entries.map(e=>[e.kind,e.amountCents])).toEqual([["charge",BigInt(10000)],["refund",BigInt(2000)],["refund",BigInt(1000)]]);
  });
  it("rejects reuse under another account and changed gross amounts", async () => {
    const {tx}=transaction();await recordSourceInTx(tx,account,row);
    await expect(recordSourceInTx(tx,{...account,id:"other"},row)).rejects.toThrow("tracking_source_ineligible");
    await expect(recordSourceInTx(tx,account,{...row,amountCents:10001})).rejects.toThrow("tracking_source_ineligible");
  });
  it("cannot turn unknown currency, manual approvals or account mismatch into captured receipts", async () => {
    for(const changes of [{currency:null},{providerRef:"manual:admin:p"},{trackingKey:null},{uncertain:true}]) {
      const {tx,entries}=transaction();
      await expect(recordSourceInTx(tx,account,{...row,...changes})).rejects.toThrow("tracking_source_ineligible");
      expect(entries).toHaveLength(0);
    }
  });
});
