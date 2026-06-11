import type { LeadCard } from "@/app/comercial/crm/CrmPipelineClient";

/**
 * Returns a new leads array with the given lead's stage changed.
 * Pure function — does not mutate input.
 */
export function applyDrop(
  leads: LeadCard[],
  leadId: string,
  _fromStage: string,
  toStage: string,
): LeadCard[] {
  return leads.map((l) => (l.id === leadId ? { ...l, stage: toStage } : l));
}

/**
 * Updates stage count record when a lead moves stages.
 * Pure function — does not mutate input.
 */
export function applyDropCounts(
  counts: Record<string, number>,
  fromStage: string,
  toStage: string,
): Record<string, number> {
  const next = { ...counts };
  next[fromStage] = Math.max(0, (next[fromStage] ?? 0) - 1);
  next[toStage] = (next[toStage] ?? 0) + 1;
  return next;
}
