// SQL del análisis de ventas: TODAS las sumas se hacen en PostgreSQL.
//
// Reglas de este archivo:
//  · Todo valor que viene de la URL o del comercio va como PARÁMETRO
//    (`Prisma.sql` + `${}`), nunca concatenado al texto.
//  · Toda consulta parte de `salesCtes`, cuyo primer paso exige
//    `o."restaurantId" = $restaurante`: no hay forma de armar una consulta
//    de este módulo sin acotarla por comercio (hay un test que lo verifica).
//  · Las definiciones replican `metrics.ts` (y, por él, el Resumen):
//    `saleFacts` para las cuentas y `allocateLines` para las líneas.
//
// Cadena de CTE:
//   o0  cuentas pagadas del comercio en el rango (+ impuesto congelado)
//   o1  + canal, día de la semana operativo y mesero de la cuenta
//   o   + filtros de cuenta (canal, mesero, mesa, pago, día, hora)
//   fo  cuentas VENDIDAS (no cortesía completa) con su venta neta y los
//       agregados de sus líneas vivas (+ impuesto incluido con tarifa actual)
//   lf  líneas vivas con su parte de la venta neta (Σ líneas = venta neta)
//   f   hechos por cuenta: la cuenta entera o, con filtro de producto o
//       categoría, sólo sus líneas que coinciden
import { Prisma } from "@prisma/client";
import type { RestaurantTax } from "@/lib/salesTax";
import {
  hasItemFilter,
  methodsForFilter,
  NO_WAITER,
  type DimensionFilters,
} from "./filters";
import type { Granularity } from "./period";

export type SalesScope = {
  restaurantId: string;
  /** [start, end) del rango de días operativos. */
  start: Date;
  end: Date;
  cutoffHour: number;
  /** Impuesto ACTUAL del comercio (para las cuentas sin factura). */
  tax: RestaurantTax;
  dims: DimensionFilters;
};

/** El universo de cuentas: por rango de pago o por una lista de cuentas. */
type Universe = { kind: "range" } | { kind: "ids"; ids: readonly string[] };

/**
 * Instante como `timestamp` UTC. Prisma manda los `Date` como `timestamptz`
 * y las columnas son `timestamp(3)` en UTC: sin esta conversión, una base con
 * otra zona horaria de sesión correría el rango cinco horas.
 */
function utc(date: Date): Prisma.Sql {
  return Prisma.sql`(${date}::timestamptz AT TIME ZONE 'UTC')`;
}

/** Tarifa ×100 que entra al SQL (0 si el comercio no cobra impuesto). */
function pctTimes100(tax: RestaurantTax): number {
  return tax.kind !== "none" && tax.pct > 0 ? Math.round(tax.pct * 100) : 0;
}

/**
 * Impuesto CONGELADO de la factura, con la misma tolerancia del Resumen: sólo
 * cuenta si el snapshot dice INC/IVA y trae un entero seguro no negativo; un
 * JSON viejo o malformado vale cero y nunca tumba la consulta (los CASE
 * anidados evitan castear texto que no es número).
 */
const FROZEN_TAX = Prisma.sql`CASE
  WHEN inv."id" IS NULL THEN NULL
  WHEN (inv."snapshot" ->> 'salesTaxKind') IN ('inc', 'iva')
    AND jsonb_typeof(inv."snapshot" -> 'embeddedTaxCents') = 'number'
  THEN CASE
    WHEN (inv."snapshot" ->> 'embeddedTaxCents')::numeric >= 0
      AND (inv."snapshot" ->> 'embeddedTaxCents')::numeric = trunc((inv."snapshot" ->> 'embeddedTaxCents')::numeric)
      AND (inv."snapshot" ->> 'embeddedTaxCents')::numeric <= 9007199254740991
    THEN (inv."snapshot" ->> 'embeddedTaxCents')::numeric
    ELSE 0 END
  ELSE 0 END`;

/** Línea viva: no cancelada y su ronda (si tiene) no está cancelada. */
const LIVE_LINE = Prisma.sql`it."cancelledAt" IS NULL AND (it."roundId" IS NULL OR r."status" <> 'cancelled')`;

