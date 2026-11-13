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
// ── Eje de tiempo (`scope.axis`) ───────────────────────────────────────────
// Las ventas son SIEMPRE las mismas (cuentas pagadas, sin cortesías
// completas); el eje sólo decide en qué día operativo y en qué hora caen:
//  · `pago`: la cuenta entera en el instante de su pago (`paidAt`). Es el
//    comportamiento histórico del módulo, idéntico al cierre de caja.
//  · `pedido`: cada línea en el instante en que se montó su ronda
//    (`Round.placedAt`; sin ronda, el de la apertura) y la cuenta en su
//    APERTURA (`openedAt`: primera ronda viva, o la orden montada o creada).
//    Una cuenta queda partida en «tajadas» (una por instante de pedido): el
//    dinero de las líneas va en su tajada; lo que es de la cuenta (contarla,
//    comensales, propina, comisión, pagos, ticket) va en la de su apertura.
//    Una cuenta pagada después del período cuenta en el período en que se
//    montó (si ya está pagada al consultar); una abierta todavía no cuenta.
//
// Cadena de CTE:
//   o0  cuentas pagadas candidatas (+ impuesto congelado y apertura):
//       `pago` → pagadas en el rango; `pedido` → pagadas desde el inicio y
//       creadas antes del fin (toda ronda se monta entre esos dos instantes)
//   o1  + canal, mesero, instante del eje de la cuenta (`anchorAt`) y su día
//       operativo, hora y día de la semana
//   o   + filtros de cuenta (canal, mesero, mesa, pago; día y hora sólo
//       cuando se miden en la cuenta: eje `pago` o lista de ids)
//   fo  cuentas VENDIDAS (no cortesía completa) con su venta neta y los
//       agregados de sus líneas vivas (+ impuesto incluido con tarifa actual)
//   lf  líneas vivas con su parte de la venta neta (Σ líneas = venta neta),
//       su instante en el eje (`at`) y si caen en el período (`inSlice`)
//   f   hechos por TAJADA dentro del período: con eje `pago`, una por cuenta
//       (la cuenta entera o, con filtro de producto o categoría, sólo sus
//       líneas que coinciden); con eje `pedido`, una por instante de pedido.
//       `opens` = 1 en la tajada que cuenta la cuenta.
import { Prisma } from "@prisma/client";
import type { RestaurantTax } from "@/lib/salesTax";
import {
  hasItemFilter,
  methodsForFilter,
  NO_WAITER,
  type DimensionFilters,
  type TimeAxis,
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
  /** Eje de tiempo: hora del pedido u hora del pago (ver arriba). */
  axis: TimeAxis;
};

/** El universo de cuentas: por rango (del eje) o por una lista de cuentas. */
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

/**
 * Día operativo, hora del reloj (Bogotá, UTC−5 fijo) y día de la semana ISO
 * de un instante. El día operativo arranca a la hora de corte del comercio.
 */
function slotOf(at: Prisma.Sql, cutoffHour: number): { bizDate: Prisma.Sql; hour: Prisma.Sql; dow: Prisma.Sql } {
  const shift = 5 + cutoffHour;
  const bizDate = Prisma.sql`((${at}) - (${shift}::int * interval '1 hour'))::date`;
  return {
    bizDate,
    hour: Prisma.sql`EXTRACT(HOUR FROM (${at}) - interval '5 hours')::int`,
    dow: Prisma.sql`EXTRACT(ISODOW FROM ${bizDate})::int`,
  };
}

/** Condición «la tajada en `at` cae en el período y en el día/hora filtrados». */
function inSliceOf(scope: SalesScope, at: Prisma.Sql): Prisma.Sql {
  const s = slotOf(at, scope.cutoffHour);
  const parts: Prisma.Sql[] = [Prisma.sql`(${at}) >= ${utc(scope.start)}`, Prisma.sql`(${at}) < ${utc(scope.end)}`];
  if (scope.dims.dia !== undefined) parts.push(Prisma.sql`${s.dow} = ${scope.dims.dia}::int`);
  if (scope.dims.hora !== undefined) parts.push(Prisma.sql`${s.hour} = ${scope.dims.hora}::int`);
  return Prisma.sql`(${Prisma.join(parts, " AND ")})`;
}

