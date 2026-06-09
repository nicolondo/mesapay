# Pulso Plan 2 — Herramientas de analítica + captura de búsquedas

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Completar el catálogo de Pulso con las 12 herramientas de analítica restantes (Plan 1 entregó `top_dishes`) y la captura de búsquedas del comensal (`SearchEvent`) que alimenta `top_searches`.

**Architecture:** Cada herramienta sigue el patrón ya desplegado en `src/lib/ai/tools/topDishes.ts`: (1) una **función pura de agregación** testeada con fixtures (sin DB), (2) un `ToolDef` con `inputSchema` Zod + `jsonSchema` para Claude + `run()` que hace un fetch Prisma **siempre filtrado por `ctx.scope.restaurantId`** (frontera de seguridad multi-tenant — el modelo nunca elige el comercio), devolviendo **agregados compactos** (nunca filas crudas). Se registran en `src/lib/ai/toolRegistry.ts`. El scope de grupo (multi-sucursal) es Plan 3 — acá todas las tools usan scope de restaurante, igual que `top_dishes`.

**Tech Stack:** TypeScript, Zod, Prisma/Postgres, `@anthropic-ai/sdk`, vitest, next-intl, `Intl.DateTimeFormat` para buckets por zona horaria.

---

## Patrón compartido (leer una vez; aplica a TODAS las tools)

**Referencia canónica:** `src/lib/ai/tools/topDishes.ts` (ya en producción). Cada nueva tool lo replica.

**Tipos** (`src/lib/ai/tools/types.ts`, ya existe — NO modificar):
```ts
export type ToolContext = { scope: InsightsScope; timezone: string };
export type ToolDef<I> = {
  name: string; description: string;
  inputSchema: ZodTypeAny; jsonSchema: Record<string, unknown>;
  run: (input: I, ctx: ToolContext) => Promise<unknown>;
};
```
`ctx.scope.restaurantId` = string del comercio (inyectado por el server). `ctx.timezone` = IANA tz (ej. `"America/Bogota"`), ya resuelta del país.

**Rango de fechas:** se reutiliza `resolveRange(input.range)` de `src/lib/ai/tools/dateRange.ts`. La Task 0 extrae los schemas de rango compartidos (`rangeInputZod`, `rangeJsonSchema`) para no repetirlos en 12 archivos.

**Reglas de datos (confirmadas contra `prisma/schema.prisma`):**
- "Orden pagada" = `Order.paidAt != null`. El rango de fechas de ventas filtra por `order.paidAt: { gte: from, lte: to }`.
- "Pago aprobado" = `Payment.status = "approved"` (enum `PaymentStatus`: pending/approved/declined/refunded).
- Ítems válidos (no cancelados) = `OrderItem.cancelledAt = null`.
- `cancellationKind` ("cancel" | "comp") vive en **`OrderItem`** (NO en `Round`).
- Propinas = `Payment.tipCents`. Método = `Payment.method` (enum `PaymentMethod`).
- Mesero que cobró = `Payment.collectedByUserId` → `User.name`.
- Reserva no-show = `Reservation.status = "no_show"`; depósito = `Reservation.depositStatus` (none/pending/paid/applied/forfeited/refunded) + `depositCents`.
- Prep time de cocina: `OrderItem.preparationStartedAt` → `OrderItem.servedAt`; target = `OrderItem.prepMinutesSnapshot`; estación = `OrderItem.station` (enum `PrepStation`: kitchen/bar/counter).
- Categoría de un ítem: `OrderItem.menuItem.category.label` / `.kind` (enum `CategoryKind`).
- Comensales de una orden = `Order.diners` (Int).

**Estructura de cada Task de tool:**
1. Escribir el test del agregador puro (fixtures + números esperados) → corre y FALLA.
2. Escribir el agregador puro → test PASA.
3. Escribir el `ToolDef` (schema + `run` con fetch Prisma scopeado).
4. `npm test` (el archivo) → verde. `git add` de los 2 archivos nuevos + commit.

**Verificación por tool:** `npx vitest run src/lib/ai/tools/<tool>.test.ts`. El registro en el registry y el build entero se hacen en la Task 16.