/** Línea regalada que su ronda no había tumbado antes (mismo criterio que «No cobrados»). */
const COMP_LINE = Prisma.sql`it."cancellationKind" = 'comp' AND (
  r."id" IS NULL OR r."status" <> 'cancelled' OR r."cancelledAt" IS NULL OR it."cancelledAt" <= r."cancelledAt"
)`;

function orderConditions(scope: SalesScope): Prisma.Sql {
  const d = scope.dims;
  const parts: Prisma.Sql[] = [];
  if (d.canal) parts.push(Prisma.sql`o1."channel" = ${d.canal}`);
  if (d.mesero === NO_WAITER) parts.push(Prisma.sql`o1."waiterId" IS NULL`);
  else if (d.mesero) parts.push(Prisma.sql`o1."waiterId" = ${d.mesero}`);
  if (d.mesa) parts.push(Prisma.sql`o1."tableId" = ${d.mesa}`);
  if (d.dia !== undefined) parts.push(Prisma.sql`o1."dow" = ${d.dia}::int`);
  if (d.hora !== undefined) parts.push(Prisma.sql`o1."hour" = ${d.hora}::int`);
  if (d.pago) {
    parts.push(Prisma.sql`EXISTS (
      SELECT 1 FROM "Payment" p
      WHERE p."orderId" = o1."id" AND p."status" IN ('approved', 'refunded')
        AND p."method"::text IN (${Prisma.join(methodsForFilter(d.pago))})
    )`);
  }
  return parts.length ? Prisma.sql`WHERE ${Prisma.join(parts, " AND ")}` : Prisma.empty;
}

/** ¿La línea entra en el filtro de producto/categoría? (true sin filtro) */
function lineMatch(scope: SalesScope): Prisma.Sql {
  const parts: Prisma.Sql[] = [];
  if (scope.dims.producto) parts.push(Prisma.sql`it."menuItemId" = ${scope.dims.producto}`);
  if (scope.dims.categoria) parts.push(Prisma.sql`mi."categoryId" = ${scope.dims.categoria}`);
  return parts.length ? Prisma.sql`(${Prisma.join(parts, " AND ")})` : Prisma.sql`true`;
}

/**
 * Impuesto INCLUIDO de una línea de carta con la tarifa ACTUAL (sólo cuentas
 * sin factura): bruto − round(bruto × 10000 / (10000 + tarifa×100)), el mismo
 * redondeo de `splitTaxIncludedCents` que usa la factura.
 */
function currentTaxOf(gross: Prisma.Sql, pct: number, invoiceId: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`CASE WHEN it."taxKind" IS NULL AND it."qty" > 0 AND ${invoiceId} IS NULL AND ${pct}::int > 0
    THEN ${gross} - ROUND(${gross} * 10000 / (10000 + ${pct}::int)) ELSE 0 END`;
}

/** Columnas de cuenta que viajan hasta los hechos (`f`) y las líneas (`lf`). */
const FACT_COLUMNS = [
  "id", "shortCode", "paidAt", "placedAt", "createdAt", "bizDate", "hour", "dow", "channel",
  "waiterId", "tableId", "tableNumber", "tableLabel", "diners", "totalCents", "orderType",
] as const;

function columns(alias: string, names: readonly string[], rename?: Record<string, string>): Prisma.Sql {
  return Prisma.raw(names.map((n) => `${alias}."${n}"${rename?.[n] ? ` AS "${rename[n]}"` : ""}`).join(", "));
}

/**
 * Los CTE comunes. Toda consulta del módulo arranca con esto.
 *
 * Plan robusto ante estimaciones malas: un CTE sólo se une con TABLAS por
 * índice (nunca CTE con CTE), así un filtro que el planificador estima en
 * «1 fila» no puede convertir la consulta en un bucle anidado cuadrático.
 */