const byOrder = (scope: Pick<SalesScope, "axis">) => scope.axis === "pedido";

function orderConditions(scope: SalesScope, slotAtAccount: boolean): Prisma.Sql {
  const d = scope.dims;
  const parts: Prisma.Sql[] = [];
  if (d.canal) parts.push(Prisma.sql`o1."channel" = ${d.canal}`);
  if (d.mesero === NO_WAITER) parts.push(Prisma.sql`o1."waiterId" IS NULL`);
  else if (d.mesero) parts.push(Prisma.sql`o1."waiterId" = ${d.mesero}`);
  if (d.mesa) parts.push(Prisma.sql`o1."tableId" = ${d.mesa}`);
  if (slotAtAccount && d.dia !== undefined) parts.push(Prisma.sql`o1."dow" = ${d.dia}::int`);
  if (slotAtAccount && d.hora !== undefined) parts.push(Prisma.sql`o1."hour" = ${d.hora}::int`);
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
const ACCOUNT_COLUMNS = [
  "id", "shortCode", "paidAt", "placedAt", "createdAt", "openedAt", "channel",
  "waiterId", "tableId", "tableNumber", "tableLabel", "diners", "totalCents", "orderType",
] as const;
/** Instante en el eje y su día operativo, hora y día de la semana. */
const SLOT_COLUMNS = ["at", "bizDate", "hour", "dow"] as const;
/** Las columnas de cuenta con `id` renombrado a `orderId` (como en `lf`). */
const LINE_ACCOUNT_COLUMNS = ACCOUNT_COLUMNS.map((c) => (c === "id" ? "orderId" : c));

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
  const pct = pctTimes100(scope.tax);
  const pedido = byOrder(scope);
  // Con eje «pedido» la cuenta entra si alguna de sus rondas pudo montarse en
  // el rango: toda ronda va entre la creación de la cuenta y su pago, así que
  // basta «pagada desde el inicio y creada antes del fin». Lo de afuera lo
  // descartan las tajadas (`inSlice`). Ver la nota de índices en el PR.
  const where = universe.kind === "ids"
    ? universe.ids.length
      ? Prisma.sql`o."id" IN (${Prisma.join([...universe.ids])})`
      : Prisma.sql`false`
    : pedido
      ? Prisma.sql`o."paidAt" >= ${utc(scope.start)} AND o."createdAt" < ${utc(scope.end)}`
      : Prisma.sql`o."paidAt" >= ${utc(scope.start)} AND o."paidAt" < ${utc(scope.end)}`;
  const item = hasItemFilter(scope);
  const gross = Prisma.sql`(it."priceCentsSnapshot"::numeric * it."qty")`;
  const account = slotOf(Prisma.sql`an."anchorAt"`, scope.cutoffHour);
  const line = slotOf(Prisma.sql`ln."at"`, scope.cutoffHour);
  return Prisma.sql`WITH
"o0" AS MATERIALIZED (
  SELECT o."id", o."shortCode", o."paidAt", o."createdAt", o."placedAt", o."orderType", o."tableId",
    o."diners", o."subtotalCents", o."taxCents", o."tipCents", o."totalCents", o."discountCents",
    o."compedAt", o."compAmountCents", o."commissionWaiterId", o."commissionCents",
    t."kind"::text AS "tableKind", t."number" AS "tableNumber", t."label" AS "tableLabel",
    -- Apertura: la primera ronda viva (o, sin rondas, la orden montada o creada).
    COALESCE(fr."first", o."placedAt", o."createdAt") AS "openedAt",
    inv."id" AS "invoiceId",
    ${FROZEN_TAX} AS "frozenTax"
  FROM "Order" o
  JOIN "Table" t ON t."id" = o."tableId"
  LEFT JOIN "SimpleInvoice" inv ON inv."orderId" = o."id" AND inv."restaurantId" = o."restaurantId"
  LEFT JOIN LATERAL (
    SELECT MIN(r."placedAt") AS "first" FROM "Round" r
    WHERE r."orderId" = o."id" AND r."status" <> 'cancelled'
  ) fr ON true
  WHERE o."restaurantId" = ${scope.restaurantId} AND o."status" = 'paid' AND o."paidAt" IS NOT NULL
    AND ${where}
),
"o1" AS MATERIALIZED (
  SELECT o0.*, an."anchorAt",
    ${account.bizDate} AS "bizDate",
    ${account.hour} AS "hour",
    ${account.dow} AS "dow",
    CASE WHEN o0."orderType"::text = 'pickup' THEN 'llevar'
      WHEN o0."tableKind" = 'manual' THEN 'manual' ELSE 'salon' END AS "channel",
    COALESCE(o0."commissionWaiterId", pw."userId") AS "waiterId"
  FROM o0
  CROSS JOIN LATERAL (SELECT ${pedido ? Prisma.sql`o0."openedAt"` : Prisma.sql`o0."paidAt"`} AS "anchorAt") an
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
  SELECT o1.* FROM o1 ${orderConditions(scope, !pedido || universe.kind === "ids")}
),
"fo" AS MATERIALIZED (
  SELECT o.*, a."linesGross", a."menuGross", a."curTax", a."units", i."included", x."net",
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
  SELECT ${columns("fo", ACCOUNT_COLUMNS, { id: "orderId" })}, fo."tipCents", fo."commissionCents",
    ln."at", ${line.bizDate} AS "bizDate", ${line.hour} AS "hour", ${line.dow} AS "dow",
    it."id" AS "itemId", it."menuItemId", it."nameSnapshot", it."qty", it."taxKind",
    it."modifierSelections", mi."categoryId",
    v."gross", v."disc", v."tax",
    CASE WHEN fo."orderRawNet" > 0 THEN fo."net" * (v."gross" - v."disc" - v."tax") / fo."orderRawNet" ELSE 0 END AS "net",
    ${lineMatch(scope)} AS "match",
    ${pedido ? inSliceOf(scope, Prisma.sql`ln."at"`) : Prisma.sql`true`} AS "inSlice"
  FROM fo
  JOIN "OrderItem" it ON it."orderId" = fo."id"
  LEFT JOIN "Round" r ON r."id" = it."roundId"
  LEFT JOIN "MenuItem" mi ON mi."id" = it."menuItemId" AND mi."restaurantId" = ${scope.restaurantId}
  -- Instante de la línea: con eje «pedido», el de su ronda (sin ronda, la apertura).
  CROSS JOIN LATERAL (SELECT ${pedido ? Prisma.sql`COALESCE(r."placedAt", fo."openedAt")` : Prisma.sql`fo."paidAt"`} AS "at") ln
  CROSS JOIN LATERAL (
    SELECT ${gross} AS "gross",
      COALESCE(${gross} * fo."discountCents" / NULLIF(fo."linesGross", 0), 0) AS "disc",
      CASE WHEN it."taxKind" IS NOT NULL THEN 0
        WHEN fo."invoiceId" IS NULL THEN ${currentTaxOf(gross, pct, Prisma.sql`fo."invoiceId"`)}
        ELSE COALESCE(fo."included" * ${gross} / NULLIF(fo."menuGross", 0), 0) END AS "tax"
  ) v
  WHERE ${LIVE_LINE}
),
${pedido ? sliceFacts(scope, item) : Prisma.sql`"f" AS MATERIALIZED (
  ${item ? itemFacts() : orderFacts()}
)`}
`;
}