**git hygiene (CRÍTICO, todas las tasks):** el árbol tiene cambios sin commitear de otra sesión (MenuClient.tsx, brand-kit/, docs/*.pdf, scripts/*.py, etc.). **NUNCA `git add -A`/`.`/`-u`.** Stagear solo los archivos explícitos de cada task. **No push** (el deploy lo dispara el controlador al final).

---

## Task 0: Extraer schemas de rango compartidos (DRY)

**Files:**
- Modify: `src/lib/ai/tools/dateRange.ts`
- Test: `src/lib/ai/tools/dateRange.test.ts` (ya existe; se le agrega 1 caso)

- [ ] **Step 1: Agregar test de los schemas compartidos**

Agregar al final de `src/lib/ai/tools/dateRange.test.ts`:
```ts
import { rangeInputZod } from "./dateRange";

describe("rangeInputZod", () => {
  it("default es preset 30d", () => {
    expect(rangeInputZod.parse(undefined)).toEqual({ preset: "30d" });
  });
  it("acepta from/to", () => {
    expect(rangeInputZod.parse({ from: "2026-01-01", to: "2026-02-01" })).toEqual({
      from: "2026-01-01",
      to: "2026-02-01",
    });
  });
});
```

- [ ] **Step 2: Run → falla** (`rangeInputZod` no existe)

Run: `npx vitest run src/lib/ai/tools/dateRange.test.ts`
Expected: FAIL ("rangeInputZod is not exported").

- [ ] **Step 3: Implementar los schemas compartidos**

Agregar a `src/lib/ai/tools/dateRange.ts` (importar zod arriba):
```ts
import { z } from "zod";

export const rangeInputZod = z
  .union([
    z.object({ preset: z.enum(["7d", "30d", "90d", "mtd", "qtd"]) }),
    z.object({ from: z.string(), to: z.string() }),
  ])
  .default({ preset: "30d" });

export const rangeJsonSchema = {
  description: "Rango de fechas. Default últimos 30 días.",
  oneOf: [
    { type: "object", properties: { preset: { enum: ["7d", "30d", "90d", "mtd", "qtd"] } }, required: ["preset"] },
    { type: "object", properties: { from: { type: "string" }, to: { type: "string" } }, required: ["from", "to"] },
  ],
} as const;
```

- [ ] **Step 4: Run → pasa**

Run: `npx vitest run src/lib/ai/tools/dateRange.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src/lib/ai/tools/dateRange.ts src/lib/ai/tools/dateRange.test.ts
git commit -m "feat(pulso): shared range zod+json schemas (DRY for plan-2 tools)"
```

---

## Task 1: Helper de buckets por zona horaria

**Files:**
- Create: `src/lib/ai/tools/timeBuckets.ts`
- Test: `src/lib/ai/tools/timeBuckets.test.ts`

Usado por `traffic_by_time`, `revenue_trend`, `kitchen_bottlenecks`, `cancellations`, `staffing_estimate`. Convierte un `Date` (UTC) a partes locales en la tz del comercio, de forma pura y determinística vía `Intl.DateTimeFormat`.

- [ ] **Step 1: Test**
```ts
import { describe, it, expect } from "vitest";
import { localParts, dateKeyInTz } from "./timeBuckets";

describe("localParts", () => {
  it("convierte UTC a hora local de Bogotá (UTC-5)", () => {
    // 2026-03-10T02:30:00Z = 2026-03-09 21:30 en Bogotá
    const p = localParts(new Date("2026-03-10T02:30:00Z"), "America/Bogota");
    expect(p.dateKey).toBe("2026-03-09");
    expect(p.hour).toBe(21);
    expect(p.dow).toBe(1); // lunes
  });
  it("dow: 0=domingo .. 6=sábado", () => {
    // 2026-03-08 es domingo
    const p = localParts(new Date("2026-03-08T15:00:00Z"), "America/Bogota");
    expect(p.dow).toBe(0);
  });
});

describe("dateKeyInTz", () => {
  it("agrupa por semana ISO (lunes) y mes", () => {
    expect(dateKeyInTz(new Date("2026-03-10T12:00:00Z"), "America/Bogota", "month")).toBe("2026-03");
    expect(dateKeyInTz(new Date("2026-03-10T12:00:00Z"), "America/Bogota", "day")).toBe("2026-03-10");
  });
});
```

- [ ] **Step 2: Run → falla.** Run: `npx vitest run src/lib/ai/tools/timeBuckets.test.ts` → FAIL.

- [ ] **Step 3: Implementar**
```ts
export type LocalParts = { dateKey: string; hour: number; dow: number; weekday: string };

const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function localParts(d: Date, timeZone: string): LocalParts {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", hour12: false, weekday: "short",
  });
  const parts = fmt.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const year = get("year"), month = get("month"), day = get("day");
  let hour = parseInt(get("hour"), 10);
  if (hour === 24) hour = 0; // algunos runtimes devuelven 24
  const weekday = get("weekday");
  return { dateKey: `${year}-${month}-${day}`, hour, dow: WD[weekday] ?? 0, weekday };
}

export function dateKeyInTz(d: Date, timeZone: string, bucket: "day" | "week" | "month"): string {
  const p = localParts(d, timeZone);
  if (bucket === "month") return p.dateKey.slice(0, 7);
  if (bucket === "day") return p.dateKey;
  // week: retroceder al lunes
  const [y, m, dd] = p.dateKey.split("-").map(Number);
  const base = new Date(Date.UTC(y, m - 1, dd));
  const isoDow = p.dow === 0 ? 7 : p.dow; // 1..7, lunes=1
  base.setUTCDate(base.getUTCDate() - (isoDow - 1));
  return base.toISOString().slice(0, 10);
}
```

- [ ] **Step 4: Run → pasa.** Run: `npx vitest run src/lib/ai/tools/timeBuckets.test.ts` → PASS.

- [ ] **Step 5: Commit**
```bash
git add src/lib/ai/tools/timeBuckets.ts src/lib/ai/tools/timeBuckets.test.ts
git commit -m "feat(pulso): pure tz time-bucket helper"
```

---

## Task 2: `SearchEvent` model (schema)

**Files:**
- Modify: `prisma/schema.prisma`

⚠️ NO correr `prisma db push`/`migrate` (el `.env` local puede apuntar a prod). Solo editar el schema; la migración la aplica el deploy del controlador. Verificar con `npx prisma validate`.

- [ ] **Step 1: Agregar el modelo** (después del modelo `AiMessage`, junto a los modelos de IA):
```prisma
model SearchEvent {
  id           String     @id @default(cuid())
  restaurantId String
  restaurant   Restaurant @relation(fields: [restaurantId], references: [id], onDelete: Cascade)
  term         String
  rawTerm      String
  resultCount  Int
  hadResults   Boolean
  locale       String?
  createdAt    DateTime   @default(now())

  @@index([restaurantId, createdAt])
  @@index([restaurantId, term])
}
```

- [ ] **Step 2: Agregar la relación inversa en `Restaurant`** — junto a las otras relaciones (ej. después de `aiConversations AiConversation[]`):
```prisma
  searchEvents       SearchEvent[]
```

- [ ] **Step 3: Validar**

Run: `npx prisma validate`
Expected: "The schema at prisma/schema.prisma is valid 🚀"

- [ ] **Step 4: Generar el client** (local, no toca DB)

Run: `npx prisma generate`
Expected: genera sin error (tipos `SearchEvent` disponibles).

- [ ] **Step 5: Commit**
```bash
git add prisma/schema.prisma
git commit -m "schema(pulso): SearchEvent (captura de búsquedas del comensal)"
```

---

## Task 3: Normalización de término + endpoint search-log

**Files:**
- Create: `src/lib/ai/searchTerm.ts`
- Test: `src/lib/ai/searchTerm.test.ts`
- Create: `src/app/api/tenant/[slug]/search-log/route.ts`

- [ ] **Step 1: Test de normalización**
```ts
import { describe, it, expect } from "vitest";
import { normalizeTerm } from "./searchTerm";

describe("normalizeTerm", () => {
  it("lower + sin acentos + trim + colapsa espacios", () => {
    expect(normalizeTerm("  Café   con Leche ")).toBe("cafe con leche");
    expect(normalizeTerm("ÑOQUIS")).toBe("noquis");
  });
  it("vacío o <2 chars → null", () => {
    expect(normalizeTerm(" ")).toBeNull();
    expect(normalizeTerm("a")).toBeNull();
  });
});
```

- [ ] **Step 2: Run → falla.** Run: `npx vitest run src/lib/ai/searchTerm.test.ts` → FAIL.

- [ ] **Step 3: Implementar `normalizeTerm`**
```ts
/** lower, sin acentos, trim, espacios colapsados. Devuelve null si <2 chars. */
export function normalizeTerm(raw: string): string | null {
  const t = raw
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
  return t.length >= 2 ? t : null;
}
```

- [ ] **Step 4: Run → pasa.** Run: `npx vitest run src/lib/ai/searchTerm.test.ts` → PASS.

- [ ] **Step 5: Endpoint fire-and-forget**

Crear `src/app/api/tenant/[slug]/search-log/route.ts`. Patrón de otras rutas tenant (resolver restaurante por `slug`). Sin auth (es el comensal). Body: `{ term: string, resultCount: number, locale?: string }`. Normaliza; si null, devuelve 204 sin escribir. No bloquea — best-effort.
```ts
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { normalizeTerm } from "@/lib/ai/searchTerm";

export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  let body: { term?: string; resultCount?: number; locale?: string };
  try {
    body = await req.json();
  } catch {
    return new NextResponse(null, { status: 204 });
  }
  const term = normalizeTerm(String(body.term ?? ""));
  if (!term) return new NextResponse(null, { status: 204 });

  const restaurant = await db.restaurant.findUnique({ where: { slug }, select: { id: true } });
  if (!restaurant) return new NextResponse(null, { status: 204 });

  const resultCount = Number.isFinite(body.resultCount) ? Math.max(0, Math.trunc(body.resultCount as number)) : 0;
  try {
    await db.searchEvent.create({
      data: {
        restaurantId: restaurant.id,
        term,
        rawTerm: String(body.term ?? "").slice(0, 120),
        resultCount,
        hadResults: resultCount > 0,
        locale: body.locale ? String(body.locale).slice(0, 5) : null,
      },
    });
  } catch {
    // best-effort: nunca rompemos la búsqueda del comensal
  }
  return new NextResponse(null, { status: 204 });
}
```

- [ ] **Step 6: Commit**
```bash
git add src/lib/ai/searchTerm.ts src/lib/ai/searchTerm.test.ts "src/app/api/tenant/[slug]/search-log/route.ts"
git commit -m "feat(pulso): search-log endpoint + term normalizer"
```

---

## Task 4: Captura de búsquedas en el menú del comensal

**Files:**
- Modify: `src/app/t/[slug]/menu/MenuClient.tsx` (el buscador ya existe)

Esta es la única task que toca el archivo grande con cambios de la otra sesión. Procede así: leé el componente, encontrá el estado del input de búsqueda (`query`/`search`) y la cuenta de resultados filtrados, y agregá un efecto con **debounce ~800ms** que dispara el POST `fire-and-forget` cuando el usuario pausa de escribir (mínimo 2 chars). No cambies nada del comportamiento de búsqueda existente.

- [ ] **Step 1: Agregar el efecto de captura** cerca de donde se computa la lista filtrada. Usar el slug ya disponible en el componente y el conteo de resultados ya calculado:
```tsx
// Captura de búsquedas para Pulso (fire-and-forget, no bloquea la UI).
useEffect(() => {
  const q = (query ?? "").trim();
  if (q.length < 2) return;
  const id = setTimeout(() => {
    try {
      navigator.sendBeacon?.(
        `/api/tenant/${slug}/search-log`,
        new Blob([JSON.stringify({ term: q, resultCount: filteredCount, locale })], { type: "application/json" }),
      );
    } catch {
      // ignore
    }
  }, 800);
  return () => clearTimeout(id);
}, [query, filteredCount, slug, locale]);
```
Notas para el implementador:
- Reemplazá `query` por el nombre real del estado del input, `filteredCount` por la longitud real de la lista filtrada que ve el usuario (`filtered.length`), y `locale` por el locale disponible (o quitalo del body si no está a mano).
- Si `sendBeacon` no está, hacé fallback a `fetch(url, { method: "POST", body, keepalive: true }).catch(() => {})`.
- Asegurate de que `useEffect` esté importado.

- [ ] **Step 2: Verificar build**

Run: `npm run build`
Expected: compila sin errores nuevos.

- [ ] **Step 3: Commit**
```bash
git add "src/app/t/[slug]/menu/MenuClient.tsx"
git commit -m "feat(pulso): capturar búsquedas del comensal (debounced beacon)"
```
⚠️ Solo stagear MenuClient.tsx. NO usar `git add -A`.

---

## Task 5: Tool `top_searches`

**Files:**
- Create: `src/lib/ai/tools/topSearches.ts`
- Test: `src/lib/ai/tools/topSearches.test.ts`

- [ ] **Step 1: Test del agregador**
```ts
import { describe, it, expect } from "vitest";
import { aggregateSearches, type SearchRow } from "./topSearches";

const rows: SearchRow[] = [
  { term: "pizza", hadResults: true },
  { term: "pizza", hadResults: true },
  { term: "sushi", hadResults: false },
  { term: "sushi", hadResults: false },
  { term: "vino", hadResults: true },
];