export function salesCtes(scope: SalesScope, universe: Universe = { kind: "range" }): Prisma.Sql {
  const shift = 5 + scope.cutoffHour;
  const pct = pctTimes100(scope.tax);
  const where = universe.kind === "range"
    ? Prisma.sql`o."paidAt" >= ${utc(scope.start)} AND o."paidAt" < ${utc(scope.end)}`
    : universe.ids.length
      ? Prisma.sql`o."id" IN (${Prisma.join([...universe.ids])})`
      : Prisma.sql`false`;
  const item = hasItemFilter(scope);
  const gross = Prisma.sql`(it."priceCentsSnapshot"::numeric * it."qty")`;
  return Prisma.sql`WITH
"o0" AS MATERIALIZED (
  SELECT o."id", o."shortCode", o."paidAt", o."createdAt", o."placedAt", o."orderType", o."tableId",
    o."diners", o."subtotalCents", o."taxCents", o."tipCents", o."totalCents", o."discountCents",
    o."compedAt", o."compAmountCents", o."commissionWaiterId", o."commissionCents",
    t."kind"::text AS "tableKind", t."number" AS "tableNumber", t."label" AS "tableLabel",
    (o."paidAt" - (${shift}::int * interval '1 hour'))::date AS "bizDate",
    EXTRACT(HOUR FROM o."paidAt" - interval '5 hours')::int AS "hour",
    inv."id" AS "invoiceId",
    ${FROZEN_TAX} AS "frozenTax"
  FROM "Order" o
  JOIN "Table" t ON t."id" = o."tableId"
  LEFT JOIN "SimpleInvoice" inv ON inv."orderId" = o."id" AND inv."restaurantId" = o."restaurantId"
  WHERE o."restaurantId" = ${scope.restaurantId} AND o."status" = 'paid' AND o."paidAt" IS NOT NULL
    AND ${where}
),
"o1" AS MATERIALIZED (
  SELECT o0.*,
    CASE WHEN o0."orderType"::text = 'pickup' THEN 'llevar'
      WHEN o0."tableKind" = 'manual' THEN 'manual' ELSE 'salon' END AS "channel",
    EXTRACT(ISODOW FROM o0."bizDate")::int AS "dow",
    COALESCE(o0."commissionWaiterId", pw."userId") AS "waiterId"
  FROM o0
  LEFT JOIN LATERAL (
    -- Sin comisión sellada: el mesero que montó más valor de la cuenta.
    SELECT r."placedByUserId" AS "userId"
    FROM "Round" r
    JOIN "OrderItem" it ON it."roundId" = r."id" AND it."orderId" = r."orderId"
    WHERE o0."commissionWaiterId" IS NULL AND r."orderId" = o0."id"
      AND r."status" <> 'cancelled' AND r."placedByRole" = 'mesero' AND r."placedByUserId" IS NOT NULL
      AND (it."cancelledAt" IS NULL OR it."cancellationKind" = 'comp')
    GROUP BY r."placedByUserId"
    ORDER BY SUM(it."priceCentsSnapshot"::bigint * it."qty") DESC, MIN(r."placedAt") ASC, r."placedByUserId" ASC
    LIMIT 1
  ) pw ON true
),
"o" AS MATERIALIZED (
  SELECT o1.* FROM o1 ${orderConditions(scope)}
),
"fo" AS MATERIALIZED (
  SELECT o.*, a."linesGross", a."menuGross", a."units", i."included", x."net",
    a."linesGross"
      - CASE WHEN a."linesGross" > 0 THEN o."discountCents" ELSE 0 END
      - CASE WHEN o."invoiceId" IS NULL THEN a."curTax" WHEN a."menuGross" > 0 THEN i."included" ELSE 0 END
      AS "orderRawNet"
  FROM o
  CROSS JOIN LATERAL (
    SELECT COALESCE(SUM(${gross}), 0) AS "linesGross",
      COALESCE(SUM(CASE WHEN it."taxKind" IS NULL THEN ${gross} ELSE 0 END), 0) AS "menuGross",
      COALESCE(SUM(${currentTaxOf(gross, pct, Prisma.sql`o."invoiceId"`)}), 0) AS "curTax",
      COALESCE(SUM(CASE WHEN it."menuItemId" IS NOT NULL THEN it."qty" ELSE 0 END), 0) AS "units"
    FROM "OrderItem" it
    LEFT JOIN "Round" r ON r."id" = it."roundId"
    WHERE it."orderId" = o."id" AND ${LIVE_LINE}
  ) a
  CROSS JOIN LATERAL (
    SELECT CASE WHEN o."invoiceId" IS NULL THEN a."curTax" ELSE o."frozenTax" END AS "included"
  ) i
  CROSS JOIN LATERAL (
    SELECT GREATEST(0, o."totalCents" - o."tipCents" - o."taxCents" - i."included") AS "net"
  ) x
  WHERE o."compedAt" IS NULL
),
"lf" AS MATERIALIZED (
  SELECT ${columns("fo", FACT_COLUMNS, { id: "orderId" })},
    it."id" AS "itemId", it."menuItemId", it."nameSnapshot", it."qty", it."taxKind",
    it."modifierSelections", mi."categoryId",
    v."gross", v."disc", v."tax",
    CASE WHEN fo."orderRawNet" > 0 THEN fo."net" * (v."gross" - v."disc" - v."tax") / fo."orderRawNet" ELSE 0 END AS "net",
    ${lineMatch(scope)} AS "match"
  FROM fo
  JOIN "OrderItem" it ON it."orderId" = fo."id"
  LEFT JOIN "Round" r ON r."id" = it."roundId"
  LEFT JOIN "MenuItem" mi ON mi."id" = it."menuItemId" AND mi."restaurantId" = ${scope.restaurantId}
  CROSS JOIN LATERAL (
    SELECT ${gross} AS "gross",
      COALESCE(${gross} * fo."discountCents" / NULLIF(fo."linesGross", 0), 0) AS "disc",
      CASE WHEN it."taxKind" IS NOT NULL THEN 0
        WHEN fo."invoiceId" IS NULL THEN ${currentTaxOf(gross, pct, Prisma.sql`fo."invoiceId"`)}
        ELSE COALESCE(fo."included" * ${gross} / NULLIF(fo."menuGross", 0), 0) END AS "tax"
  ) v
  WHERE ${LIVE_LINE}
),
"f" AS MATERIALIZED (
  ${item ? itemFacts() : orderFacts()}
)
`;
}

