// Retenciones colombianas (retefuente / reteIVA / reteICA) — port del núcleo
// de zenith-erp adaptado a Prisma. Los CONCEPTOS viven por comercio
// (RetentionConcept): tarifa, base subtotal o impuesto y umbral en UVT. El
// cálculo es puro (retencionesCore.ts, lo usa también el cliente); la
// siembra, la config y el alta/edición/baja de conceptos usan la BD.
import { db } from "@/lib/db";
import { ensureChartOfAccounts } from "./ledger";
import {
  RETENTION_ACCOUNT_PREFIX,
  retentionCatalogEntry,
} from "./retencionesCatalogo";
import {
  UVT_DEFAULT_CENTS,
  baseForKind,
  conceptRateBps,
  conceptRatePpm,
  isRetentionKind,
  rateColumns,
  validateConceptFields,
  type ConceptFieldError,
  type RetentionConceptInput,
  type RetentionKind,
} from "./retencionesCore";

export {
  UVT_DEFAULT_CENTS,
  computeRetentions,
  type RetentionConceptInput,
  type RetentionKind,
  type RetentionLine,
  type RetentionResult,
} from "./retencionesCore";

/**
 * Set estándar sembrado INACTIVO — el contador activa lo que aplique al
 * régimen del comercio (la mayoría de restaurantes pequeños no son agentes
 * retenedores). Cifras del catálogo del año (`retencionesCatalogo.ts`):
 * compras 10 UVT y servicios 2 UVT desde el Decreto 572 de 2025. La reteICA
 * depende del municipio: va una de referencia para editar.
 */
/** Cuenta de cada tipo que trae el plan base (PUC NIIF de MESAPAY). */
export const RETENTION_ACCOUNT_DEFAULT: Record<RetentionKind, string> = {
  retefuente: "236505",
  reteiva: "236705",
  reteica: "236805",
};

type SeedConcept = Omit<RetentionConceptInput, "id"> & { ratePpm: number; catalogKey: string | null };

const seed = (key: string, name: string): SeedConcept => {
  const e = retentionCatalogEntry(key)!;
  return {
    kind: e.kind,
    name,
    ...rateColumns(e.ratePpm!),
    base: e.base,
    thresholdUvt: e.thresholdUvt,
    accountCode: RETENTION_ACCOUNT_DEFAULT[e.kind],
    catalogKey: e.key,
  };
};

export const DEFAULT_RETENTION_CONCEPTS: SeedConcept[] = [
  seed("compras_declarante", "Compras (2,5%)"),
  seed("servicios_declarante", "Servicios (4%)"),
  seed("arrendamiento_inmuebles", "Arrendamientos (3,5%)"),
  seed("reteiva_compras", "ReteIVA (15% del IVA)"),
  {
    kind: "reteica",
    name: "ReteICA (7×1.000)",
    ...rateColumns(7_000),
    base: "subtotal",
    thresholdUvt: 0,
    accountCode: "236805",
    catalogKey: null,
  },
];

/**
 * Siembra el set estándar UNA vez por comercio: la marca queda en
 * `AccountingConfig.retentionConceptsSeededAt`, así que borrar todos los
 * conceptos no los vuelve a crear. Un candado por comercio evita la doble
 * siembra cuando compras y gastos piden el contexto a la vez.
 */