describe("aggregateSearches", () => {
  it("cuenta por término y % sin resultados, ordena por count desc", () => {
    const r = aggregateSearches(rows, { limit: 10 });
    expect(r.terms[0]).toEqual({ term: "pizza", count: 2, noResultsPct: 0 });
    expect(r.terms).toContainEqual({ term: "sushi", count: 2, noResultsPct: 100 });
    expect(r.totalSearches).toBe(5);
  });
  it("separa los términos sin resultados más frecuentes", () => {
    const r = aggregateSearches(rows, { limit: 10 });
    expect(r.topNoResults[0]).toEqual({ term: "sushi", count: 2 });
  });
});
```

- [ ] **Step 2: Run → falla.** `npx vitest run src/lib/ai/tools/topSearches.test.ts` → FAIL.

- [ ] **Step 3: Implementar agregador + ToolDef**
```ts
import { z } from "zod";
import { db } from "@/lib/db";
import type { ToolContext, ToolDef } from "./types";
import { rangeInputZod, rangeJsonSchema } from "./dateRange";
import { resolveRange } from "./dateRange";

export type SearchRow = { term: string; hadResults: boolean };

export function aggregateSearches(rows: SearchRow[], opts: { limit: number }) {
  const map = new Map<string, { count: number; noResults: number }>();
  for (const r of rows) {
    const cur = map.get(r.term) ?? { count: 0, noResults: 0 };
    cur.count += 1;
    if (!r.hadResults) cur.noResults += 1;
    map.set(r.term, cur);
  }
  const all = [...map.entries()].map(([term, v]) => ({
    term,
    count: v.count,
    noResultsPct: Math.round((v.noResults / v.count) * 100),
  }));
  const terms = [...all].sort((a, b) => b.count - a.count).slice(0, opts.limit);
  const topNoResults = [...map.entries()]
    .filter(([, v]) => v.noResults > 0)
    .map(([term, v]) => ({ term, count: v.noResults }))
    .sort((a, b) => b.count - a.count)
    .slice(0, opts.limit);
  return { totalSearches: rows.length, terms, topNoResults };
}

const inputSchema = z.object({
  range: rangeInputZod,
  limit: z.number().int().min(1).max(25).default(10),
});
type Input = z.infer<typeof inputSchema>;

export const topSearchesTool: ToolDef<Input> = {
  name: "top_searches",
  description:
    "Términos que más buscan los comensales en la carta y qué porcentaje no " +
    "arrojó resultados (demanda insatisfecha). Útil para '¿qué busca la gente?' " +
    "y '¿qué buscan y no encuentran?'.",
  inputSchema,
  jsonSchema: {
    type: "object",
    properties: {
      range: rangeJsonSchema,
      limit: { type: "integer", minimum: 1, maximum: 25 },
    },
  },
  async run(input, ctx) {
    const { from, to } = resolveRange(input.range);
    const events = await db.searchEvent.findMany({
      where: { restaurantId: ctx.scope.restaurantId, createdAt: { gte: from, lte: to } },
      select: { term: true, hadResults: true },
    });
    return {
      range: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
      ...aggregateSearches(events, { limit: input.limit }),
    };
  },
};
```

- [ ] **Step 4: Run → pasa.** `npx vitest run src/lib/ai/tools/topSearches.test.ts` → PASS.

- [ ] **Step 5: Commit**
```bash
git add src/lib/ai/tools/topSearches.ts src/lib/ai/tools/topSearches.test.ts
git commit -m "feat(pulso): top_searches tool (+ % sin resultados)"
```

---

## Task 6: Tool `sales_overview`

**Files:**
- Create: `src/lib/ai/tools/salesOverview.ts`
- Test: `src/lib/ai/tools/salesOverview.test.ts`

Devuelve ventas, # órdenes, ticket promedio, comensales, y comparación vs el período anterior de igual duración.

- [ ] **Step 1: Test del agregador**
```ts
import { describe, it, expect } from "vitest";
import { summarizeSales, type OrderRow } from "./salesOverview";

const cur: OrderRow[] = [
  { totalCents: 10000, diners: 2 },
  { totalCents: 30000, diners: 4 },
];
const prev: OrderRow[] = [{ totalCents: 20000, diners: 2 }];

describe("summarizeSales", () => {
  it("agrega y compara vs período anterior", () => {
    const r = summarizeSales(cur, prev);
    expect(r.revenueCents).toBe(40000);
    expect(r.orders).toBe(2);
    expect(r.avgTicketCents).toBe(20000);
    expect(r.diners).toBe(6);
    expect(r.revenueChangePct).toBe(100); // 40000 vs 20000
  });
  it("período anterior vacío → change null", () => {
    expect(summarizeSales(cur, []).revenueChangePct).toBeNull();
  });
});
```

- [ ] **Step 2: Run → falla.** `npx vitest run src/lib/ai/tools/salesOverview.test.ts` → FAIL.

- [ ] **Step 3: Implementar**
```ts
import { z } from "zod";
import { db } from "@/lib/db";
import type { ToolContext, ToolDef } from "./types";
import { rangeInputZod, rangeJsonSchema, resolveRange } from "./dateRange";

export type OrderRow = { totalCents: number; diners: number };

function totals(rows: OrderRow[]) {
  const revenueCents = rows.reduce((s, r) => s + r.totalCents, 0);
  const orders = rows.length;
  const diners = rows.reduce((s, r) => s + r.diners, 0);
  return { revenueCents, orders, diners, avgTicketCents: orders ? Math.round(revenueCents / orders) : 0 };
}

export function summarizeSales(cur: OrderRow[], prev: OrderRow[]) {
  const c = totals(cur);
  const p = totals(prev);
  const pct = (now: number, before: number) => (before > 0 ? Math.round(((now - before) / before) * 100) : null);
  return {
    ...c,
    previous: p,
    revenueChangePct: pct(c.revenueCents, p.revenueCents),
    ordersChangePct: pct(c.orders, p.orders),
  };
}

const inputSchema = z.object({ range: rangeInputZod });
type Input = z.infer<typeof inputSchema>;

export const salesOverviewTool: ToolDef<Input> = {
  name: "sales_overview",
  description:
    "Resumen de ventas del período: ingresos, # de órdenes, ticket promedio y " +
    "comensales, con comparación vs el período anterior de igual duración. " +
    "Útil para '¿cómo van las ventas?' y '¿estoy creciendo?'.",
  inputSchema,
  jsonSchema: { type: "object", properties: { range: rangeJsonSchema } },
  async run(input, ctx) {
    const { from, to } = resolveRange(input.range);
    const span = to.getTime() - from.getTime();
    const prevFrom = new Date(from.getTime() - span);
    const sel = { select: { totalCents: true, diners: true } };
    const [cur, prev] = await Promise.all([
      db.order.findMany({ where: { restaurantId: ctx.scope.restaurantId, paidAt: { gte: from, lte: to } }, ...sel }),
      db.order.findMany({ where: { restaurantId: ctx.scope.restaurantId, paidAt: { gte: prevFrom, lt: from } }, ...sel }),
    ]);
    return {
      range: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
      ...summarizeSales(cur, prev),
    };
  },
};
```

- [ ] **Step 4: Run → pasa.** → PASS.
- [ ] **Step 5: Commit**
```bash
git add src/lib/ai/tools/salesOverview.ts src/lib/ai/tools/salesOverview.test.ts
git commit -m "feat(pulso): sales_overview tool (vs período anterior)"
```

---

## Task 7: Tool `revenue_trend`

**Files:** Create `src/lib/ai/tools/revenueTrend.ts` + `.test.ts`

Serie temporal por día/semana/mes (en tz del comercio) + crecimiento % punta a punta.

- [ ] **Step 1: Test**
```ts
import { describe, it, expect } from "vitest";
import { aggregateTrend, type PaidOrder } from "./revenueTrend";

const rows: PaidOrder[] = [
  { paidAt: new Date("2026-03-01T15:00:00Z"), totalCents: 10000 },
  { paidAt: new Date("2026-03-01T18:00:00Z"), totalCents: 5000 },
  { paidAt: new Date("2026-03-02T15:00:00Z"), totalCents: 20000 },
];

describe("aggregateTrend", () => {
  it("agrupa por día y calcula crecimiento punta a punta", () => {
    const r = aggregateTrend(rows, { bucket: "day", timezone: "America/Bogota" });
    expect(r.points).toEqual([
      { period: "2026-03-01", revenueCents: 15000, orders: 2 },
      { period: "2026-03-02", revenueCents: 20000, orders: 1 },
    ]);
    expect(r.growthPct).toBe(33); // 15000 → 20000
  });
});
```

- [ ] **Step 2: Run → falla.**

- [ ] **Step 3: Implementar**
```ts
import { z } from "zod";
import { db } from "@/lib/db";
import type { ToolDef } from "./types";
import { rangeInputZod, rangeJsonSchema, resolveRange } from "./dateRange";
import { dateKeyInTz } from "./timeBuckets";