// Columnas de `f` (los dos ejes): las de la cuenta (`ACCOUNT_COLUMNS`), las
// de la tajada (`SLOT_COLUMNS`) y los montos de la tajada: gross, discount,
// tax, net, units, tip, commission, diners, opens (1 = esta tajada cuenta la
// cuenta) y accountNet/accountUnits (la cuenta entera, sólo en esa tajada:
// sirven para el ticket y los productos por cuenta).

/** Eje «pago»: una tajada por cuenta, en su pago. */
function orderFacts(): Prisma.Sql {
  return Prisma.sql`SELECT ${columns("fo", ACCOUNT_COLUMNS)},
    fo."paidAt" AS "at", fo."bizDate", fo."hour", fo."dow",
    (fo."subtotalCents" + fo."taxCents")::numeric AS "gross",
    fo."discountCents"::numeric AS "discount",
    (fo."taxCents" + fo."included")::numeric AS "tax",
    fo."net"::numeric AS "net",
    fo."tipCents"::numeric AS "tip",
    fo."units"::numeric AS "units",
    fo."commissionCents"::numeric AS "commission",
    1 AS "opens",
    fo."net"::numeric AS "accountNet",
    fo."units"::numeric AS "accountUnits"
  FROM fo`;
}

/** Eje «pago» con filtro de producto/categoría: la cuenta sólo aporta sus líneas que coinciden. */
function itemFacts(): Prisma.Sql {
  const groupCols = columns("lf", [...LINE_ACCOUNT_COLUMNS, ...SLOT_COLUMNS]);
  return Prisma.sql`SELECT ${columns("lf", LINE_ACCOUNT_COLUMNS, { orderId: "id" })}, ${columns("lf", SLOT_COLUMNS)},
    SUM(lf."gross") AS "gross", SUM(lf."disc") AS "discount", SUM(lf."tax") AS "tax", SUM(lf."net") AS "net",
    NULL::numeric AS "tip",
    SUM(CASE WHEN lf."menuItemId" IS NOT NULL THEN lf."qty" ELSE 0 END)::numeric AS "units",
    NULL::numeric AS "commission",
    1 AS "opens",
    SUM(lf."net") AS "accountNet",
    SUM(CASE WHEN lf."menuItemId" IS NOT NULL THEN lf."qty" ELSE 0 END)::numeric AS "accountUnits"
  FROM lf WHERE lf."match"
  GROUP BY ${groupCols}`;
}

