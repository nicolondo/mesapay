import { getDiner } from "@/lib/dinerSession";
import { secureApi } from "@/lib/secureApi";
import { db } from "@/lib/db";
import { subscribeTenant } from "@/lib/events";
import { staffForRestaurant } from "@/lib/staffAccess";
import { guestScopes } from "@/lib/guestAccess";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function GETHandler(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const tenant = await db.restaurant.findUnique({ where: { slug }, select: { id: true } });
  if (!tenant) return new Response(null, { status: 404 });
  const staff = await staffForRestaurant(tenant.id);
  const scopes = staff ? [] : await guestScopes(tenant.id);
  const diner = staff ? null : await getDiner(tenant.id);
  if (!staff && !diner && !scopes.length) return new Response(null, { status: 403 });
  const permitted = new Set<string>();
  if (!staff) {
    const orders = await db.order.findMany({ where: { restaurantId: tenant.id, OR: [...(diner ? [{ dinerId: diner.id }] : []), ...scopes.flatMap(s => [
      ...(s.orderId ? [{ id: s.orderId }] : []),
      ...(s.tableId ? [{ tableId: s.tableId, orderType: "dineIn" as const }] : []),
    ])] }, select: { id: true } });
    for (const order of orders) permitted.add(order.id);
  }
  let cleanup = () => {};
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const send = (data: unknown) => { if (!closed) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`)); };
      send({ type: "hello" });
      const unsubscribe = subscribeTenant(tenant.id, event => {
        if (staff || ("orderId" in event && permitted.has(event.orderId))) send(event);
      });
      const heartbeat = setInterval(() => { if (!closed) controller.enqueue(new TextEncoder().encode(": ping\n\n")); }, 15_000);
      // Reconnect rechecks session revocation and guest expiry. No permanent grants.
      const expiresIn = staff || diner ? 55_000 : Math.max(1, Math.min(55_000, ...scopes.map(s => s.expires - Date.now())));
      const expire = setTimeout(() => { cleanup(); controller.close(); }, expiresIn);
      cleanup = () => { if (closed) return; closed = true; clearInterval(heartbeat); clearTimeout(expire); unsubscribe(); req.signal.removeEventListener("abort", abort); };
      const abort = () => { cleanup(); try { controller.close(); } catch { /* already cancelled */ } };
      req.signal.addEventListener("abort", abort, { once: true });
      if (req.signal.aborted) abort();
    },
    cancel() { cleanup(); },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store, no-transform", "x-accel-buffering": "no" } });
}
export const GET = secureApi(GETHandler);