export type PaidOrder = { paidAt: Date; totalCents: number };

export function aggregateTrend(rows: PaidOrder[], opts: { bucket: "day" | "week" | "month"; timezone: string }) {
  const map = new Map<string, { revenueCents: number; orders: number }>();
  for (const r of rows) {
    const key = dateKeyInTz(r.paidAt, opts.timezone, opts.bucket);
    const cur = map.get(key) ?? { revenueCents: 0, orders: 0 };
    cur.revenueCents += r.totalCents;
    cur.orders += 1;
    map.set(key, cur);
  }
  const points = [...map.entries()]
    .map(([period, v]) => ({ period, ...v }))
    .sort((a, b) => a.period.localeCompare(b.period));
  const first = points[0]?.revenueCents ?? 0;
  const last = points[points.length - 1]?.revenueCents ?? 0;
  const growthPct = first > 0 ? Math.round(((last - first) / first) * 100) : null;
  return { points, growthPct };
}

const inputSchema = z.object({
  range: rangeInputZod,
  bucket: z.enum(["day", "week", "month"]).default("day"),
});
type Input = z.infer<typeof inputSchema>;

export const revenueTrendTool: ToolDef<Input> = {
  name: "revenue_trend",
  description:
    "Tendencia de ingresos como serie temporal (por día, semana o mes) con el " +
    "crecimiento porcentual del período. Útil para ver si las ventas suben o bajan.",
  inputSchema,
  jsonSchema: {
    type: "object",
    properties: {
      range: rangeJsonSchema,
      bucket: { type: "string", enum: ["day", "week", "month"], description: "Granularidad de la serie." },
    },
  },
  async run(input, ctx) {
    const { from, to } = resolveRange(input.range);
    const rows = await db.order.findMany({
      where: { restaurantId: ctx.scope.restaurantId, paidAt: { gte: from, lte: to } },
      select: { paidAt: true, totalCents: true },
    });
    return {
      range: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
      bucket: input.bucket,
      ...aggregateTrend(
        rows.map((r) => ({ paidAt: r.paidAt as Date, totalCents: r.totalCents })),
        { bucket: input.bucket, timezone: ctx.timezone },
      ),
    };
  },
};
```

- [ ] **Step 4: Run → pasa.**
- [ ] **Step 5: Commit** `feat(pulso): revenue_trend tool`

---

## Task 8: Tool `category_breakdown`

**Files:** Create `src/lib/ai/tools/categoryBreakdown.ts` + `.test.ts`

Ventas por categoría (label) y por `kind` (comida/bebida/etc.), sobre ítems no cancelados de órdenes pagadas.

- [ ] **Step 1: Test**
```ts
import { describe, it, expect } from "vitest";
import { aggregateCategories, type CatRow } from "./categoryBreakdown";

const rows: CatRow[] = [
  { category: "Pizzas", kind: "main", qty: 2, priceCents: 10000 },
  { category: "Pizzas", kind: "main", qty: 1, priceCents: 12000 },
  { category: "Vinos", kind: "drink", qty: 3, priceCents: 8000 },
];

describe("aggregateCategories", () => {
  it("suma ingreso y qty por categoría, ordena por ingreso", () => {
    const r = aggregateCategories(rows, { limit: 10 });
    expect(r.categories[0]).toEqual({ category: "Pizzas", kind: "main", qty: 3, revenueCents: 32000 });
    expect(r.byKind).toContainEqual({ kind: "drink", revenueCents: 24000 });
    expect(r.totalRevenueCents).toBe(56000);
  });
});
```

- [ ] **Step 2: Run → falla.**

- [ ] **Step 3: Implementar**
```ts
import { z } from "zod";
import { db } from "@/lib/db";
import type { ToolDef } from "./types";
import { rangeInputZod, rangeJsonSchema, resolveRange } from "./dateRange";

export type CatRow = { category: string; kind: string; qty: number; priceCents: number };

export function aggregateCategories(rows: CatRow[], opts: { limit: number }) {
  const cat = new Map<string, { kind: string; qty: number; revenueCents: number }>();
  const kind = new Map<string, number>();
  let total = 0;
  for (const r of rows) {
    const rev = r.qty * r.priceCents;
    total += rev;
    const c = cat.get(r.category) ?? { kind: r.kind, qty: 0, revenueCents: 0 };
    c.qty += r.qty;
    c.revenueCents += rev;
    cat.set(r.category, c);
    kind.set(r.kind, (kind.get(r.kind) ?? 0) + rev);
  }
  const categories = [...cat.entries()]
    .map(([category, v]) => ({ category, ...v }))
    .sort((a, b) => b.revenueCents - a.revenueCents)
    .slice(0, opts.limit);
  const byKind = [...kind.entries()]
    .map(([k, revenueCents]) => ({ kind: k, revenueCents }))
    .sort((a, b) => b.revenueCents - a.revenueCents);
  return { totalRevenueCents: total, categories, byKind };
}

const inputSchema = z.object({ range: rangeInputZod, limit: z.number().int().min(1).max(30).default(15) });
type Input = z.infer<typeof inputSchema>;

export const categoryBreakdownTool: ToolDef<Input> = {
  name: "category_breakdown",
  description:
    "Ventas desglosadas por categoría de la carta y por tipo (comida, bebida, " +
    "postre, etc.). Útil para ver el peso de vinos/bebidas vs comida.",
  inputSchema,
  jsonSchema: {
    type: "object",
    properties: { range: rangeJsonSchema, limit: { type: "integer", minimum: 1, maximum: 30 } },
  },
  async run(input, ctx) {
    const { from, to } = resolveRange(input.range);
    const items = await db.orderItem.findMany({
      where: {
        cancelledAt: null,
        order: { restaurantId: ctx.scope.restaurantId, paidAt: { gte: from, lte: to } },
      },
      select: {
        qty: true,
        priceCentsSnapshot: true,
        menuItem: { select: { category: { select: { label: true, kind: true } } } },
      },
    });
    const rows: CatRow[] = items.map((i) => ({
      category: i.menuItem?.category?.label ?? "Sin categoría",
      kind: i.menuItem?.category?.kind ?? "other",
      qty: i.qty,
      priceCents: i.priceCentsSnapshot,
    }));
    return {
      range: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
      ...aggregateCategories(rows, { limit: input.limit }),
    };
  },
};
```

- [ ] **Step 4: Run → pasa.**
- [ ] **Step 5: Commit** `feat(pulso): category_breakdown tool`

---

## Task 9: Tool `traffic_by_time`

**Files:** Create `src/lib/ai/tools/trafficByTime.ts` + `.test.ts`

Tráfico por día-de-semana × hora (en tz del comercio): identifica picos y valles. Fuente: `Order.placedAt` (fallback `createdAt`).

- [ ] **Step 1: Test**
```ts
import { describe, it, expect } from "vitest";
import { aggregateTraffic, type TrafficRow } from "./trafficByTime";

const rows: TrafficRow[] = [
  { at: new Date("2026-03-09T18:00:00Z"), revenueCents: 10000 }, // lun 13h Bogotá
  { at: new Date("2026-03-09T18:30:00Z"), revenueCents: 5000 },  // lun 13h
  { at: new Date("2026-03-10T01:00:00Z"), revenueCents: 8000 },  // lun 20h
];

describe("aggregateTraffic", () => {
  it("bucketea por dow×hora local y marca el pico", () => {
    const r = aggregateTraffic(rows, { timezone: "America/Bogota" });
    const peak = r.cells.find((c) => c.dow === 1 && c.hour === 13);
    expect(peak).toEqual({ dow: 1, hour: 13, orders: 2, revenueCents: 15000 });
    expect(r.busiest.dow).toBe(1);
    expect(r.busiest.hour).toBe(13);
  });
});
```

- [ ] **Step 2: Run → falla.**

- [ ] **Step 3: Implementar**
```ts
import { z } from "zod";
import { db } from "@/lib/db";
import type { ToolDef } from "./types";
import { rangeInputZod, rangeJsonSchema, resolveRange } from "./dateRange";
import { localParts } from "./timeBuckets";

export type TrafficRow = { at: Date; revenueCents: number };

export function aggregateTraffic(rows: TrafficRow[], opts: { timezone: string }) {
  const map = new Map<string, { dow: number; hour: number; orders: number; revenueCents: number }>();
  for (const r of rows) {
    const p = localParts(r.at, opts.timezone);
    const key = `${p.dow}-${p.hour}`;
    const cur = map.get(key) ?? { dow: p.dow, hour: p.hour, orders: 0, revenueCents: 0 };
    cur.orders += 1;
    cur.revenueCents += r.revenueCents;
    map.set(key, cur);
  }
  const cells = [...map.values()].sort((a, b) => a.dow - b.dow || a.hour - b.hour);
  const busiest = cells.reduce((m, c) => (c.orders > (m?.orders ?? -1) ? c : m), cells[0] ?? { dow: 0, hour: 0, orders: 0, revenueCents: 0 });
  return { cells, busiest };
}

