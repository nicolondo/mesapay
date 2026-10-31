// Corrida diaria de los asientos contables (cron accounting-daily): recorre
// los comercios con el módulo de contabilidad y regenera sus meses abiertos.
// Lo dispara docs/cron/mesapay-accounting-daily.timer a las 05:30 hora de
// Colombia, después del corte del día operativo (05:00).
import { db } from "@/lib/db";
import { isModuleEnabled } from "@/lib/modules";
import {
  DAILY_LOCK_WAIT_MS,
  type MonthOutcome,
  regenerateOpenMonths,
} from "./autoJournal";

/**
 * Tope para EMPEZAR un comercio nuevo. nginx corta la respuesta a los 600 s
 * (proxy_read_timeout); con 8 minutos queda margen para el comercio que esté
 * en curso. Lo que no alcanzó sale como `pending` y entra al día siguiente.
 */
export const DAILY_BUDGET_MS = 8 * 60_000;

type RestaurantRun = {
  restaurantId: string;
  status: "done" | "busy" | "failed";
  months: Array<{ month: string; status: MonthOutcome["status"]; entries?: number; error?: string }>;
  error?: string;
};

export type DailyAccountingSummary = {
  restaurants: number;
  done: number;
  busy: number;
  failed: number;
  pending: number;
  truncated: boolean;
  months: { ok: number; error: number; numbered: number; closed: number; invalid: number };
  ms: number;
  runs: RestaurantRun[];
};

function compact(m: MonthOutcome): RestaurantRun["months"][number] {
  if (m.status === "ok") return { month: m.month, status: m.status, entries: m.results.length };
  if (m.status === "error") return { month: m.month, status: m.status, error: m.error };
  return { month: m.month, status: m.status };
}

/**
 * Comercios con el módulo `accounting`, no suspendidos (los eliminados ya no
 * existen: el borrado quita la fila). Uno por uno, con tope de tiempo. Un
 * comercio que falla se loguea y no frena a los demás.
 */
export async function runDailyAccounting(
  opts: { now?: Date; budgetMs?: number } = {},
): Promise<DailyAccountingSummary> {
  const started = Date.now();
  const now = opts.now ?? new Date();
  const budgetMs = opts.budgetMs ?? DAILY_BUDGET_MS;
  const rows = await db.restaurant.findMany({
    where: { suspended: false },
    select: { id: true, enabledModules: true },
    orderBy: { createdAt: "asc" },
  });
  const eligible = rows.filter((r) => isModuleEnabled(r.enabledModules, "accounting"));

  const summary: DailyAccountingSummary = {
    restaurants: eligible.length,
    done: 0,
    busy: 0,
    failed: 0,
    pending: 0,
    truncated: false,
    months: { ok: 0, error: 0, numbered: 0, closed: 0, invalid: 0 },
    ms: 0,
    runs: [],
  };

  for (let i = 0; i < eligible.length; i++) {
    if (Date.now() - started >= budgetMs) {
      summary.truncated = true;
      summary.pending = eligible.length - i;
      break;
    }
    const restaurantId = eligible[i]!.id;
    try {
      const run = await regenerateOpenMonths(restaurantId, now, { waitMs: DAILY_LOCK_WAIT_MS });
      if (run.status === "busy") {
        summary.busy++;
        summary.runs.push({ restaurantId, status: "busy", months: [] });
        continue;
      }
      summary.done++;
      for (const m of run.months) summary.months[m.status]++;
      summary.runs.push({ restaurantId, status: "done", months: run.months.map(compact) });
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 300);
      summary.failed++;
      summary.runs.push({ restaurantId, status: "failed", months: [], error: message });
      console.error("[cron accounting-daily] el comercio falló", { restaurantId, error: message });
    }
  }

  summary.ms = Date.now() - started;
  // Al log van los totales; el detalle por comercio va en la respuesta.
  console.log("[cron accounting-daily]", JSON.stringify({ ...summary, runs: undefined }));
  return summary;
}