async function ensureRetentionConceptsSeeded(restaurantId: string): Promise<void> {
  const cfg = await db.accountingConfig.findUnique({
    where: { restaurantId },
    select: { retentionConceptsSeededAt: true },
  });
  if (cfg?.retentionConceptsSeededAt) return;
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`retention-seed:${restaurantId}`}, 0))`;
    const count = await tx.retentionConcept.count({ where: { restaurantId } });
    if (count === 0) {
      await tx.retentionConcept.createMany({
        data: DEFAULT_RETENTION_CONCEPTS.map((c) => ({ restaurantId, ...c })),
      });
    }
    await tx.accountingConfig.upsert({
      where: { restaurantId },
      create: { restaurantId, uvtCents: UVT_DEFAULT_CENTS, retentionConceptsSeededAt: new Date() },
      update: { retentionConceptsSeededAt: new Date() },
    });
  });
}

/**
 * Conceptos del comercio (sembrando el set estándar la primera vez), con la
 * tarifa EFECTIVA en `rateBps` (puede tener decimales: 4,14 ‰ = 41,4 bps)
 * y la exacta en `ratePpm`.
 */
export async function loadRetentionConcepts(restaurantId: string) {
  await ensureRetentionConceptsSeeded(restaurantId);
  const rows = await db.retentionConcept.findMany({
    where: { restaurantId },
    orderBy: [{ kind: "asc" }, { name: "asc" }],
  });
  return rows.map((r) => ({ ...r, rateBps: conceptRateBps(r), ratePpm: conceptRatePpm(r) }));
}

export type RetentionConceptDto = Awaited<ReturnType<typeof loadRetentionConcepts>>[number] & {
  /** Gastos (y plantillas) que lo usan: con alguno no se puede borrar. */
  usedCount: number;
};

/** Conceptos + cuántos gastos usa cada uno (la pantalla de configuración). */
export async function loadRetentionConceptsWithUsage(restaurantId: string): Promise<RetentionConceptDto[]> {
  const concepts = await loadRetentionConcepts(restaurantId);
  const usage = concepts.length
    ? await db.expenseRetention.groupBy({
        by: ["conceptId"],
        where: { conceptId: { in: concepts.map((c) => c.id) } },
        _count: { _all: true },
      })
    : [];
  const byId = new Map(usage.map((u) => [u.conceptId, u._count._all]));
  return concepts.map((c) => ({ ...c, usedCount: byId.get(c.id) ?? 0 }));
}

export type RetentionAccountOption = { code: string; name: string; kind: RetentionKind };

/**
 * Cuentas que puede llevar un concepto: las imputables y activas del plan
 * del comercio bajo 2365 (retefuente), 2367 (reteIVA) o 2368 (reteICA).
 */
export async function loadRetentionAccounts(restaurantId: string): Promise<RetentionAccountOption[]> {
  await ensureChartOfAccounts(restaurantId);
  const rows = await db.ledgerAccount.findMany({
    where: {
      restaurantId,
      active: true,
      postable: true,
      OR: Object.values(RETENTION_ACCOUNT_PREFIX).map((p) => ({ code: { startsWith: p } })),
    },
    orderBy: { code: "asc" },
    select: { code: true, name: true },
  });
  const out: RetentionAccountOption[] = [];
  for (const r of rows) {
    const kind = (Object.entries(RETENTION_ACCOUNT_PREFIX) as [RetentionKind, string][]).find(([, p]) =>
      r.code.startsWith(p),
    )?.[0];
    if (kind) out.push({ code: r.code, name: r.name, kind });
  }
  return out;
}

// ── Crear / editar / borrar ──────────────────────────────────────────────

export type ConceptMutationError =
  | ConceptFieldError
  | "catalog_invalid"
  | "not_found"
  | "concept_in_use";

/** HTTP de cada error: no existe 404; nombre repetido o usado 409; lo demás 400. */
export function conceptErrorStatus(error: ConceptMutationError): number {
  if (error === "not_found") return 404;
  if (error === "name_taken" || error === "concept_in_use") return 409;
  return 400;
}

export type ConceptCreateInput = {
  kind: string;
  name: string;
  ratePpm: number;
  thresholdUvt: number;
  accountCode: string;
  active: boolean;
  /** Del catálogo: su clave (tipo y año se validan); null = personalizado. */
  catalogKey: string | null;
};

export type ConceptPatchInput = Partial<{
  name: string;
  ratePpm: number;
  thresholdUvt: number;
  accountCode: string;
  active: boolean;
}>;

type ConceptRow = Awaited<ReturnType<typeof loadRetentionConcepts>>[number];

async function validationContext(restaurantId: string, kind: string, exceptId: string | null) {
  const [others, accounts] = await Promise.all([
    db.retentionConcept.findMany({
      where: { restaurantId, ...(exceptId ? { id: { not: exceptId } } : {}) },
      select: { kind: true, name: true },
    }),
    loadRetentionAccounts(restaurantId),
  ]);
  return { others, allowedAccounts: accounts.filter((a) => a.kind === kind).map((a) => a.code) };
}

/** Lo que se guarda de un concepto, para la auditoría. */
function snapshot(c: { kind: string; name: string; ratePpm: number; base: string; thresholdUvt: number; accountCode: string; active: boolean; catalogKey: string | null }) {
  return {
    kind: c.kind,
    name: c.name,
    ratePpm: c.ratePpm,
    base: c.base,
    thresholdUvt: c.thresholdUvt,
    accountCode: c.accountCode,
    active: c.active,
    catalogKey: c.catalogKey,
  };
}

export type ConceptMutationResult =
  | { ok: true; concept: ConceptRow; before?: ReturnType<typeof snapshot>; after: ReturnType<typeof snapshot> | null }
  | { ok: false; error: ConceptMutationError };

/**
 * Crea un concepto del catálogo o personalizado. La base la fija el tipo
 * (reteIVA sobre el IVA); el resto lo valida `validateConceptFields`.
 */
export async function createRetentionConcept(
  restaurantId: string,
  input: ConceptCreateInput,
): Promise<ConceptMutationResult> {
  if (!isRetentionKind(input.kind)) return { ok: false, error: "kind_invalid" };
  if (input.catalogKey !== null) {
    const entry = retentionCatalogEntry(input.catalogKey);
    if (!entry || entry.kind !== input.kind) return { ok: false, error: "catalog_invalid" };
  }
  await ensureRetentionConceptsSeeded(restaurantId);
  const fields = {
    kind: input.kind,
    name: input.name.trim().replace(/\s+/g, " "),
    ratePpm: input.ratePpm,
    base: baseForKind(input.kind),
    thresholdUvt: input.thresholdUvt,
    accountCode: input.accountCode,
  };
  const error = validateConceptFields(fields, await validationContext(restaurantId, input.kind, null));
  if (error) return { ok: false, error };
  const created = await db.retentionConcept.create({
    data: {
      restaurantId,
      kind: fields.kind,
      name: fields.name,
      ...rateColumns(fields.ratePpm),
      base: fields.base,
      thresholdUvt: fields.thresholdUvt,
      accountCode: fields.accountCode,
      active: input.active,
      catalogKey: input.catalogKey,
      isCustom: input.catalogKey === null,
    },
  });
  const concept = { ...created, rateBps: conceptRateBps(created), ratePpm: conceptRatePpm(created) };
  return { ok: true, concept, after: snapshot(concept) };
}

/**
 * Edita un concepto (nombre, tarifa, umbral, cuenta, activo). El tipo no
 * cambia: lo ya retenido está en su cuenta y en sus reportes. Los gastos ya
 * guardados conservan su foto (nombre, tarifa y cuenta del momento).
 */
export async function updateRetentionConcept(
  restaurantId: string,
  id: string,
  patch: ConceptPatchInput,
): Promise<ConceptMutationResult> {
  const row = await db.retentionConcept.findFirst({ where: { id, restaurantId } });
  if (!row) return { ok: false, error: "not_found" };
  const current = { ...row, ratePpm: conceptRatePpm(row) };
  const next = {
    kind: current.kind,
    name: patch.name !== undefined ? patch.name.trim().replace(/\s+/g, " ") : current.name,
    ratePpm: patch.ratePpm ?? current.ratePpm,
    base: current.base,
    thresholdUvt: patch.thresholdUvt ?? current.thresholdUvt,
    accountCode: patch.accountCode ?? current.accountCode,
  };
  // Sólo se valida lo que cambia: un concepto viejo (p. ej. con una cuenta
  // que el plan ya no tiene) se puede activar o desactivar sin arreglarlo.
  const touched = (["name", "ratePpm", "thresholdUvt", "accountCode"] as const).some((k) => patch[k] !== undefined);
  if (touched) {
    const ctx = await validationContext(restaurantId, current.kind, id);
    const error = validateConceptFields(
      { ...next, base: baseForKind(current.kind) },
      {
        others: patch.name !== undefined ? ctx.others : [],
        allowedAccounts:
          patch.accountCode !== undefined ? ctx.allowedAccounts : [...ctx.allowedAccounts, current.accountCode],
      },
    );
    // La base de un concepto anterior al catálogo puede no seguir la regla
    // del tipo: no es lo que se está editando.
    if (error && error !== "base_invalid") return { ok: false, error };
  }
  const updated = await db.retentionConcept.update({
    where: { id },
    data: {
      ...(patch.name !== undefined && { name: next.name }),
      ...(patch.ratePpm !== undefined && rateColumns(next.ratePpm)),
      ...(patch.thresholdUvt !== undefined && { thresholdUvt: next.thresholdUvt }),
      ...(patch.accountCode !== undefined && { accountCode: next.accountCode }),
      ...(patch.active !== undefined && { active: patch.active }),
    },
  });
  const concept = { ...updated, rateBps: conceptRateBps(updated), ratePpm: conceptRatePpm(updated) };
  return { ok: true, concept, before: snapshot(current), after: snapshot(concept) };
}

/**
 * Borra un concepto que NUNCA se usó. Si algún gasto (o plantilla de gasto
 * recurrente) lo lleva, no se borra: se desactiva («concept_in_use»).
 */
export async function deleteRetentionConcept(restaurantId: string, id: string): Promise<ConceptMutationResult> {
  const row = await db.retentionConcept.findFirst({ where: { id, restaurantId } });
  if (!row) return { ok: false, error: "not_found" };
  const used = await db.expenseRetention.count({ where: { conceptId: id } });
  if (used > 0) return { ok: false, error: "concept_in_use" };
  await db.retentionConcept.delete({ where: { id } });
  const concept = { ...row, rateBps: conceptRateBps(row), ratePpm: conceptRatePpm(row) };
  return { ok: true, concept, before: snapshot(concept), after: null };
}