const inputSchema = z.object({ range: rangeInputZod });
type Input = z.infer<typeof inputSchema>;

export const trafficByTimeTool: ToolDef<Input> = {
  name: "traffic_by_time",
  description:
    "Tráfico por día de la semana y hora (en la zona horaria del comercio): " +
    "muestra los picos y los valles de movimiento. Útil para '¿qué días y horas " +
    "tengo más/menos movimiento?'.",
  inputSchema,
  jsonSchema: { type: "object", properties: { range: rangeJsonSchema } },
  async run(input, ctx) {
    const { from, to } = resolveRange(input.range);
    const orders = await db.order.findMany({
      where: {
        restaurantId: ctx.scope.restaurantId,
        OR: [{ placedAt: { gte: from, lte: to } }, { placedAt: null, createdAt: { gte: from, lte: to } }],
      },
      select: { placedAt: true, createdAt: true, totalCents: true },
    });
    const rows: TrafficRow[] = orders.map((o) => ({ at: (o.placedAt ?? o.createdAt) as Date, revenueCents: o.totalCents }));
    return {
      range: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
      note: "dow: 0=domingo..6=sábado; hour en hora local del comercio",
      ...aggregateTraffic(rows, { timezone: ctx.timezone }),
    };
  },
};
```

- [ ] **Step 4: Run → pasa.**
- [ ] **Step 5: Commit** `feat(pulso): traffic_by_time tool (tz-aware)`

---

## Task 10: Tool `tables_turnover`

**Files:** Create `src/lib/ai/tools/tablesTurnover.ts` + `.test.ts`

Rotación de mesas: tiempo de ocupación (createdAt→paidAt) promedio y vueltas por mesa, sobre órdenes dine-in pagadas.

- [ ] **Step 1: Test**
```ts
import { describe, it, expect } from "vitest";
import { aggregateTurnover, type TurnRow } from "./tablesTurnover";

const rows: TurnRow[] = [
  { tableNumber: 1, occupancyMin: 60 },
  { tableNumber: 1, occupancyMin: 40 },
  { tableNumber: 2, occupancyMin: 90 },
];

describe("aggregateTurnover", () => {
  it("calcula vueltas y ocupación promedio por mesa y global", () => {
    const r = aggregateTurnover(rows);
    expect(r.byTable).toContainEqual({ tableNumber: 1, turns: 2, avgOccupancyMin: 50 });
    expect(r.avgOccupancyMin).toBe(63); // (60+40+90)/3 = 63.33 → 63
    expect(r.totalTurns).toBe(3);
  });
});
```

- [ ] **Step 2: Run → falla.**

- [ ] **Step 3: Implementar.** El `run` calcula `occupancyMin = (paidAt - createdAt)/60000` por orden (solo `orderType: "dineIn"`, `paidAt != null`), pasa al agregador puro.
```ts
import { z } from "zod";
import { db } from "@/lib/db";
import type { ToolDef } from "./types";
import { rangeInputZod, rangeJsonSchema, resolveRange } from "./dateRange";

export type TurnRow = { tableNumber: number; occupancyMin: number };

export function aggregateTurnover(rows: TurnRow[]) {
  const map = new Map<number, { turns: number; totalMin: number }>();
  for (const r of rows) {
    const cur = map.get(r.tableNumber) ?? { turns: 0, totalMin: 0 };
    cur.turns += 1;
    cur.totalMin += r.occupancyMin;
    map.set(r.tableNumber, cur);
  }
  const byTable = [...map.entries()]
    .map(([tableNumber, v]) => ({ tableNumber, turns: v.turns, avgOccupancyMin: Math.round(v.totalMin / v.turns) }))
    .sort((a, b) => b.turns - a.turns);
  const totalTurns = rows.length;
  const avgOccupancyMin = totalTurns ? Math.round(rows.reduce((s, r) => s + r.occupancyMin, 0) / totalTurns) : 0;
  return { totalTurns, avgOccupancyMin, byTable };
}

const inputSchema = z.object({ range: rangeInputZod });
type Input = z.infer<typeof inputSchema>;

export const tablesTurnoverTool: ToolDef<Input> = {
  name: "tables_turnover",
  description:
    "Rotación de mesas: cuántas veces se usó cada mesa (vueltas) y el tiempo " +
    "promedio de ocupación. Útil para '¿cómo está la rotación?' y capacidad.",
  inputSchema,
  jsonSchema: { type: "object", properties: { range: rangeJsonSchema } },
  async run(input, ctx) {
    const { from, to } = resolveRange(input.range);
    const orders = await db.order.findMany({
      where: { restaurantId: ctx.scope.restaurantId, orderType: "dineIn", paidAt: { gte: from, lte: to } },
      select: { createdAt: true, paidAt: true, table: { select: { number: true } } },
    });
    const rows: TurnRow[] = orders
      .filter((o) => o.paidAt && o.table)
      .map((o) => ({
        tableNumber: o.table!.number,
        occupancyMin: Math.max(0, Math.round(((o.paidAt as Date).getTime() - o.createdAt.getTime()) / 60000)),
      }));
    return {
      range: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
      ...aggregateTurnover(rows),
    };
  },
};
```

- [ ] **Step 4: Run → pasa.**
- [ ] **Step 5: Commit** `feat(pulso): tables_turnover tool`

---

## Task 11: Tool `payment_mix`

**Files:** Create `src/lib/ai/tools/paymentMix.ts` + `.test.ts`

Desglose por método de pago (count, monto, propinas) sobre pagos aprobados.

- [ ] **Step 1: Test**
```ts
import { describe, it, expect } from "vitest";
import { aggregatePayments, type PayRow } from "./paymentMix";

const rows: PayRow[] = [
  { method: "kushki_card", amountCents: 10000, tipCents: 1000 },
  { method: "kushki_card", amountCents: 20000, tipCents: 2000 },
  { method: "demo_cash", amountCents: 5000, tipCents: 0 },
];

describe("aggregatePayments", () => {
  it("agrupa por método y suma propinas; ordena por monto", () => {
    const r = aggregatePayments(rows);
    expect(r.methods[0]).toEqual({ method: "kushki_card", count: 2, amountCents: 30000, tipCents: 3000 });
    expect(r.totalAmountCents).toBe(35000);
    expect(r.totalTipCents).toBe(3000);
    expect(r.tipRatePct).toBe(9); // 3000/35000 = 8.57 → 9
  });
});
```

- [ ] **Step 2: Run → falla.**

- [ ] **Step 3: Implementar**
```ts
import { z } from "zod";
import { db } from "@/lib/db";
import type { ToolDef } from "./types";
import { rangeInputZod, rangeJsonSchema, resolveRange } from "./dateRange";

export type PayRow = { method: string; amountCents: number; tipCents: number };

export function aggregatePayments(rows: PayRow[]) {
  const map = new Map<string, { count: number; amountCents: number; tipCents: number }>();
  let totalAmountCents = 0, totalTipCents = 0;
  for (const r of rows) {
    const cur = map.get(r.method) ?? { count: 0, amountCents: 0, tipCents: 0 };
    cur.count += 1;
    cur.amountCents += r.amountCents;
    cur.tipCents += r.tipCents;
    map.set(r.method, cur);
    totalAmountCents += r.amountCents;
    totalTipCents += r.tipCents;
  }
  const methods = [...map.entries()]
    .map(([method, v]) => ({ method, ...v }))
    .sort((a, b) => b.amountCents - a.amountCents);
  return {
    totalAmountCents,
    totalTipCents,
    tipRatePct: totalAmountCents ? Math.round((totalTipCents / totalAmountCents) * 100) : 0,
    methods,
  };
}

const inputSchema = z.object({ range: rangeInputZod });
type Input = z.infer<typeof inputSchema>;

export const paymentMixTool: ToolDef<Input> = {
  name: "payment_mix",
  description:
    "Desglose de los pagos aprobados por método (tarjeta, efectivo, etc.), con " +
    "montos y propinas. Útil para '¿cómo me pagan?' y cuánto entra de propina.",
  inputSchema,
  jsonSchema: { type: "object", properties: { range: rangeJsonSchema } },
  async run(input, ctx) {
    const { from, to } = resolveRange(input.range);
    const payments = await db.payment.findMany({
      where: {
        status: "approved",
        order: { restaurantId: ctx.scope.restaurantId, paidAt: { gte: from, lte: to } },
      },
      select: { method: true, amountCents: true, tipCents: true },
    });
    return {
      range: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
      ...aggregatePayments(payments),
    };
  },
};
```

- [ ] **Step 4: Run → pasa.**
- [ ] **Step 5: Commit** `feat(pulso): payment_mix tool (+ propinas)`

---

## Task 12: Tool `staff_performance`

**Files:** Create `src/lib/ai/tools/staffPerformance.ts` + `.test.ts`

Por mesero (quien cobró): ventas, # de cobros, # de mesas distintas, propinas, ticket promedio.

- [ ] **Step 1: Test**
```ts
import { describe, it, expect } from "vitest";
import { aggregateStaff, type StaffRow } from "./staffPerformance";