/**
 * Eje «pedido»: la cuenta partida en tajadas, una por instante de pedido.
 *
 *  fu  las líneas vivas (con filtro de producto/categoría, sólo las que
 *      coinciden) + una fila de APERTURA por cuenta, en `anchorAt`, con lo
 *      que no es de ninguna línea: el impuesto sumado encima de las líneas
 *      libres y cualquier diferencia de redondeo. Así la suma de las
 *      tajadas de una cuenta da exactamente sus montos con eje «pago».
 *  fg  suma por (cuenta, instante): la apertura cae en la tajada de la
 *      primera ronda (es el mismo instante).
 *  f   tajadas dentro del período (y del día/hora filtrados); lo de la
 *      cuenta (contarla, comensales, propina, comisión, ticket) sólo en la
 *      de apertura. Con filtro de producto, la cuenta cuenta sólo si tiene
 *      alguna línea que coincide (en cualquier tajada).
 * Sólo agrega y une CTE por unión, nunca CTE con CTE por JOIN.
 */
function sliceFacts(scope: SalesScope, item: boolean): Prisma.Sql {
  const acct = columns("fo", ACCOUNT_COLUMNS, { id: "orderId" });
  const zero = Prisma.sql`0::numeric`;
  const residual = item
    ? { gross: zero, discount: zero, tax: zero, net: zero }
    : {
        gross: Prisma.sql`(fo."subtotalCents" + fo."taxCents")::numeric - fo."linesGross"`,
        discount: Prisma.sql`(CASE WHEN fo."linesGross" > 0 THEN 0 ELSE fo."discountCents" END)::numeric`,
        tax: Prisma.sql`(fo."taxCents" + fo."included")::numeric
          - CASE WHEN fo."invoiceId" IS NULL THEN fo."curTax" WHEN fo."menuGross" > 0 THEN fo."included" ELSE 0 END`,
        net: Prisma.sql`(CASE WHEN fo."orderRawNet" > 0 THEN 0 ELSE fo."net" END)::numeric`,
      };
  const groupCols = columns("fu", [...LINE_ACCOUNT_COLUMNS, "tipCents", "commissionCents", "at"]);
  const s = slotOf(Prisma.sql`w."at"`, scope.cutoffHour);
  return Prisma.sql`"fu" AS (
  SELECT ${columns("lf", LINE_ACCOUNT_COLUMNS)}, lf."tipCents", lf."commissionCents", lf."at",
    lf."gross", lf."disc" AS "discount", lf."tax", lf."net",
    (CASE WHEN lf."menuItemId" IS NOT NULL THEN lf."qty" ELSE 0 END)::numeric AS "units",
    0 AS "opening", 1 AS "lines"
  FROM lf ${item ? Prisma.sql`WHERE lf."match"` : Prisma.empty}
  UNION ALL
  SELECT ${acct}, fo."tipCents", fo."commissionCents", fo."anchorAt",
    ${residual.gross}, ${residual.discount}, ${residual.tax}, ${residual.net}, ${zero},
    1, 0
  FROM fo
),
"fg" AS (
  SELECT ${groupCols},
    SUM(fu."gross") AS "gross", SUM(fu."discount") AS "discount", SUM(fu."tax") AS "tax",
    SUM(fu."net") AS "net", SUM(fu."units") AS "units",
    MAX(fu."opening") AS "opening", SUM(fu."lines") AS "lines"
  FROM fu
  GROUP BY ${groupCols}
),
"f" AS MATERIALIZED (
  SELECT ${columns("w", LINE_ACCOUNT_COLUMNS.filter((c) => c !== "diners"), { orderId: "id" })},
    w."at", ${s.bizDate} AS "bizDate", ${s.hour} AS "hour", ${s.dow} AS "dow",
    w."gross", w."discount", w."tax", w."net", w."units",
    ${item ? Prisma.sql`NULL::numeric` : Prisma.sql`(CASE WHEN w."opening" = 1 THEN w."tipCents" ELSE 0 END)::numeric`} AS "tip",
    ${item ? Prisma.sql`NULL::numeric` : Prisma.sql`(CASE WHEN w."opening" = 1 THEN w."commissionCents" END)::numeric`} AS "commission",
    CASE WHEN w."opening" = 1 THEN w."diners" ELSE 0 END AS "diners",
    w."opening" AS "opens",
    CASE WHEN w."opening" = 1 THEN w."acctNet" ELSE 0 END AS "accountNet",
    CASE WHEN w."opening" = 1 THEN w."acctUnits" ELSE 0 END AS "accountUnits"
  FROM (
    SELECT fg.*,
      SUM(fg."net") OVER (PARTITION BY fg."orderId") AS "acctNet",
      SUM(fg."units") OVER (PARTITION BY fg."orderId") AS "acctUnits",
      SUM(fg."lines") OVER (PARTITION BY fg."orderId") AS "acctLines"
    FROM fg
  ) w
  WHERE ${inSliceOf(scope, Prisma.sql`w."at"`)}${item ? Prisma.sql` AND w."acctLines" > 0` : Prisma.empty}
)`;
}

