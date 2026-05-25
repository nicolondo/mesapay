// Helper: which Kushki Smart POS does the current user "carry"?
//
// Smart POS terminals are persistent objects in the DB (TerminalDevice).
// Operators tie each device to a specific mesero in
// /operator/settings/datafonos. When that mesero starts a charge from
// the pay flow, the system should push directly to THEIR device — no
// need to bounce through Salón and pick a device manually.

import { db } from "@/lib/db";

export type AssignedDevice = {
  // Internal TerminalDevice.id
  id: string;
  // The id the Kushki API understands (what /terminal/charge expects
  // in `deviceId`).
  kushkiDeviceId: string;
  label: string;
};

/**
 * Resolve the active TerminalDevice assigned to the given user, scoped
 * to a restaurant. Returns null if no assignment / device inactive.
 */
export async function getAssignedDevice(
  userId: string,
  restaurantId: string,
): Promise<AssignedDevice | null> {
  const device = await db.terminalDevice.findFirst({
    where: {
      assignedUserId: userId,
      restaurantId,
      active: true,
    },
    select: { id: true, kushkiDeviceId: true, label: true },
  });
  return device ?? null;
}