function orderFacts(): Prisma.Sql {
  return Prisma.sql`SELECT ${columns("fo", FACT_COLUMNS)},
    (fo."subtotalCents" + fo."taxCents")::numeric AS "gross",
    fo."discountCents"::numeric AS "discount",
    (fo."taxCents" + fo."included")::numeric AS "tax",
    fo."net"::numeric AS "net",
    fo."tipCents"::numeric AS "tip",
    fo."units"::numeric AS "units",
    fo."commissionCents"::numeric AS "commission"
  FROM fo`;
}

/** Con filtro de producto/categoría: la cuenta sólo aporta sus líneas que coinciden. */
function itemFacts(): Prisma.Sql {
  const groupCols = columns("lf", FACT_COLUMNS.map((c) => (c === "id" ? "orderId" : c)));
  return Prisma.sql`SELECT ${columns("lf", FACT_COLUMNS.map((c) => (c === "id" ? "orderId" : c)), { orderId: "id" })},
    SUM(lf."gross") AS "gross", SUM(lf."disc") AS "discount", SUM(lf."tax") AS "tax", SUM(lf."net") AS "net",
    NULL::numeric AS "tip",
    SUM(CASE WHEN lf."menuItemId" IS NOT NULL THEN lf."qty" ELSE 0 END)::numeric AS "units",
    NULL::numeric AS "commission"
  FROM lf WHERE lf."match"
  GROUP BY ${groupCols}`;
}

// ── Consultas ──────────────────────────────────────────────────────────────

