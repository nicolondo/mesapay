import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { secureApi } from "@/lib/secureApi";
import { rateLimit } from "@/lib/rateLimit";
import { activeAccount } from "@/lib/platformWallet/config";
import { walletJson } from "@/lib/platformWallet/api";
import { WalletError } from "@/lib/platformWallet/errors";
import { TrackingError } from "@/lib/walletTracking/errors";
import { getWalletTracking, syncWalletTracking, adjustWalletTracking, listTrackingHistoryCandidates, incorporateTrackingHistory, findWalletTrackingOperation } from "@/lib/walletTracking/service";
import type { TrackingActor, TrackingScope } from "@/lib/walletTracking/contracts";

type Operation = "get" | "sync" | "history" | "incorporate" | "adjust";
const id = z.string().trim().min(1).max(128);
const syncSchema = z.object({ action: z.literal("sync") }).strict();
const adjustmentSchema = z.object({ trackingId: id, idempotencyKey: id, kind: z.enum(["fee", "external_credit", "external_debit", "correction"]), amountCents: z.number().int().safe(), reason: z.string().trim().min(1).max(500), acknowledgeHistoricalChanges: z.boolean().optional(), historicalChangeToken: z.string().min(1).max(128).optional() }).strict();
const incorporationSchema = z.object({ trackingId: id, idempotencyKey: id, source: z.enum(["order", "subscription", "reservation", "voucher"]), sourceId: id, remainingCents: z.number().int().safe().positive(), reason: z.string().trim().min(1).max(500) }).strict();
const querySchema = z.object({ cursor: z.string().min(1).max(2000).optional(), limit: z.coerce.number().int().min(1).max(50).optional() });
const response = (value: unknown, status = 200) => NextResponse.json(value, { status, headers: { "Cache-Control": "no-store" } });

async function currentContext(kind: TrackingScope["kind"]) {
  return kind === "platform" ? (await activeAccount()).id : await getActiveRestaurantId();
}

export function createTrackingHandler(kind: TrackingScope["kind"], operation: Operation) {
  return secureApi(async (req: Request) => {
    const session = await auth();
    const user = session?.user;
    const roles = kind === "platform" ? ["platform_admin"] : ["platform_admin", "operator", "group_admin"];
    if (!user?.id || !roles.includes(user.role)) return response({ error: "unauthorized" }, 401);
    const actor: TrackingActor = { id: user.id, email: user.email ?? "", role: user.role };
    const field = kind === "platform" ? "accountId" : "restaurantId";
    const changed = kind === "platform" ? "account_changed" : "tenant_changed";
    try {
      const reading = operation === "get" || operation === "history";
      const url = new URL(req.url);
      const raw = reading ? Object.fromEntries(url.searchParams) : await walletJson(req);
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return response({ error: "invalid_payload" }, 400);
      const body = raw as Record<string, unknown>;
      const requested = id.safeParse(body[field]);
      if (!requested.success) return response({ error: "invalid_payload" }, 400);
      const current = await currentContext(kind);
      if (!current) return response({ error: "unauthorized" }, 401);
      if (current !== requested.data) return response({ error: changed }, 409);
      if (!await rateLimit(`wallet-tracking:${kind}:${current}:${operation}`, reading ? 60 : operation === "sync" ? 6 : 20, 60)) return response({ error: "rate_limited" }, 429);
      const scope: TrackingScope = kind === "platform" ? { kind } : { kind, restaurantId: current };
      const payload = { ...body };
      delete payload.accountId;
      delete payload.restaurantId;
      let result;
      if (operation === "get") {
        const operationId = id.optional().safeParse(body.operationId);
        if (!operationId.success) return response({ error: "invalid_payload" }, 400);
        result = { ...await getWalletTracking(scope), ...(operationId.data ? { operationFound: await findWalletTrackingOperation(scope, operationId.data) } : {}) };
      }
      else if (operation === "history") {
        const query = querySchema.safeParse(payload);
        if (!query.success) return response({ error: "invalid_payload" }, 400);
        result = await listTrackingHistoryCandidates(scope, query.data);
      } else if (operation === "sync") {
        if (!syncSchema.safeParse(payload).success) return response({ error: "invalid_payload" }, 400);
        result = await syncWalletTracking(scope, actor);
      } else if (operation === "adjust") {
        const parsed = adjustmentSchema.safeParse(payload);
        if (!parsed.success) return response({ error: "invalid_payload" }, 400);
        result = await adjustWalletTracking(scope, parsed.data, actor);
      } else {
        const parsed = incorporationSchema.safeParse(payload);
        if (!parsed.success) return response({ error: "invalid_payload" }, 400);
        result = await incorporateTrackingHistory(scope, parsed.data, actor);
      }
      // A response for an old account must never populate the newly selected wallet.
      if (await currentContext(kind) !== current) return response({ error: changed }, 409);
      return response({ ...result, [field]: current });
    } catch (error) {
      if (error instanceof TrackingError || error instanceof WalletError) return response({ error: error.code }, error.status);
      return response({ error: "tracking_unavailable" }, 503);
    }
  });
}
