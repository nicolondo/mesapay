/** Shared by server and UI. Restaurant settings cannot override this rule. */
export type PreparationState = {
  menuItemId: string | null;
  kitchenStatus: string;
  preparationStartedAt?: Date | string | null;
  preparationFirstStartedAt?: Date | string | null;
  servedAt?: Date | string | null;
};

export function canCancelPreparedItems(role: string | null | undefined): boolean {
  return role === "operator" || role === "platform_admin" || role === "group_admin";
}

export function hasPreparationStarted(item: PreparationState, tableKind?: string | null): boolean {
  if (item.preparationFirstStartedAt || item.preparationStartedAt) return true;
  // Manual invoices/free charges are born ready/served for accounting.
  if (item.menuItemId === null || tableKind === "manual") return false;
  return item.kitchenStatus !== "placed" || !!item.servedAt;
}

export function cancellationRequiresAdmin(
  role: string | null | undefined, item: PreparationState, tableKind?: string | null,
): boolean {
  return !canCancelPreparedItems(role) && hasPreparationStarted(item, tableKind);
}

export class CancellationPermissionError extends Error {
  constructor() {
    super("cancellation_admin_required");
    this.name = "CancellationPermissionError";
  }
}

/** Invoke after locking the order and rereading its live items. */
export function assertCancellationAllowed(
  role: string | null | undefined, items: readonly PreparationState[], tableKind?: string | null,
): void {
  if (items.some((item) => cancellationRequiresAdmin(role, item, tableKind))) {
    throw new CancellationPermissionError();
  }
}

type PersistedPreparationState = Omit<PreparationState, "preparationStartedAt" | "preparationFirstStartedAt" | "servedAt"> & {
  preparationStartedAt?: Date | null;
  preparationFirstStartedAt?: Date | null;
  servedAt?: Date | null;
};

/** The KDS timer may restart; permission history must never reset. Checking
 * both states protects legacy ready/served dishes when their state is undone. */
export function preparationHistoryData(
  current: PersistedPreparationState, next: Partial<PersistedPreparationState>, now: Date, tableKind?: string | null,
): { preparationFirstStartedAt?: Date } {
  if (current.preparationFirstStartedAt) return {};
  if (!hasPreparationStarted(current, tableKind) && !hasPreparationStarted({ ...current, ...next }, tableKind)) return {};
  return { preparationFirstStartedAt: current.preparationStartedAt ?? current.servedAt ?? now };
}