/** Totales del período (cuentas, comensales, dinero y cortesías). */
export function totalsSql(scope: SalesScope): Prisma.Sql {
  const item = hasItemFilter(scope);
  return Prisma.sql`${salesCtes(scope)}
SELECT
  (SELECT COUNT(*) FROM f)::bigint AS "orders",
  (SELECT COALESCE(SUM(f."diners"), 0) FROM f)::bigint AS "diners",
  (SELECT COALESCE(SUM(f."units"), 0) FROM f)::bigint AS "units",
  (SELECT ROUND(COALESCE(SUM(f."gross"), 0)) FROM f)::bigint AS "grossCents",
  (SELECT ROUND(COALESCE(SUM(f."discount"), 0)) FROM f)::bigint AS "discountCents",
  (SELECT ROUND(COALESCE(SUM(f."tax"), 0)) FROM f)::bigint AS "taxCents",
  (SELECT ROUND(COALESCE(SUM(f."net"), 0)) FROM f)::bigint AS "netCents",
  (SELECT ROUND(SUM(f."tip")) FROM f)::bigint AS "tipCents",
  (
    (SELECT COALESCE(SUM(it."priceCentsSnapshot"::bigint * it."qty"), 0)
      FROM o JOIN "OrderItem" it ON it."orderId" = o."id"
      LEFT JOIN "Round" r ON r."id" = it."roundId"
      LEFT JOIN "MenuItem" mi ON mi."id" = it."menuItemId" AND mi."restaurantId" = ${scope.restaurantId}
      WHERE ${COMP_LINE} AND ${lineMatch(scope)})
    + ${item ? Prisma.sql`0` : Prisma.sql`(SELECT COALESCE(SUM(o."compAmountCents"), 0) FROM o
      WHERE o."compedAt" IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM "OrderItem" it LEFT JOIN "Round" r ON r."id" = it."roundId"
        WHERE it."orderId" = o."id" AND ${COMP_LINE}))`}
  )::bigint AS "compsCents"`;
}

/** Expresión del balde de tendencia según la granularidad. */
function bucketExpr(granularity: Granularity): Prisma.Sql {
  switch (granularity) {
    case "hora":
      return Prisma.sql`to_char(f."bizDate", 'YYYY-MM-DD') || 'T' || lpad(f."hour"::text, 2, '0')`;
    case "dia":
      return Prisma.sql`to_char(f."bizDate", 'YYYY-MM-DD')`;
    case "semana":
      return Prisma.sql`to_char(date_trunc('week', f."bizDate")::date, 'YYYY-MM-DD')`;
    case "mes":
      return Prisma.sql`to_char(f."bizDate", 'YYYY-MM')`;
  }
}

export function trendSql(scope: SalesScope, granularity: Granularity): Prisma.Sql {
  return Prisma.sql`${salesCtes(scope)}
SELECT ${bucketExpr(granularity)} AS "bucket",
  ROUND(SUM(f."net"))::bigint AS "netCents", COUNT(*)::bigint AS "orders",
  COALESCE(SUM(f."diners"), 0)::bigint AS "diners"
FROM f GROUP BY 1 ORDER BY 1`;
}

export function heatSql(scope: SalesScope): Prisma.Sql {
  return Prisma.sql`${salesCtes(scope)}
SELECT f."dow"::int AS "dow", f."hour"::int AS "hour",
  ROUND(SUM(f."net"))::bigint AS "netCents", COUNT(*)::bigint AS "orders"
FROM f GROUP BY 1, 2`;
}

export function productsSql(scope: SalesScope): Prisma.Sql {
  return Prisma.sql`${salesCtes(scope)}
SELECT COALESCE(lf."menuItemId", 'libre:' || lf."nameSnapshot") AS "key",
  lf."menuItemId",
  COALESCE(MAX(mi."name"), MAX(lf."nameSnapshot")) AS "name",
  MAX(lf."categoryId") AS "categoryId",
  COALESCE(SUM(lf."qty"), 0)::bigint AS "units",
  ROUND(SUM(lf."net"))::bigint AS "netCents",
  ROUND(SUM(lf."gross"))::bigint AS "grossCents",
  COUNT(DISTINCT lf."orderId")::bigint AS "orders"
FROM lf
LEFT JOIN "MenuItem" mi ON mi."id" = lf."menuItemId" AND mi."restaurantId" = ${scope.restaurantId}
WHERE lf."match"
GROUP BY 1, 2
ORDER BY "netCents" DESC, "units" DESC`;
}

