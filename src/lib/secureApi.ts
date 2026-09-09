import { resolveEnabledPaymentMethods, type PaymentMethodSlug } from "./paymentMethods";
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { db } from "./db";
import { getActiveContext } from "./activeRestaurant";
import { canAccessOrder, canAccessTable } from "./guestAccess";
import { rateLimit } from "./rateLimit";

const deny = (error: string, status = 403) => NextResponse.json({ error }, { status });

async function guard(req: Request): Promise<Response | null> {
  const path = new URL(req.url).pathname;
  const mutation = !["GET", "HEAD", "OPTIONS"].includes(req.method);
  if (mutation) {
    const origin = req.headers.get("origin");
    const host = req.headers.get("host");
    if (origin && host && new URL(origin).host !== host && !path.startsWith("/api/webhooks/")) return deny("invalid_origin");
  }
  if (mutation && !path.startsWith("/api/cron/") && !path.startsWith("/api/webhooks/")) {
    // nginx must replace X-Real-IP; never trust a caller-controlled forwarded chain.
    const ip = req.headers.get("x-real-ip") ?? "unattributed";
    const expensive = /import|ocr|insights/.test(path);
    const limit = path.startsWith("/api/auth/") ? 15 : expensive ? 20 : 120;
    if (!await rateLimit(`api:${path}:${ip}`, limit, 60)) {
      const response = deny("rate_limited", 429); response.headers.set("Retry-After", "60"); return response;
    }
    if (expensive) {
      const ctx = await getActiveContext();
      if (ctx?.restaurantId && !await rateLimit(`expensive:${ctx.restaurantId}`, 40, 60)) return deny("rate_limited", 429);
    }
  }
  if (path.startsWith("/api/operator/")) {
    const ctx = await getActiveContext();
    if (!ctx?.restaurantId) return deny("unauthorized", 401);
    if (mutation && !/\/payments\/|\/shifts\/close|\/subscription\//.test(path)) {
      const restaurant = await db.restaurant.findUnique({ where: { id: ctx.restaurantId }, select: { suspended: true } });
      if (restaurant?.suspended && ctx.session.user.role !== "platform_admin") return deny("restaurant_suspended");
    }
  }
  const match = path.match(/^\/api\/tenant\/([^/]+)\/(.*)$/);
  if (!match || match[2] === "guest" || match[2] === "events") return null;
  const [, slug, action] = match;
  const tenant = await db.restaurant.findUnique({ where: { slug: decodeURIComponent(slug) }, select: { id: true, suspended: true, enabledPaymentMethods: true } });
  if (!tenant) return deny("not_found", 404);
  if (tenant.suspended && mutation && /^(orders$|pickup\/orders|reservations$)/.test(action)) return deny("restaurant_suspended");
  const body = mutation ? await req.clone().json().catch(() => ({})) : {};
  if (mutation && (action === "pay" || action.startsWith("pay/") || action === "pickup/orders")) {
    const method = action === "pay/terminal-request" ? "kushki_card_terminal" : action === "pay/external-terminal-request" ? "external_terminal" : action === "pay/kushki-pse-init" ? "kushki_pse" : body?.method === "demo_cash" ? "cash" : body?.method;
    if (typeof method === "string" && !method.startsWith("demo_") && !resolveEnabledPaymentMethods(tenant.enabledPaymentMethods).includes(method as PaymentMethodSlug)) return deny("method_disabled");
  }
  let orderId: unknown = action.match(/^orders\/([^/]+)/)?.[1] ?? body?.orderId;
  if (action.startsWith("payment/") || action.startsWith("terminal/")) {
    const paymentId = action.startsWith("payment/") ? action.split("/")[1] : body?.paymentId;
    if (typeof paymentId !== "string") return deny("invalid_payment", 400);
    const p = await db.payment.findUnique({ where: { id: paymentId }, select: { orderId: true } });
    orderId = p?.orderId;
    if (!orderId) return deny("not_found", 404);
  }
  if (action.startsWith("order-items/") || action === "ratings") {
    const itemId = action.startsWith("order-items/") ? action.split("/")[1] : body?.orderItemId;
    if (typeof itemId !== "string") return deny("invalid_item", 400);
    const item = await db.orderItem.findUnique({ where: { id: itemId }, select: { orderId: true } });
    orderId = item?.orderId;
    if (!orderId) return deny("not_found", 404);
  }
  if (typeof orderId === "string" && !await canAccessOrder(tenant.id, orderId)) return deny("forbidden");
  if (action === "orders" && (typeof body?.tableId !== "string" || !await canAccessTable(tenant.id, body.tableId))) return deny("forbidden");
  // Financial actions must have an order even when the payload is malformed.
  if ((/^pay\//.test(action) && !["pay/pse-banks"].includes(action) || action === "pay") && typeof orderId !== "string") return deny("invalid_order", 400);
  return null;
}

/** Request correlation, authorization and bounded public work in one entry point. */
export function secureApi<R extends Request, Args extends unknown[]>(handler: (req: R, ...args: Args) => Promise<Response>) {
  return async (req: R, ...args: Args): Promise<Response> => {
    const requestId = randomUUID();
    const started = Date.now();
    try {
      const response = await guard(req) ?? await handler(req, ...args);
      response.headers.set("X-Request-Id", requestId);
      if (response.status >= 500 || Date.now() - started > 2000) console.warn("api_request", { requestId, path: new URL(req.url).pathname, status: response.status, durationMs: Date.now() - started });
      return response;
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const conflict = /operation_conflict|amount_exceeds_outstanding|order_closed|payment_amounts_valid|Unique constraint|deadlock|write conflict/.test(message);
      console.error("api_failed", { requestId, path: new URL(req.url).pathname, error: error instanceof Error ? error.name : "unknown" });
      return NextResponse.json({ error: conflict ? "operation_conflict" : "internal_error", requestId }, { status: conflict ? 409 : 500, headers: { "X-Request-Id": requestId } });
    }
  };
}