const rows: StaffRow[] = [
  { userName: "Ana", amountCents: 10000, tipCents: 1000, tableNumber: 1 },
  { userName: "Ana", amountCents: 20000, tipCents: 2000, tableNumber: 2 },
  { userName: "Beto", amountCents: 5000, tipCents: 0, tableNumber: 3 },
];

describe("aggregateStaff", () => {
  it("agrega por mesero, cuenta mesas distintas, ordena por ventas", () => {
    const r = aggregateStaff(rows);
    expect(r.staff[0]).toEqual({
      userName: "Ana", amountCents: 30000, tipCents: 3000, charges: 2, tables: 2, avgTicketCents: 15000,
    });
    expect(r.staff[1].userName).toBe("Beto");
  });
});
```

- [ ] **Step 2: Run → falla.**

- [ ] **Step 3: Implementar.** El `run` filtra pagos aprobados con `collectedByUserId != null`, trae `collectedBy.name` y `order.table.number`.
```ts
import { z } from "zod";
import { db } from "@/lib/db";
import type { ToolDef } from "./types";
import { rangeInputZod, rangeJsonSchema, resolveRange } from "./dateRange";

export type StaffRow = { userName: string; amountCents: number; tipCents: number; tableNumber: number | null };

export function aggregateStaff(rows: StaffRow[]) {
  const map = new Map<string, { amountCents: number; tipCents: number; charges: number; tables: Set<number> }>();
  for (const r of rows) {
    const cur = map.get(r.userName) ?? { amountCents: 0, tipCents: 0, charges: 0, tables: new Set<number>() };
    cur.amountCents += r.amountCents;
    cur.tipCents += r.tipCents;
    cur.charges += 1;
    if (r.tableNumber != null) cur.tables.add(r.tableNumber);
    map.set(r.userName, cur);
  }
  const staff = [...map.entries()]
    .map(([userName, v]) => ({
      userName,
      amountCents: v.amountCents,
      tipCents: v.tipCents,
      charges: v.charges,
      tables: v.tables.size,
      avgTicketCents: v.charges ? Math.round(v.amountCents / v.charges) : 0,
    }))
    .sort((a, b) => b.amountCents - a.amountCents);
  return { staff };
}

const inputSchema = z.object({ range: rangeInputZod });
type Input = z.infer<typeof inputSchema>;

export const staffPerformanceTool: ToolDef<Input> = {
  name: "staff_performance",
  description:
    "Desempeño por mesero (según quién cobró): ventas, # de cobros, mesas " +
    "atendidas, propinas y ticket promedio. Útil para '¿quién es mi mejor mesero?'.",
  inputSchema,
  jsonSchema: { type: "object", properties: { range: rangeJsonSchema } },
  async run(input, ctx) {
    const { from, to } = resolveRange(input.range);
    const payments = await db.payment.findMany({
      where: {
        status: "approved",
        collectedByUserId: { not: null },
        order: { restaurantId: ctx.scope.restaurantId, paidAt: { gte: from, lte: to } },
      },
      select: {
        amountCents: true, tipCents: true,
        collectedBy: { select: { name: true, email: true } },
        order: { select: { table: { select: { number: true } } } },
      },
    });
    const rows: StaffRow[] = payments.map((p) => ({
      userName: p.collectedBy?.name || p.collectedBy?.email || "Sin nombre",
      amountCents: p.amountCents,
      tipCents: p.tipCents,
      tableNumber: p.order?.table?.number ?? null,
    }));
    return {
      range: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
      ...aggregateStaff(rows),
    };
  },
};
```

- [ ] **Step 4: Run → pasa.**
- [ ] **Step 5: Commit** `feat(pulso): staff_performance tool`

---

## Task 13: Tool `staffing_estimate`

**Files:** Create `src/lib/ai/tools/staffingEstimate.ts` + `.test.ts`

Heurística: a partir del volumen de órdenes por franja horaria (tz local), estima cuántos meseros se necesitan asumiendo un throughput configurable (default 6 órdenes/mesero/hora).

- [ ] **Step 1: Test**
```ts
import { describe, it, expect } from "vitest";
import { estimateStaffing, type LoadRow } from "./staffingEstimate";

const rows: LoadRow[] = [
  { at: new Date("2026-03-09T18:00:00Z") }, // lun 13h Bogotá
  { at: new Date("2026-03-09T18:10:00Z") },
  { at: new Date("2026-03-09T18:20:00Z") },
];

describe("estimateStaffing", () => {
  it("agrupa por dow×hora y estima meseros con techo", () => {
    const r = estimateStaffing(rows, { timezone: "America/Bogota", ordersPerWaiterHour: 2 });
    const cell = r.byHour.find((c) => c.dow === 1 && c.hour === 13);
    expect(cell).toEqual({ dow: 1, hour: 13, orders: 3, suggestedWaiters: 2 }); // ceil(3/2)=2
    expect(r.peak.suggestedWaiters).toBe(2);
  });
});
```

- [ ] **Step 2: Run → falla.**

- [ ] **Step 3: Implementar**
```ts
import { z } from "zod";
import { db } from "@/lib/db";
import type { ToolDef } from "./types";
import { rangeInputZod, rangeJsonSchema, resolveRange } from "./dateRange";
import { localParts } from "./timeBuckets";

export type LoadRow = { at: Date };

export function estimateStaffing(rows: LoadRow[], opts: { timezone: string; ordersPerWaiterHour: number }) {
  const map = new Map<string, { dow: number; hour: number; orders: number }>();
  for (const r of rows) {
    const p = localParts(r.at, opts.timezone);
    const key = `${p.dow}-${p.hour}`;
    const cur = map.get(key) ?? { dow: p.dow, hour: p.hour, orders: 0 };
    cur.orders += 1;
    map.set(key, cur);
  }
  const rate = Math.max(1, opts.ordersPerWaiterHour);
  const byHour = [...map.values()]
    .map((c) => ({ ...c, suggestedWaiters: Math.max(1, Math.ceil(c.orders / rate)) }))
    .sort((a, b) => a.dow - b.dow || a.hour - b.hour);
  const peak = byHour.reduce((m, c) => (c.orders > (m?.orders ?? -1) ? c : m), byHour[0] ?? { dow: 0, hour: 0, orders: 0, suggestedWaiters: 1 });
  return { ordersPerWaiterHour: rate, byHour, peak };
}

const inputSchema = z.object({
  range: rangeInputZod,
  ordersPerWaiterHour: z.number().int().min(1).max(30).default(6),
});
type Input = z.infer<typeof inputSchema>;

export const staffingEstimateTool: ToolDef<Input> = {
  name: "staffing_estimate",
  description:
    "Estima cuántos meseros se necesitan por franja horaria según el volumen de " +
    "órdenes y un rendimiento por mesero (default 6 órdenes/mesero/hora). Útil para " +
    "'¿con cuántos meseros manejo la operación?' y dónde está la franja más exigente.",
  inputSchema,
  jsonSchema: {
    type: "object",
    properties: {
      range: rangeJsonSchema,
      ordersPerWaiterHour: { type: "integer", minimum: 1, maximum: 30, description: "Órdenes que atiende un mesero por hora." },
    },
  },
  async run(input, ctx) {
    const { from, to } = resolveRange(input.range);
    const orders = await db.order.findMany({
      where: {
        restaurantId: ctx.scope.restaurantId,
        OR: [{ placedAt: { gte: from, lte: to } }, { placedAt: null, createdAt: { gte: from, lte: to } }],
      },
      select: { placedAt: true, createdAt: true },
    });
    const rows: LoadRow[] = orders.map((o) => ({ at: (o.placedAt ?? o.createdAt) as Date }));
    return {
      range: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
      note: "Estimación heurística por volumen; dow 0=domingo..6=sábado, hour local.",
      ...estimateStaffing(rows, { timezone: ctx.timezone, ordersPerWaiterHour: input.ordersPerWaiterHour }),
    };
  },
};
```

- [ ] **Step 4: Run → pasa.**
- [ ] **Step 5: Commit** `feat(pulso): staffing_estimate tool`

---

## Task 14: Tool `kitchen_bottlenecks`

**Files:** Create `src/lib/ai/tools/kitchenBottlenecks.ts` + `.test.ts`

Tiempo real de preparación (`preparationStartedAt`→`servedAt`) vs target (`prepMinutesSnapshot`), por estación y por hora local; % de ítems por encima del target.

- [ ] **Step 1: Test**
```ts
import { describe, it, expect } from "vitest";
import { aggregateBottlenecks, type PrepRow } from "./kitchenBottlenecks";

