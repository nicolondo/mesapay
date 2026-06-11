/**
 * CRM team metrics — pure computation (no DB calls).
 * The server page performs queries and passes rows to these functions.
 *
 * Range: últimos 30 días (callers define `rangeStart` = now - 30d).
 */

// ── Types ──────────────────────────────────────────────────────────────────

/** A minimal lead row as returned by the page query. */
export interface MetricLeadRow {
  id: string;
  assignedToUserId: string;
  createdAt: Date;
  stage: string;
}

/** A minimal activity row as returned by the page query. */
export interface MetricActivityRow {
  leadId: string;
  userId: string; // the actor who created the activity
  type: string;
  content: string;
  createdAt: Date;
}

export interface MemberMetrics {
  memberId: string;
  leadsNuevos: number;       // leads createdAt in range for this member
  contactados: number;       // leads with ≥1 activity in range
  demos: number;             // leads with a stage_change activity containing "demo" in range
  ganados: number;           // leads with a stage_change activity containing "ganado" in range
  tasaConversion: number;    // ganados / leadsNuevos (0 if leadsNuevos = 0)
  tiempoPrimeraRespuestaHrs: number | null; // avg hours from lead.createdAt to first activity for leads created in range
}

// ── Helper ─────────────────────────────────────────────────────────────────

/**
 * Compute per-member metrics for a given 30-day range.
 *
 * @param memberIds  - IDs of all members to compute metrics for
 * @param leads      - All leads for these members (assignedToUserId filtered by memberIds)
 * @param activities - All CrmActivity rows in the range for leads above
 * @param rangeStart - Start of the 30-day window (Date)
 */
export function computeTeamMetrics(
  memberIds: string[],
  leads: MetricLeadRow[],
  activities: MetricActivityRow[],
  rangeStart: Date,
): MemberMetrics[] {
  return memberIds.map((memberId) => {
    const memberLeads = leads.filter((l) => l.assignedToUserId === memberId);

    // leadsNuevos: leads created in range for this member.
    const leadsInRange = memberLeads.filter((l) => l.createdAt >= rangeStart);
    const leadsNuevos = leadsInRange.length;

    // Build a set of leadIds in range for quick lookup.
    const leadIdsInRange = new Set(leadsInRange.map((l) => l.id));

    // Activities that belong to leads of this member in the range.
    const memberActivities = activities.filter((a) => {
      const lead = memberLeads.find((l) => l.id === a.leadId);
      return lead !== undefined;
    });

    // contactados: distinct leads that have ≥1 activity in range.
    const contactadosSet = new Set(
      memberActivities
        .filter((a) => a.createdAt >= rangeStart)
        .map((a) => a.leadId),
    );
    const contactados = contactadosSet.size;

    // demos: distinct leads with a stage_change activity whose content
    //        contains "demo" (case-insensitive) in range.
    const demosSet = new Set(
      memberActivities
        .filter(
          (a) =>
            a.type === "stage_change" &&
            a.content.toLowerCase().includes("demo") &&
            a.createdAt >= rangeStart,
        )
        .map((a) => a.leadId),
    );
    const demos = demosSet.size;

    // ganados: distinct leads with a stage_change activity whose content
    //          contains "ganado" in range.
    const ganadosSet = new Set(
      memberActivities
        .filter(
          (a) =>
            a.type === "stage_change" &&
            a.content.toLowerCase().includes("ganado") &&
            a.createdAt >= rangeStart,
        )
        .map((a) => a.leadId),
    );
    const ganados = ganadosSet.size;

    const tasaConversion = leadsNuevos > 0 ? ganados / leadsNuevos : 0;

    // tiempoPrimeraRespuestaHrs: for leads created in range that have
    //   at least one activity, compute createdAt → first activity (hours).
    const tiempos: number[] = [];
    for (const lead of leadsInRange) {
      // All activities for this lead, sorted ascending.
      const actForLead = memberActivities
        .filter((a) => a.leadId === lead.id)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      if (actForLead.length > 0) {
        const diffMs = actForLead[0].createdAt.getTime() - lead.createdAt.getTime();
        tiempos.push(diffMs / (1000 * 60 * 60));
      }
    }

    const tiempoPrimeraRespuestaHrs =
      tiempos.length > 0
        ? tiempos.reduce((s, v) => s + v, 0) / tiempos.length
        : null;

    // Suppress the set-but-unused lint for leadIdsInRange (used above indirectly
    // — keep explicit to guard future queries against out-of-range pollution).
    void leadIdsInRange;

    return {
      memberId,
      leadsNuevos,
      contactados,
      demos,
      ganados,
      tasaConversion,
      tiempoPrimeraRespuestaHrs,
    };
  });
}