export function categoriesSql(scope: SalesScope): Prisma.Sql {
  return Prisma.sql`${salesCtes(scope)}
SELECT lf."categoryId", MAX(c."label") AS "label", MAX(pc."label") AS "parentLabel",
  COALESCE(SUM(CASE WHEN lf."menuItemId" IS NOT NULL THEN lf."qty" ELSE 0 END), 0)::bigint AS "units",
  ROUND(SUM(lf."net"))::bigint AS "netCents",
  COUNT(DISTINCT lf."orderId")::bigint AS "orders"
FROM lf
LEFT JOIN "Category" c ON c."id" = lf."categoryId" AND c."restaurantId" = ${scope.restaurantId}
LEFT JOIN "Category" pc ON pc."id" = c."parentId" AND pc."restaurantId" = ${scope.restaurantId}
WHERE lf."match"
GROUP BY 1
ORDER BY "netCents" DESC`;
}

/**
 * Modificadores más pedidos: cada opción elegida (`{grupo: "opción"}` o
 * `{grupo: ["a", "b"]}`) cuenta las unidades de su línea. El nombre del
 * grupo sale de la carta ACTUAL del plato (si el grupo ya no existe, null).
 */
export function modifiersSql(scope: SalesScope, limit: number): Prisma.Sql {
  return Prisma.sql`${salesCtes(scope)}
SELECT g."label" AS "group", sel."opt" AS "option",
  COALESCE(SUM(lf."qty"), 0)::bigint AS "units",
  COUNT(DISTINCT lf."menuItemId")::bigint AS "products"
FROM lf
CROSS JOIN LATERAL jsonb_each(
  CASE WHEN jsonb_typeof(lf."modifierSelections") = 'object' THEN lf."modifierSelections" ELSE '{}'::jsonb END
) kv
CROSS JOIN LATERAL (
  SELECT btrim(e #>> '{}') AS "opt"
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(kv.value) = 'array' THEN kv.value ELSE '[]'::jsonb END) e
  WHERE jsonb_typeof(e) = 'string'
  UNION ALL
  SELECT btrim(kv.value #>> '{}') WHERE jsonb_typeof(kv.value) = 'string'
) sel
LEFT JOIN LATERAL (
  SELECT m ->> 'label' AS "label"
  FROM "MenuItem" mi,
    jsonb_array_elements(CASE WHEN jsonb_typeof(mi."modifiers") = 'array' THEN mi."modifiers" ELSE '[]'::jsonb END) m
  WHERE mi."id" = lf."menuItemId" AND mi."restaurantId" = ${scope.restaurantId} AND m ->> 'id' = kv.key
  LIMIT 1
) g ON true
WHERE lf."match" AND sel."opt" <> ''
GROUP BY 1, 2
ORDER BY "units" DESC, "option" ASC
LIMIT ${limit}`;
}

export function waitersSql(scope: SalesScope): Prisma.Sql {
  return Prisma.sql`${salesCtes(scope)}
SELECT f."waiterId", MAX(COALESCE(NULLIF(btrim(u."name"), ''), u."email")) AS "name",
  ROUND(SUM(f."net"))::bigint AS "netCents", COUNT(*)::bigint AS "orders",
  COALESCE(SUM(f."diners"), 0)::bigint AS "diners",
  ROUND(SUM(f."tip"))::bigint AS "tipCents",
  ROUND(SUM(f."commission"))::bigint AS "commissionCents"
FROM f LEFT JOIN "User" u ON u."id" = f."waiterId"
GROUP BY 1
ORDER BY "netCents" DESC`;
}

/** Cobrado por método (aprobado y luego devuelto: lo que se cobró, como el asiento de ventas). */
export function methodsSql(scope: SalesScope): Prisma.Sql {
  return Prisma.sql`${salesCtes(scope)}
SELECT CASE WHEN p."method"::text IN ('cash', 'demo_cash') THEN 'cash' ELSE p."method"::text END AS "method",
  COALESCE(SUM(p."amountCents"), 0)::bigint AS "amountCents",
  COALESCE(SUM(p."tipCents"), 0)::bigint AS "tipCents",
  COUNT(*)::bigint AS "payments",
  COUNT(DISTINCT p."orderId")::bigint AS "orders"
FROM f JOIN "Payment" p ON p."orderId" = f."id"
WHERE p."status" IN ('approved', 'refunded')
GROUP BY 1
ORDER BY "amountCents" DESC`;
}