// ── Consultas ──────────────────────────────────────────────────────────────

/**
 * Totales del período (cuentas, comensales, dinero y cortesías). Las
 * cortesías, con eje «pedido», también van por el instante en que se montó
 * la línea regalada (la cortesía de cuenta completa sin detalle, por la
 * apertura de la cuenta).
 */
export function totalsSql(scope: SalesScope): Prisma.Sql {
  const item = hasItemFilter(scope);
  const pedido = byOrder(scope);
  return Prisma.sql`${salesCtes(scope)}
SELECT
  (SELECT COALESCE(SUM(f."opens"), 0) FROM f)::bigint AS "orders",
  (SELECT COALESCE(SUM(f."diners"), 0) FROM f)::bigint AS "diners",
  (SELECT COALESCE(SUM(f."units"), 0) FROM f)::bigint AS "units",
  (SELECT ROUND(COALESCE(SUM(f."gross"), 0)) FROM f)::bigint AS "grossCents",
  (SELECT ROUND(COALESCE(SUM(f."discount"), 0)) FROM f)::bigint AS "discountCents",
  (SELECT ROUND(COALESCE(SUM(f."tax"), 0)) FROM f)::bigint AS "taxCents",
  (SELECT ROUND(COALESCE(SUM(f."net"), 0)) FROM f)::bigint AS "netCents",
  (SELECT ROUND(SUM(f."tip")) FROM f)::bigint AS "tipCents",
  (SELECT ROUND(COALESCE(SUM(f."accountNet"), 0)) FROM f)::bigint AS "accountNetCents",
  (SELECT COALESCE(SUM(f."accountUnits"), 0) FROM f)::bigint AS "accountUnits",
  (
    (SELECT COALESCE(SUM(it."priceCentsSnapshot"::bigint * it."qty"), 0)
      FROM o JOIN "OrderItem" it ON it."orderId" = o."id"
      LEFT JOIN "Round" r ON r."id" = it."roundId"
      LEFT JOIN "MenuItem" mi ON mi."id" = it."menuItemId" AND mi."restaurantId" = ${scope.restaurantId}
      WHERE ${COMP_LINE} AND ${lineMatch(scope)}${pedido
        ? Prisma.sql` AND ${inSliceOf(scope, Prisma.sql`COALESCE(r."placedAt", o."openedAt")`)}`
        : Prisma.empty})
    + ${item ? Prisma.sql`0` : Prisma.sql`(SELECT COALESCE(SUM(o."compAmountCents"), 0) FROM o
      WHERE o."compedAt" IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM "OrderItem" it LEFT JOIN "Round" r ON r."id" = it."roundId"
        WHERE it."orderId" = o."id" AND ${COMP_LINE})${pedido
          ? Prisma.sql` AND ${inSliceOf(scope, Prisma.sql`o."anchorAt"`)}`
          : Prisma.empty})`}
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
  ROUND(SUM(f."net"))::bigint AS "netCents", SUM(f."opens")::bigint AS "orders",
  COALESCE(SUM(f."diners"), 0)::bigint AS "diners",
  ROUND(SUM(f."accountNet"))::bigint AS "accountNetCents"
FROM f GROUP BY 1 ORDER BY 1`;
}

