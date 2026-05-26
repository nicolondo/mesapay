// Catálogo de planes — los planes mismos son enum (trial/basic/pro)
// pero su nombre comercial, precio sugerido, descripción, features y
// visibilidad viven en DB para que el admin los pueda editar desde
// /admin/plans sin tocar código.
//
// Self-seed: la primera lectura del catálogo (en producción o local)
// crea las 3 filas con los defaults históricos si no existen. Esto
// evita un step manual de seed post-migración y lo hace idempotente.

import type { Plan } from "@prisma/client";
import { db } from "./db";

export type PlanCatalogEntry = {
  tier: Plan;
  name: string;
  description: string | null;
  defaultPriceCents: number;
  features: string[];
  visible: boolean;
  sortOrder: number;
};

// Defaults usados en el seed inicial y como fallback si por alguna
// razón el catálogo está incompleto. Mismo orden histórico (trial →
// basic → pro) con los precios que estaban hardcoded en BillingPanel.
const DEFAULTS: PlanCatalogEntry[] = [
  {
    tier: "trial",
    name: "Prueba",
    description: "30 días para probar MESAPAY sin compromiso.",
    defaultPriceCents: 0,
    features: [
      "Hasta 5 mesas",
      "Menú digital + QR",
      "Cobro con datáfono y efectivo",
    ],
    visible: true,
    sortOrder: 0,
  },
  {
    tier: "basic",
    name: "Básico",
    description: "Para restaurantes pequeños o que arrancan.",
    defaultPriceCents: 20_000_000,
    features: [
      "Mesas ilimitadas",
      "Cocina + bar + mesero PWA",
      "Cobro con Apple Pay y datáfono",
      "Facturación electrónica básica",
    ],
    visible: true,
    sortOrder: 1,
  },
  {
    tier: "pro",
    name: "Pro",
    description: "Para operaciones medianas y grandes.",
    defaultPriceCents: 40_000_000,
    features: [
      "Todo lo del plan Básico",
      "Wallet + dispersiones automáticas",
      "Múltiples estaciones de cocina/bar",
      "Reportes avanzados y soporte prioritario",
    ],
    visible: true,
    sortOrder: 2,
  },
];

/**
 * Devuelve el catálogo completo, ordenado por sortOrder. Self-seedea
 * en la primera invocación si la tabla está vacía.
 */
export async function getPlanCatalog(): Promise<PlanCatalogEntry[]> {
  const rows = await db.planConfig.findMany({
    orderBy: { sortOrder: "asc" },
  });
  if (rows.length === 0) {
    await seedDefaults();
    const seeded = await db.planConfig.findMany({
      orderBy: { sortOrder: "asc" },
    });
    return seeded.map(toEntry);
  }
  // Si la tabla existe pero le falta algún tier (raro, p.ej. alguien
  // borró una fila), upserteamos los que falten para mantener los
  // 3 tiers visibles. Es defensivo — un solo SQL extra.
  const have = new Set(rows.map((r) => r.tier));
  const missing = DEFAULTS.filter((d) => !have.has(d.tier));
  if (missing.length > 0) {
    for (const d of missing) {
      await db.planConfig.upsert({
        where: { tier: d.tier },
        create: {
          tier: d.tier,
          name: d.name,
          description: d.description,
          defaultPriceCents: d.defaultPriceCents,
          features: d.features,
          visible: d.visible,
          sortOrder: d.sortOrder,
        },
        update: {},
      });
    }
    const all = await db.planConfig.findMany({
      orderBy: { sortOrder: "asc" },
    });
    return all.map(toEntry);
  }
  return rows.map(toEntry);
}

/**
 * Lookup rápido por tier (devuelve fallback de DEFAULTS si por
 * alguna razón no existe — defensivo). Útil cuando un componente
 * necesita solo un plan específico.
 */
export async function getPlanByTier(tier: Plan): Promise<PlanCatalogEntry> {
  const row = await db.planConfig.findUnique({ where: { tier } });
  if (row) return toEntry(row);
  const fallback = DEFAULTS.find((d) => d.tier === tier);
  if (!fallback) {
    // Esto no debería pasar — el enum Prisma garantiza que solo
    // entran valores conocidos. Si llega acá, devuelvo algo mínimo.
    return {
      tier,
      name: tier,
      description: null,
      defaultPriceCents: 0,
      features: [],
      visible: true,
      sortOrder: 99,
    };
  }
  return fallback;
}

/**
 * Actualiza un plan. Solo el admin lo llama (vía /api/admin/plans).
 * No deja modificar `tier` — la PK lógica es inmutable.
 */
export async function updatePlan(
  tier: Plan,
  patch: Partial<Omit<PlanCatalogEntry, "tier">>,
): Promise<PlanCatalogEntry> {
  const updated = await db.planConfig.upsert({
    where: { tier },
    create: {
      tier,
      name: patch.name ?? DEFAULTS.find((d) => d.tier === tier)?.name ?? tier,
      description: patch.description ?? null,
      defaultPriceCents: patch.defaultPriceCents ?? 0,
      features: patch.features ?? [],
      visible: patch.visible ?? true,
      sortOrder:
        patch.sortOrder ??
        DEFAULTS.find((d) => d.tier === tier)?.sortOrder ??
        99,
    },
    update: {
      ...(patch.name !== undefined && { name: patch.name }),
      ...(patch.description !== undefined && {
        description: patch.description,
      }),
      ...(patch.defaultPriceCents !== undefined && {
        defaultPriceCents: patch.defaultPriceCents,
      }),
      ...(patch.features !== undefined && { features: patch.features }),
      ...(patch.visible !== undefined && { visible: patch.visible }),
      ...(patch.sortOrder !== undefined && { sortOrder: patch.sortOrder }),
    },
  });
  return toEntry(updated);
}

async function seedDefaults() {
  await db.$transaction(
    DEFAULTS.map((d) =>
      db.planConfig.upsert({
        where: { tier: d.tier },
        create: {
          tier: d.tier,
          name: d.name,
          description: d.description,
          defaultPriceCents: d.defaultPriceCents,
          features: d.features,
          visible: d.visible,
          sortOrder: d.sortOrder,
        },
        update: {},
      }),
    ),
  );
}

function toEntry(row: {
  tier: Plan;
  name: string;
  description: string | null;
  defaultPriceCents: number;
  features: unknown;
  visible: boolean;
  sortOrder: number;
}): PlanCatalogEntry {
  // `features` viene como Json — parseamos defensivamente para
  // que el caller siempre vea string[].
  let features: string[] = [];
  if (Array.isArray(row.features)) {
    features = row.features.filter((f): f is string => typeof f === "string");
  }
  return {
    tier: row.tier,
    name: row.name,
    description: row.description,
    defaultPriceCents: row.defaultPriceCents,
    features,
    visible: row.visible,
    sortOrder: row.sortOrder,
  };
}