export function channelsSql(scope: SalesScope): Prisma.Sql {
  return Prisma.sql`${salesCtes(scope)}
SELECT f."channel", ROUND(SUM(f."net"))::bigint AS "netCents", COUNT(*)::bigint AS "orders",
  COALESCE(SUM(f."diners"), 0)::bigint AS "diners"
FROM f GROUP BY 1 ORDER BY "netCents" DESC`;
}

export function tablesSql(scope: SalesScope, limit: number): Prisma.Sql {
  return Prisma.sql`${salesCtes(scope)}
SELECT f."tableId", MAX(f."tableNumber")::int AS "number", MAX(f."tableLabel") AS "label",
  ROUND(SUM(f."net"))::bigint AS "netCents", COUNT(*)::bigint AS "orders",
  COALESCE(SUM(f."diners"), 0)::bigint AS "diners"
FROM f WHERE f."channel" = 'salon'
GROUP BY 1 ORDER BY "netCents" DESC LIMIT ${limit}`;
}

/**
 * Duración de la mesa: de la primera ronda viva (o la creación de la cuenta)
 * al pago, sólo en salón. Mediana, que no la mueven las cuentas olvidadas
 * abiertas; se descartan las de menos de 1 minuto y más de 12 horas.
 */
export function durationSql(scope: SalesScope): Prisma.Sql {
  return Prisma.sql`${salesCtes(scope)}
SELECT
  percentile_cont(0.5) WITHIN GROUP (ORDER BY d."mins") FILTER (WHERE d."mins" >= 1 AND d."mins" <= 720) AS "median",
  COUNT(*) FILTER (WHERE d."mins" >= 1 AND d."mins" <= 720)::bigint AS "measured",
  COUNT(*)::bigint AS "eligible"
FROM (
  SELECT EXTRACT(EPOCH FROM (f."paidAt" - COALESCE(fr."first", f."placedAt", f."createdAt"))) / 60 AS "mins"
  FROM f
  LEFT JOIN LATERAL (
    SELECT MIN(r."placedAt") AS "first" FROM "Round" r
    WHERE r."orderId" = f."id" AND r."status" <> 'cancelled'
  ) fr ON true
  WHERE f."channel" = 'salon'
) d`;
}

/** Cuentas del período (el detalle del día), con métodos y mesero. */
export function ordersSql(scope: SalesScope, limit: number): Prisma.Sql {
  return Prisma.sql`${salesCtes(scope)}
SELECT f."id", f."shortCode", f."paidAt", f."channel", f."tableNumber", f."tableLabel",
  COALESCE(NULLIF(btrim(u."name"), ''), u."email") AS "waiterName",
  f."diners", f."units"::bigint AS "units", ROUND(f."net")::bigint AS "netCents",
  ROUND(f."tip")::bigint AS "tipCents", f."totalCents",
  COALESCE((
    SELECT array_agg(DISTINCT CASE WHEN p."method"::text IN ('cash', 'demo_cash') THEN 'cash' ELSE p."method"::text END)
    FROM "Payment" p WHERE p."orderId" = f."id" AND p."status" IN ('approved', 'refunded')
  ), ARRAY[]::text[]) AS "methods"
FROM f LEFT JOIN "User" u ON u."id" = f."waiterId"
ORDER BY f."paidAt" DESC
LIMIT ${limit}`;
}

/** Cuentas de `ids` que pasan los filtros de cuenta (para notas y reembolsos). */
export function filterOrderIdsSql(scope: SalesScope, ids: readonly string[]): Prisma.Sql {
  return Prisma.sql`${salesCtes(scope, { kind: "ids", ids })}
SELECT o."id" FROM o`;
}
