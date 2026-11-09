import "server-only";
import { db } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { getBillingCredentials, getKushkiMode, getRestaurantKushkiMode } from "@/lib/platformConfig";
import type { WalletIncomingScope, WalletIncomingView, WalletIncomingStatus } from "./contracts";
import { attachSettlementReports } from "./matching";
import { loadLocalCharges } from "./local";
import { readSettlementReport, settlementPeriod } from "./report";

type CollectionContext = { mode: "sandbox" | "production"; privateKey: string } | { status: WalletIncomingStatus };
async function collectionContext(scope: WalletIncomingScope): Promise<CollectionContext> {
  try {
    if (scope.kind === "platform") {
      const mode = await getKushkiMode();
      if (mode === "mock") return { status: "unsupported" };
      const { privateKey } = await getBillingCredentials();
      return privateKey ? { mode, privateKey } : { status: "credentials_missing" };
    }
    const restaurant = await db.restaurant.findUnique({ where: { id: scope.restaurantId },
      select: { country: true, kushkiMode: true, kushkiPrivateKeyEnc: true } });
    if (!restaurant) return { status: "credentials_missing" };
    if (restaurant.country !== "CO") return { status: "unsupported" };
    const mode = await getRestaurantKushkiMode(restaurant);
    if (mode === "mock") return { status: "unsupported" };
    if (!restaurant.kushkiPrivateKeyEnc) return { status: "credentials_missing" };
    let privateKey: string;
    try { privateKey = decrypt(restaurant.kushkiPrivateKeyEnc); }
    catch { return { status: "credentials_missing" }; }
    return privateKey ? { mode, privateKey } : { status: "credentials_missing" };
  } catch { return { status: "unavailable" }; }
}

/** Read-only view: no ledger writes, no pending balance calculation, no payout. */
export async function loadWalletIncoming(scope: WalletIncomingScope): Promise<WalletIncomingView> {
  const now = new Date();
  const period = settlementPeriod(now);
  const base: WalletIncomingView = { status: "unavailable", reportMode: null, periodStart: period.periodStart, periodEnd: period.periodEnd,
    queriedAt: now.toISOString(), reportThrough: period.endDate, localCharges: [], localTruncated: false, unmatchedReportCount: 0, reportComplete: false };
  let local;
  try { local = await loadLocalCharges(scope, period); }
  catch { throw new Error("local_collections_unavailable"); }
  const context = await collectionContext(scope);
  if ("status" in context) return { ...base, ...attachSettlementReports(local.charges, []), status: context.status, localTruncated: local.truncated };
  const report = await readSettlementReport({ ...context, period });
  // An unseen page can contain a duplicate reference. Never establish uniqueness
  // from a truncated local list or partial provider report.
  return { ...base, ...attachSettlementReports(local.charges, report.rows, local.truncated || !report.complete),
    status: report.status, reportMode: context.mode, localTruncated: local.truncated, reportComplete: report.complete };
}