export function heatSql(scope: SalesScope): Prisma.Sql {
  return Prisma.sql`${salesCtes(scope)}
SELECT f."dow"::int AS "dow", f."hour"::int AS "hour",
  ROUND(SUM(f."net"))::bigint AS "netCents", SUM(f."opens")::bigint AS "orders"
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
WHERE lf."match" AND lf."inSlice"
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
WHERE lf."match" AND lf."inSlice"
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
WHERE lf."match" AND lf."inSlice" AND sel."opt" <> ''
GROUP BY 1, 2
ORDER BY "units" DESC, "option" ASC
LIMIT ${limit}`;
}

export function waitersSql(scope: SalesScope): Prisma.Sql {
  return Prisma.sql`${salesCtes(scope)}
SELECT f."waiterId", MAX(COALESCE(NULLIF(btrim(u."name"), ''), u."email")) AS "name",
  ROUND(SUM(f."net"))::bigint AS "netCents", SUM(f."opens")::bigint AS "orders",
  COALESCE(SUM(f."diners"), 0)::bigint AS "diners",
  ROUND(SUM(f."tip"))::bigint AS "tipCents",
  ROUND(SUM(f."commission"))::bigint AS "commissionCents",
  ROUND(SUM(f."accountNet"))::bigint AS "accountNetCents"
FROM f LEFT JOIN "User" u ON u."id" = f."waiterId"
GROUP BY 1
ORDER BY "netCents" DESC`;
}

/**
 * Cobrado por método (aprobado y luego devuelto: lo que se cobró, como el
 * asiento de ventas). Los pagos son de la cuenta: van en su tajada de
 * apertura (con eje «pago», la única).
 */
export function methodsSql(scope: SalesScope): Prisma.Sql {
  return Prisma.sql`${salesCtes(scope)}
SELECT CASE WHEN p."method"::text IN ('cash', 'demo_cash') THEN 'cash' ELSE p."method"::text END AS "method",
  COALESCE(SUM(p."amountCents"), 0)::bigint AS "amountCents",
  COALESCE(SUM(p."tipCents"), 0)::bigint AS "tipCents",
  COUNT(*)::bigint AS "payments",
  COUNT(DISTINCT p."orderId")::bigint AS "orders"
FROM f JOIN "Payment" p ON p."orderId" = f."id"
WHERE f."opens" = 1 AND p."status" IN ('approved', 'refunded')
GROUP BY 1
ORDER BY "amountCents" DESC`;
}

