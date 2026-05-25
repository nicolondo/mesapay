// Web Push helpers for sending native notifications to mesero PWAs.
//
// Each TerminalDevice / mesero PWA registers a PushSubscription via
// /api/push/subscribe; here we send notifications to those endpoints
// signed with our VAPID keypair (env: VAPID_PRIVATE_KEY +
// NEXT_PUBLIC_VAPID_PUBLIC_KEY + VAPID_SUBJECT).
//
// We swallow per-subscription failures so a single broken endpoint
// doesn't take down the rest of a fan-out. On HTTP 404/410 the
// subscription is gone and we delete the row.

import webpush from "web-push";
import { db } from "@/lib/db";
import { env } from "@/lib/env";

let configured = false;

function configure(): boolean {
  if (configured) return true;
  const pub = env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const priv = env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) return false;
  webpush.setVapidDetails(env.VAPID_SUBJECT, pub, priv);
  configured = true;
  return true;
}

export type PushPayload = {
  title: string;
  body: string;
  // Where to land the mesero when they tap the notification.
  url?: string;
  // Optional tag — duplicate notifications with the same tag replace
  // (rather than stack). Use the order id so 5 "datafono pedido"
  // events for the same mesa don't pile up.
  tag?: string;
};

/** Send to every subscription belonging to a user. */
export async function sendPushToUser(
  userId: string,
  payload: PushPayload,
): Promise<{ sent: number; pruned: number }> {
  if (!configure()) return { sent: 0, pruned: 0 };
  const subs = await db.pushSubscription.findMany({ where: { userId } });
  return fanOut(subs, payload);
}

/** Send to every mesero subscription of a restaurant. */
export async function sendPushToMeseros(
  restaurantId: string,
  payload: PushPayload,
): Promise<{ sent: number; pruned: number }> {
  if (!configure()) return { sent: 0, pruned: 0 };
  // Filter by user role to skip subscriptions from operators / kitchen
  // / bar / etc. that also use a PWA but don't want every mesa ping.
  const subs = await db.pushSubscription.findMany({
    where: {
      restaurantId,
      user: { role: "mesero" },
    },
  });
  return fanOut(subs, payload);
}

/**
 * Same as sendPushToMeseros but narrowed to meseros whose
 * assignedTableNumbers include the given table number. Falls back to
 * fan-out across ALL meseros when the table is somehow unassigned to
 * anyone — that matches the "see everything when unassigned" mesero
 * scope rule so notifications follow the same logic.
 */
export async function sendPushToMeserosForTable(
  restaurantId: string,
  tableNumber: number,
  payload: PushPayload,
): Promise<{ sent: number; pruned: number }> {
  if (!configure()) return { sent: 0, pruned: 0 };
  const candidates = await db.user.findMany({
    where: { restaurantId, role: "mesero" },
    select: { id: true, assignedTableNumbers: true },
  });
  // Meseros assigned to this table number. If a mesero has an empty
  // assignment list (= "atiende todas"), they qualify too.
  const matchedUserIds = candidates
    .filter(
      (u) =>
        u.assignedTableNumbers.length === 0 ||
        u.assignedTableNumbers.includes(tableNumber),
    )
    .map((u) => u.id);
  if (matchedUserIds.length === 0) return { sent: 0, pruned: 0 };
  const subs = await db.pushSubscription.findMany({
    where: { userId: { in: matchedUserIds } },
  });
  return fanOut(subs, payload);
}

type Sub = {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

async function fanOut(
  subs: Sub[],
  payload: PushPayload,
): Promise<{ sent: number; pruned: number }> {
  let sent = 0;
  const pruneIds: string[] = [];
  const updatedIds: string[] = [];
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: s.endpoint,
            keys: { p256dh: s.p256dh, auth: s.auth },
          },
          JSON.stringify(payload),
          { TTL: 60 * 60 }, // browser holds for 1h if device is offline
        );
        sent += 1;
        updatedIds.push(s.id);
      } catch (err) {
        // 404 + 410 → subscription expired or unsubscribed by user.
        const status =
          err && typeof err === "object" && "statusCode" in err
            ? (err as { statusCode: number }).statusCode
            : 0;
        if (status === 404 || status === 410) {
          pruneIds.push(s.id);
        } else {
          // Other errors: log + leave it; transient (network blip,
          // 5xx from FCM/APNS) usually clear on the next push.
          console.error("[push] send failed", { id: s.id, status, err });
        }
      }
    }),
  );
  if (pruneIds.length > 0) {
    await db.pushSubscription
      .deleteMany({ where: { id: { in: pruneIds } } })
      .catch(() => undefined);
  }
  if (updatedIds.length > 0) {
    await db.pushSubscription
      .updateMany({
        where: { id: { in: updatedIds } },
        data: { lastUsedAt: new Date() },
      })
      .catch(() => undefined);
  }
  return { sent, pruned: pruneIds.length };
}
