// Auditoría de los conceptos de retención (Contabilidad › Impuestos): quién
// creó, editó o borró qué concepto, con el antes y el después. El resumen
// es para /admin/audit, en español como el resto de esa bitácora.
import { recordAuditEvent } from "@/lib/auditLog";
import { formatNumber } from "@/lib/format";
import type { ConceptMutationResult } from "./retenciones";

const KIND_LABEL: Record<string, string> = {
  retefuente: "retefuente",
  reteiva: "reteIVA",
  reteica: "reteICA",
};

/** 25,000 ppm → «2.5 %»; la reteICA, por mil: 4,140 ppm → «4.14 ‰». */
export function auditRateText(kind: string, ratePpm: number): string {
  const n = kind === "reteica" ? ratePpm / 1_000 : ratePpm / 10_000;
  return `${formatNumber(n, { maximumFractionDigits: 4 })} ${kind === "reteica" ? "‰" : "%"}`;
}

export async function auditConceptChange(
  restaurantId: string,
  action: "create" | "update" | "delete",
  result: Extract<ConceptMutationResult, { ok: true }>,
): Promise<void> {
  const c = result.concept;
  const verb = action === "create" ? "Creó" : action === "update" ? "Editó" : "Borró";
  const changed =
    action === "update" && result.before && result.after
      ? Object.keys(result.after).filter(
          (k) =>
            (result.before as Record<string, unknown>)[k] !== (result.after as Record<string, unknown>)[k],
        )
      : [];
  await recordAuditEvent({
    kind: `retention_concept.${action}`,
    restaurantId,
    target: { type: "retention_concept", id: c.id },
    summary:
      `${verb} el concepto de ${KIND_LABEL[c.kind] ?? c.kind} «${c.name}» (${auditRateText(c.kind, c.ratePpm)})` +
      (changed.length ? ` — cambió: ${changed.join(", ")}` : ""),
    diff: {
      ...(result.before ? { before: result.before } : {}),
      ...(result.after ? { after: result.after } : {}),
    },
  });
}