export function channelsSql(scope: SalesScope): Prisma.Sql {
  return Prisma.sql`${salesCtes(scope)}
SELECT f."channel", ROUND(SUM(f."net"))::bigint AS "netCents", SUM(f."opens")::bigint AS "orders",
  COALESCE(SUM(f."diners"), 0)::bigint AS "diners",
  ROUND(SUM(f."accountNet"))::bigint AS "accountNetCents"
FROM f GROUP BY 1 ORDER BY "netCents" DESC`;
}

export function tablesSql(scope: SalesScope, limit: number): Prisma.Sql {
  return Prisma.sql`${salesCtes(scope)}
SELECT f."tableId", MAX(f."tableNumber")::int AS "number", MAX(f."tableLabel") AS "label",
  ROUND(SUM(f."net"))::bigint AS "netCents", SUM(f."opens")::bigint AS "orders",
  COALESCE(SUM(f."diners"), 0)::bigint AS "diners",
  ROUND(SUM(f."accountNet"))::bigint AS "accountNetCents"
FROM f WHERE f."channel" = 'salon'
GROUP BY 1 ORDER BY "netCents" DESC LIMIT ${limit}`;
}

/**
 * Duración de la mesa: de la apertura (primera ronda viva, o la orden
 * montada o creada) al pago, sólo en salón y una vez por cuenta (su tajada
 * de apertura). Mediana, que no la mueven las cuentas olvidadas abiertas; se
 * descartan las de menos de 1 minuto y más de 12 horas.
 */
export function durationSql(scope: SalesScope): Prisma.Sql {
  return Prisma.sql`${salesCtes(scope)}
SELECT
  percentile_cont(0.5) WITHIN GROUP (ORDER BY d."mins") FILTER (WHERE d."mins" >= 1 AND d."mins" <= 720) AS "median",
  COUNT(*) FILTER (WHERE d."mins" >= 1 AND d."mins" <= 720)::bigint AS "measured",
  COUNT(*)::bigint AS "eligible"
FROM (
  SELECT EXTRACT(EPOCH FROM (f."paidAt" - f."openedAt")) / 60 AS "mins"
  FROM f
  WHERE f."channel" = 'salon' AND f."opens" = 1
) d`;
}

/**
 * Cuentas del período (el detalle del día), con métodos y mesero: toda
 * cuenta con alguna tajada en el período, con los montos de esas tajadas
 * (así la lista suma lo mismo que los indicadores). De la más reciente a la
 * más antigua según el eje: apertura o pago.
 */
export function ordersSql(scope: SalesScope, limit: number): Prisma.Sql {
  return Prisma.sql`${salesCtes(scope)}
SELECT g."id", g."shortCode", g."openedAt", g."paidAt", g."channel", g."tableNumber", g."tableLabel",
  COALESCE(NULLIF(btrim(u."name"), ''), u."email") AS "waiterName",
  g."diners", g."units", g."netCents", g."tipCents", g."totalCents",
  COALESCE((
    SELECT array_agg(DISTINCT CASE WHEN p."method"::text IN ('cash', 'demo_cash') THEN 'cash' ELSE p."method"::text END)
    FROM "Payment" p WHERE p."orderId" = g."id" AND p."status" IN ('approved', 'refunded')
  ), ARRAY[]::text[]) AS "methods"
FROM (
  SELECT f."id", f."shortCode", f."openedAt", f."paidAt", f."channel", f."tableNumber", f."tableLabel",
    f."waiterId", f."totalCents",
    COALESCE(SUM(f."diners"), 0)::bigint AS "diners", COALESCE(SUM(f."units"), 0)::bigint AS "units",
    ROUND(SUM(f."net"))::bigint AS "netCents", ROUND(SUM(f."tip"))::bigint AS "tipCents"
  FROM f
  GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9
) g LEFT JOIN "User" u ON u."id" = g."waiterId"
ORDER BY ${byOrder(scope) ? Prisma.sql`g."openedAt"` : Prisma.sql`g."paidAt"`} DESC
LIMIT ${limit}`;
}

/** Cuentas de `ids` que pasan los filtros de cuenta (para notas y reembolsos). */
export function filterOrderIdsSql(scope: SalesScope, ids: readonly string[]): Prisma.Sql {
  return Prisma.sql`${salesCtes(scope, { kind: "ids", ids })}
SELECT o."id" FROM o`;
}
