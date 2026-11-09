import type { WalletIncomingCharge } from "./contracts";
import type { SettlementRow } from "./report";

/** References never leave the server-side matching boundary. */
export type LocalCharge = Omit<WalletIncomingCharge, "report"> & { references: string[] };

export function attachSettlementReports(charges: LocalCharge[], rows: SettlementRow[], localTruncated = false) {
  const localByReference = new Map<string, number[]>();
  const reportByReference = new Map<string, number[]>();
  for (const [index, charge] of charges.entries()) for (const ref of new Set(charge.references)) {
    localByReference.set(ref, [...(localByReference.get(ref) ?? []), index]);
  }
  for (const [index, row] of rows.entries()) reportByReference.set(row.reference, [...(reportByReference.get(row.reference) ?? []), index]);
  let matched = 0;
  const localCharges: WalletIncomingCharge[] = charges.map((charge) => {
    const { references, ...dto } = charge;
    if (localTruncated) return dto;
    if (references.some((ref) => (reportByReference.get(ref)?.length ?? 0) > 1 ||
        (reportByReference.has(ref) && (localByReference.get(ref)?.length ?? 0) > 1))) return dto;
    const candidates = [...new Set(references)].flatMap((ref) => {
      const reports = reportByReference.get(ref) ?? [];
      return localByReference.get(ref)?.length === 1 && reports.length === 1 ? reports : [];
    });
    // Even two coherent rows cannot be collapsed into one economic payment.
    if (candidates.length !== 1) return dto;
    const row = rows[candidates[0]];
    if (!row.eligible || row.grossCents !== charge.amountCents || (charge.currency !== null && charge.currency !== row.currency)) return dto;
    matched++;
    return { ...dto, report: { grossCents: row.grossCents, netCents: row.netCents, currency: row.currency, paymentDate: row.paymentDate } };
  });
  return { localCharges, unmatchedReportCount: rows.length - matched };
}