const rows: PrepRow[] = [
  { station: "kitchen", actualMin: 20, targetMin: 10, servedAt: new Date("2026-03-09T18:00:00Z") }, // over
  { station: "kitchen", actualMin: 8, targetMin: 10, servedAt: new Date("2026-03-09T18:30:00Z") },  // ok
  { station: "bar", actualMin: 5, targetMin: 3, servedAt: new Date("2026-03-09T19:00:00Z") },        // over
];

describe("aggregateBottlenecks", () => {
  it("calcula prom y % sobre target por estación", () => {
    const r = aggregateBottlenecks(rows, { timezone: "America/Bogota" });
    const k = r.byStation.find((s) => s.station === "kitchen");
    expect(k).toEqual({ station: "kitchen", items: 2, avgActualMin: 14, avgTargetMin: 10, overTargetPct: 50 });
    expect(r.worstHour.dow).toBe(1);
  });
});
```

- [ ] **Step 2: Run → falla.**

- [ ] **Step 3: Implementar.** `run`: ítems con `preparationStartedAt != null` y `servedAt != null`, `cancelledAt = null`, de órdenes del scope con `paidAt` o `servedAt` en rango. `actualMin = (servedAt - preparationStartedAt)/60000`.
```ts
import { z } from "zod";
import { db } from "@/lib/db";
import type { ToolDef } from "./types";
import { rangeInputZod, rangeJsonSchema, resolveRange } from "./dateRange";
import { localParts } from "./timeBuckets";

export type PrepRow = { station: string; actualMin: number; targetMin: number; servedAt: Date };

export function aggregateBottlenecks(rows: PrepRow[], opts: { timezone: string }) {
  const st = new Map<string, { items: number; actual: number; target: number; over: number }>();
  const hr = new Map<string, { dow: number; hour: number; items: number; over: number }>();
  for (const r of rows) {
    const s = st.get(r.station) ?? { items: 0, actual: 0, target: 0, over: 0 };
    s.items += 1; s.actual += r.actualMin; s.target += r.targetMin;
    if (r.actualMin > r.targetMin) s.over += 1;
    st.set(r.station, s);
    const p = localParts(r.servedAt, opts.timezone);
    const key = `${p.dow}-${p.hour}`;
    const h = hr.get(key) ?? { dow: p.dow, hour: p.hour, items: 0, over: 0 };
    h.items += 1; if (r.actualMin > r.targetMin) h.over += 1;
    hr.set(key, h);
  }
  const byStation = [...st.entries()].map(([station, v]) => ({
    station, items: v.items,
    avgActualMin: Math.round(v.actual / v.items),
    avgTargetMin: Math.round(v.target / v.items),
    overTargetPct: Math.round((v.over / v.items) * 100),
  })).sort((a, b) => b.overTargetPct - a.overTargetPct);
  const byHour = [...hr.values()].map((h) => ({ ...h, overTargetPct: Math.round((h.over / h.items) * 100) }));
  const worstHour = byHour.reduce((m, c) => (c.over > (m?.over ?? -1) ? c : m), byHour[0] ?? { dow: 0, hour: 0, items: 0, over: 0, overTargetPct: 0 });
  return { byStation, worstHour };
}

const inputSchema = z.object({ range: rangeInputZod });
type Input = z.infer<typeof inputSchema>;

export const kitchenBottlenecksTool: ToolDef<Input> = {
  name: "kitchen_bottlenecks",
  description:
    "Cuellos de botella de preparación: compara el tiempo real (de inicio a " +
    "servido) contra el target por estación, y marca la hora/día donde más se " +
    "supera. Útil para '¿cuándo la cocina no da abasto?'.",
  inputSchema,
  jsonSchema: { type: "object", properties: { range: rangeJsonSchema } },
  async run(input, ctx) {
    const { from, to } = resolveRange(input.range);
    const items = await db.orderItem.findMany({
      where: {
        cancelledAt: null,
        preparationStartedAt: { not: null },
        servedAt: { not: null },
        order: { restaurantId: ctx.scope.restaurantId, paidAt: { gte: from, lte: to } },
      },
      select: { station: true, prepMinutesSnapshot: true, preparationStartedAt: true, servedAt: true },
    });
    const rows: PrepRow[] = items.map((i) => ({
      station: i.station,
      targetMin: i.prepMinutesSnapshot,
      actualMin: Math.max(0, Math.round(((i.servedAt as Date).getTime() - (i.preparationStartedAt as Date).getTime()) / 60000)),
      servedAt: i.servedAt as Date,
    }));
    return {
      range: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
      note: "dow 0=domingo..6=sábado, hour local del comercio.",
      ...aggregateBottlenecks(rows, { timezone: ctx.timezone }),
    };
  },
};
```

- [ ] **Step 4: Run → pasa.**
- [ ] **Step 5: Commit** `feat(pulso): kitchen_bottlenecks tool`

---

## Task 15: Tool `cancellations`

**Files:** Create `src/lib/ai/tools/cancellations.ts` + `.test.ts`

Cancelaciones vs cortesías (comps): conteo, $ perdido (qty×precio), por tipo y por motivo. Fuente: `OrderItem.cancelledAt != null` + `cancellationKind` + `cancellationReason`.

- [ ] **Step 1: Test**
```ts
import { describe, it, expect } from "vitest";
import { aggregateCancellations, type CancelRow } from "./cancellations";

const rows: CancelRow[] = [
  { kind: "cancel", reason: "demora", lostCents: 10000 },
  { kind: "cancel", reason: "demora", lostCents: 5000 },
  { kind: "comp", reason: "cortesía", lostCents: 8000 },
];

describe("aggregateCancellations", () => {
  it("separa cancel vs comp y agrupa por motivo", () => {
    const r = aggregateCancellations(rows);
    expect(r.byKind).toContainEqual({ kind: "cancel", count: 2, lostCents: 15000 });
    expect(r.byKind).toContainEqual({ kind: "comp", count: 1, lostCents: 8000 });
    expect(r.totalLostCents).toBe(23000);
    expect(r.byReason[0]).toEqual({ reason: "demora", count: 2, lostCents: 15000 });
  });
});
```

- [ ] **Step 2: Run → falla.**

- [ ] **Step 3: Implementar**
```ts
import { z } from "zod";
import { db } from "@/lib/db";
import type { ToolDef } from "./types";
import { rangeInputZod, rangeJsonSchema, resolveRange } from "./dateRange";

export type CancelRow = { kind: string; reason: string; lostCents: number };

export function aggregateCancellations(rows: CancelRow[]) {
  const kind = new Map<string, { count: number; lostCents: number }>();
  const reason = new Map<string, { count: number; lostCents: number }>();
  let totalLostCents = 0;
  for (const r of rows) {
    totalLostCents += r.lostCents;
    const k = kind.get(r.kind) ?? { count: 0, lostCents: 0 };
    k.count += 1; k.lostCents += r.lostCents; kind.set(r.kind, k);
    const re = reason.get(r.reason) ?? { count: 0, lostCents: 0 };
    re.count += 1; re.lostCents += r.lostCents; reason.set(r.reason, re);
  }
  const byKind = [...kind.entries()].map(([k, v]) => ({ kind: k, ...v }));
  const byReason = [...reason.entries()].map(([re, v]) => ({ reason: re, ...v })).sort((a, b) => b.lostCents - a.lostCents);
  return { totalLostCents, totalCount: rows.length, byKind, byReason };
}

const inputSchema = z.object({ range: rangeInputZod });
type Input = z.infer<typeof inputSchema>;

export const cancellationsTool: ToolDef<Input> = {
  name: "cancellations",
  description:
    "Cancelaciones vs cortesías (comps): cuántas, cuánto dinero se perdió y por " +
    "qué motivos. Útil para '¿cuánto pierdo en cancelaciones y cortesías?'.",
  inputSchema,
  jsonSchema: { type: "object", properties: { range: rangeJsonSchema } },
  async run(input, ctx) {
    const { from, to } = resolveRange(input.range);
    const items = await db.orderItem.findMany({
      where: {
        cancelledAt: { gte: from, lte: to, not: null },
        order: { restaurantId: ctx.scope.restaurantId },
      },
      select: { qty: true, priceCentsSnapshot: true, cancellationKind: true, cancellationReason: true },
    });
    const rows: CancelRow[] = items.map((i) => ({
      kind: i.cancellationKind ?? "cancel",
      reason: i.cancellationReason ?? "sin motivo",
      lostCents: i.qty * i.priceCentsSnapshot,
    }));
    return {
      range: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
      ...aggregateCancellations(rows),
    };
  },
};
```

- [ ] **Step 4: Run → pasa.**
- [ ] **Step 5: Commit** `feat(pulso): cancellations tool (cancel vs comp)`

---

## Task 16: Tool `reservations_insights`

**Files:** Create `src/lib/ai/tools/reservationsInsights.ts` + `.test.ts`

Reservas: conteos por estado, tasa de no-show, depósitos cobrados/perdidos, comensales. Fuente: `Reservation` (por `startsAt` en rango).

- [ ] **Step 1: Test**
```ts
import { describe, it, expect } from "vitest";
import { aggregateReservations, type ResRow } from "./reservationsInsights";

