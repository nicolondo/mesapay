import { describe, expect, it } from "vitest";
import { attachSettlementReports, type LocalCharge } from "./matching";
import type { SettlementRow } from "./report";

const charge = (extra: Partial<LocalCharge> = {}): LocalCharge => ({ id: "p1", source: "order", occurredAt: "2026-11-06T12:00:00Z", dateBasis: "payment", amountCents: 1500000, refundedCents: 0, currency: null, references: ["ticket-1"], ...extra });
const row = (extra: Partial<SettlementRow> = {}): SettlementRow => ({ reference: "ticket-1", eligible: true, grossCents: 1500000, netCents: 1468200, paymentDate: "2026-11-11", currency: "COP", ...extra });
describe("informational statement matching", () => {
  it("links an exact unique reference and gross without inventing the local currency or a credit", () => {
    const result = attachSettlementReports([charge()], [row()]);
    expect(result.localCharges[0]).toEqual({ id: "p1", source: "order", occurredAt: "2026-11-06T12:00:00Z", dateBasis: "payment", amountCents: 1500000, refundedCents: 0, currency: null, report: { grossCents: 1500000, netCents: 1468200, paymentDate: "2026-11-11", currency: "COP" } });
    expect(result.unmatchedReportCount).toBe(0);
  });
  it.each([row({ grossCents: 12 }), row({ currency: "USD" }), row({ reference: "other" }), row({ eligible: false })])("rejects mismatch or non-collection evidence", report => {
    expect(attachSettlementReports([charge({ currency: "COP" })], [report])).toMatchObject({ localCharges: [expect.not.objectContaining({ report: expect.anything() })], unmatchedReportCount: 1 });
  });
  it("does not match duplicate references on either side", () => {
    const locals = [charge(), charge({ id: "p2" })];
    expect(attachSettlementReports(locals, [row()]).unmatchedReportCount).toBe(1);
    expect(attachSettlementReports([charge()], [row(), row()]).unmatchedReportCount).toBe(2);
  });
  it("does not attach multiple distinct report rows to one economic payment", () => {
    const result = attachSettlementReports([charge({ references: ["ticket-1", "ticket-2"] })], [row(), row({ reference: "ticket-2" })]);
    expect(result.unmatchedReportCount).toBe(2);
    expect(result.localCharges[0].report).toBeUndefined();
  });
  it("does not bypass an ambiguous alias using a different apparently unique reference", () => {
    const result = attachSettlementReports([charge({ references: ["ticket-1", "alias"] })], [row(), row({ reference: "alias" }), row({ reference: "alias" })]);
    expect(result.unmatchedReportCount).toBe(3);
    expect(result.localCharges[0].report).toBeUndefined();
  });
  it("retains actual refunds separately while matching original gross", () => {
    expect(attachSettlementReports([charge({ refundedCents: 500000 })], [row()]).localCharges[0]).toMatchObject({ refundedCents: 500000, report: { grossCents: 1500000 } });
  });
  it("strips internal references and disables matching for a truncated local list", () => {
    const result = attachSettlementReports([charge()], [row()], true);
    expect(result.unmatchedReportCount).toBe(1);
    expect(result.localCharges[0]).not.toHaveProperty("references");
    expect(result.localCharges[0].report).toBeUndefined();
  });
});