const rows: ResRow[] = [
  { status: "completed", partySize: 4, depositStatus: "applied", depositCents: 5000 },
  { status: "no_show", partySize: 2, depositStatus: "forfeited", depositCents: 3000 },
  { status: "cancelled", partySize: 2, depositStatus: "refunded", depositCents: 0 },
  { status: "confirmed", partySize: 3, depositStatus: "paid", depositCents: 4000 },
];

describe("aggregateReservations", () => {
  it("cuenta por estado, no-show rate y depósitos", () => {
    const r = aggregateReservations(rows);
    expect(r.total).toBe(4);
    expect(r.byStatus).toContainEqual({ status: "no_show", count: 1 });
    expect(r.noShowPct).toBe(25);
    expect(r.depositsForfeitedCents).toBe(3000);
    expect(r.totalGuests).toBe(11);
  });
});
```

- [ ] **Step 2: Run → falla.**

- [ ] **Step 3: Implementar**
```ts
import { z } from "zod";
import { db } from "@/lib/db";
import type { ToolDef } from "./types";
import { rangeInputZod, rangeJsonSchema, resolveRange } from "./dateRange";

export type ResRow = { status: string; partySize: number; depositStatus: string; depositCents: number };

export function aggregateReservations(rows: ResRow[]) {
  const status = new Map<string, number>();
  let totalGuests = 0, depositsForfeitedCents = 0, depositsPaidCents = 0;
  for (const r of rows) {
    status.set(r.status, (status.get(r.status) ?? 0) + 1);
    totalGuests += r.partySize;
    if (r.depositStatus === "forfeited") depositsForfeitedCents += r.depositCents;
    if (r.depositStatus === "paid" || r.depositStatus === "applied") depositsPaidCents += r.depositCents;
  }
  const total = rows.length;
  const noShow = status.get("no_show") ?? 0;
  const byStatus = [...status.entries()].map(([s, count]) => ({ status: s, count })).sort((a, b) => b.count - a.count);
  return {
    total,
    totalGuests,
    byStatus,
    noShowPct: total ? Math.round((noShow / total) * 100) : 0,
    depositsPaidCents,
    depositsForfeitedCents,
  };
}

const inputSchema = z.object({ range: rangeInputZod });
type Input = z.infer<typeof inputSchema>;

export const reservationsInsightsTool: ToolDef<Input> = {
  name: "reservations_insights",
  description:
    "Reservas del período: totales, comensales, tasa de no-shows y depósitos " +
    "cobrados/perdidos. Útil para '¿cómo vienen las reservas y los no-shows?'.",
  inputSchema,
  jsonSchema: { type: "object", properties: { range: rangeJsonSchema } },
  async run(input, ctx) {
    const { from, to } = resolveRange(input.range);
    const rs = await db.reservation.findMany({
      where: { restaurantId: ctx.scope.restaurantId, startsAt: { gte: from, lte: to } },
      select: { status: true, partySize: true, depositStatus: true, depositCents: true },
    });
    const rows: ResRow[] = rs.map((r) => ({
      status: r.status,
      partySize: r.partySize,
      depositStatus: r.depositStatus,
      depositCents: r.depositCents ?? 0,
    }));
    return {
      range: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
      ...aggregateReservations(rows),
    };
  },
};
```

- [ ] **Step 4: Run → pasa.**
- [ ] **Step 5: Commit** `feat(pulso): reservations_insights tool`

---

## Task 17: Registrar todas las tools + ampliar preguntas sugeridas + verificación final

**Files:**
- Modify: `src/lib/ai/toolRegistry.ts`
- Modify: `messages/es.json`, `messages/en.json`, `messages/pt.json` (namespace `insights`: agregar más chips sugeridos)
- Modify: `src/app/operator/insights/InsightsChat.tsx` (si los chips están hardcodeados a sug1/2/3, sumar sug4/sug5/sug6)

- [ ] **Step 1: Registrar las 12 tools nuevas** en `src/lib/ai/toolRegistry.ts`:
```ts
import { topDishesTool } from "./tools/topDishes";
import { topSearchesTool } from "./tools/topSearches";
import { salesOverviewTool } from "./tools/salesOverview";
import { revenueTrendTool } from "./tools/revenueTrend";
import { categoryBreakdownTool } from "./tools/categoryBreakdown";
import { trafficByTimeTool } from "./tools/trafficByTime";
import { tablesTurnoverTool } from "./tools/tablesTurnover";
import { paymentMixTool } from "./tools/paymentMix";
import { staffPerformanceTool } from "./tools/staffPerformance";
import { staffingEstimateTool } from "./tools/staffingEstimate";
import { kitchenBottlenecksTool } from "./tools/kitchenBottlenecks";
import { cancellationsTool } from "./tools/cancellations";
import { reservationsInsightsTool } from "./tools/reservationsInsights";

const TOOLS: ToolDef<any>[] = [
  topDishesTool,
  salesOverviewTool,
  revenueTrendTool,
  categoryBreakdownTool,
  trafficByTimeTool,
  tablesTurnoverTool,
  paymentMixTool,
  staffPerformanceTool,
  staffingEstimateTool,
  kitchenBottlenecksTool,
  cancellationsTool,
  topSearchesTool,
  reservationsInsightsTool,
];
```

- [ ] **Step 2: Ampliar chips sugeridos.** En `messages/es.json` namespace `insights`, agregar:
```json
"sug4": "¿Qué días y horas tengo más movimiento?",
"sug5": "¿Quién es mi mejor mesero este mes?",
"sug6": "¿Cuándo se satura la cocina?"
```
Llenar en `en.json` y `pt.json` con traducciones. Mantener paridad. Si `InsightsChat.tsx` enumera los chips explícitamente (sug1..sug3), extenderlo a sug1..sug6.

- [ ] **Step 3: Verificación final (el gate)**

Run y verificar que TODO pase:
```bash
npm test
node -e "for(const l of ['es','en','pt']){const o=require('./messages/'+l+'.json');let n=0;(function c(x){for(const k in x){n++;if(x[k]&&typeof x[k]==='object')c(x[k])}})(o);console.log(l,n)}"
npm run lint
npm run build
```
Esperado: `npm test` con todos los archivos verdes (Plan 1: 4 + Plan 2: ~13 nuevos); los 3 números de paridad iguales; lint sin errores NUEVOS más allá de los preexistentes; build compila.

- [ ] **Step 4: Commit**
```bash
git add src/lib/ai/toolRegistry.ts messages/es.json messages/en.json messages/pt.json src/app/operator/insights/InsightsChat.tsx
git commit -m "feat(pulso): registrar 12 tools + chips sugeridos (es/en/pt)"
```

---

## Self-Review (cobertura del spec)

- ✅ Las 13 tools del catálogo: `top_dishes` (Plan 1) + las 12 de este plan (Tasks 5–16).
- ✅ `SearchEvent` (schema Task 2, captura Tasks 3–4, consumo en `top_searches` Task 5).
- ✅ Scoping server-side: cada `run` filtra por `ctx.scope.restaurantId`; ninguna tool acepta restaurantId del modelo.
- ✅ Timezone: tools de tiempo (`traffic_by_time`, `revenue_trend`, `kitchen_bottlenecks`, `staffing_estimate`) usan `ctx.timezone` vía `timeBuckets`.
- ✅ TDD: cada agregador es función pura con test de números esperados; el fetch Prisma se valida por build.
- ✅ DRY: schemas de rango (Task 0) y buckets de tiempo (Task 1) compartidos.
- ✅ i18n: chips en es/en/pt con paridad (Task 17).
- ✅ Fuera de alcance (Plan 3): scope de grupo, UI de historial, streaming, render de tarjetas. No se tocan acá.
- ✅ Rating promedio en `top_dishes`: el spec lo menciona como enhancement; `top_dishes` ya está en prod sin rating. Queda como mejora opcional futura (no re-abrir la tool desplegada en este plan).

**Verificación por tool:** `npx vitest run <archivo>.test.ts`. **Gate final:** Task 17 (`npm test && npm run lint && npm run build` + paridad).
