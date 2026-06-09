# Pulso — Plan 1: Framework end-to-end + primera tool

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dejar funcionando, de punta a punta, el chat "Pulso": el dueño abre `/operator/insights`, escribe "¿cuáles son mis platos más vendidos este mes?", y Claude (Sonnet, tool-use) responde consultando datos reales de SU restaurante — con gating por plan/override y límite diario.

**Architecture:** Loop de agente server-side (Anthropic SDK) con UNA tool de analítica (`top_dishes`). Cada tool = *fetch fino con Prisma* + *agregador puro* (testeable con fixtures sin DB). El `restaurantId` se inyecta del lado del server desde la sesión (nunca del modelo). Persistencia de conversaciones. UI mínima de chat. Este plan instala TODO el framework; los planes siguientes solo agregan tools.

**Tech Stack:** Next.js (App Router, route handlers), Prisma/Postgres, `@anthropic-ai/sdk` (ya integrado en `src/lib/anthropic.ts`), `zod`, `next-intl`, **vitest** (nuevo, para los agregadores puros y el loop).

**Alcance de planes siguientes (NO en este):** Plan 2 = tools restantes (sales_overview, traffic_by_time, staff_performance, kitchen_bottlenecks, etc.) + captura de búsquedas (`SearchEvent`). Plan 3 = scope de grupo (multi-sucursal), historial de conversaciones en la UI, pulido i18n.

---

## Estructura de archivos (este plan)

**Crear:**
- `vitest.config.ts` — config de vitest (node env).
- `src/lib/ai/scope.ts` — resuelve el scope (restaurante) desde la sesión.
- `src/lib/ai/aiAccess.ts` — gating por plan + override + límite diario.
- `src/lib/ai/aiAccess.test.ts`
- `src/lib/ai/tools/types.ts` — tipos compartidos (Scope, ToolDef, DateRange).
- `src/lib/ai/tools/dateRange.ts` — parseo/clamp de rangos + helper de timezone.
- `src/lib/ai/tools/dateRange.test.ts`
- `src/lib/ai/tools/topDishes.ts` — fetch fino + agregador puro `aggregateTopDishes`.
- `src/lib/ai/tools/topDishes.test.ts` — testea el agregador puro con fixtures.
- `src/lib/ai/toolRegistry.ts` — registry: JSON-schema (para Claude) + executor.
- `src/lib/ai/insightsAgent.ts` — loop de tool-use.
- `src/lib/ai/insightsAgent.test.ts` — loop con cliente Anthropic mockeado.
- `src/app/api/operator/insights/chat/route.ts` — endpoint del chat (POST).
- `src/app/operator/insights/page.tsx` — página (server) + gating.
- `src/app/operator/insights/InsightsChat.tsx` — UI cliente del chat.

**Modificar:**
- `package.json` — devDeps `vitest`, script `"test"`.
- `prisma/schema.prisma` — modelos `AiConversation`, `AiMessage`; campos
  `Restaurant.aiInsightsEnabled`, `Restaurant.aiDailyMessageLimit`,
  `PlatformConfig.aiDailyMessageLimit`.
- `src/app/admin/restaurants/[id]/page.tsx` (o un panel) — toggle + límite.
- `messages/{es,en,pt}.json` — namespace `insights`.

---

## Task 1: Instalar vitest

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`

- [ ] **Step 1: Instalar vitest**

Run: `npm i -D vitest@^3`
Expected: agrega `vitest` a devDependencies sin errores.

- [ ] **Step 2: Crear `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Los tests de este feature son de funciones puras (sin DB, sin red).
    globals: false,
  },
});
```

- [ ] **Step 3: Agregar script `test` a package.json**

En `"scripts"`, agregar:
```json
"test": "vitest run",
```

- [ ] **Step 4: Verificar que vitest corre (sin tests aún)**

Run: `npm test`
Expected: "No test files found" (o exit 0). No debe romper.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json vitest.config.ts
git commit -m "test: add vitest for the AI insights module"
```

---

## Task 2: Schema — persistencia del chat + flags

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Agregar campos al modelo `Restaurant`**

Buscar `kushkiMode             String?` (agregado en una feature previa) y, justo
debajo, agregar:
```prisma
  // Pulso (asistente de IA): override por comercio del gating por plan.
  // null = según plan (trial/pro habilitados, basic no). true/false = forzar.
  aiInsightsEnabled    Boolean?
  // Límite de mensajes/día del asistente para este comercio. null = usar el
  // default global de PlatformConfig.aiDailyMessageLimit.
  aiDailyMessageLimit  Int?
  // Relaciones de Pulso
  aiConversations      AiConversation[]
```

- [ ] **Step 2: Agregar campo a `PlatformConfig`**

Dentro de `model PlatformConfig { ... }`, agregar:
```prisma
  // Default global de mensajes/día del asistente Pulso (override por comercio
  // en Restaurant.aiDailyMessageLimit).
  aiDailyMessageLimit Int @default(50)
```

- [ ] **Step 3: Agregar modelos `AiConversation` y `AiMessage`** (al final del archivo, antes de cerrar)

```prisma
model AiConversation {
  id           String      @id @default(cuid())
  restaurantId String?
  restaurant   Restaurant? @relation(fields: [restaurantId], references: [id], onDelete: Cascade)
  groupId      String?
  userId       String
  title        String      @default("Nueva conversación")
  createdAt    DateTime    @default(now())
  updatedAt    DateTime    @updatedAt
  messages     AiMessage[]

  @@index([restaurantId, userId])
  @@index([groupId, userId])
}

model AiMessage {
  id             String         @id @default(cuid())
  conversationId String
  conversation   AiConversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)
  role           String // "user" | "assistant"
  content        String
  toolCalls      Json?
  createdAt      DateTime       @default(now())

  @@index([conversationId, createdAt])
}
```

- [ ] **Step 4: Generar el cliente Prisma**

Run: `npx prisma generate`
Expected: "Generated Prisma Client" sin errores.

> Nota: el `prisma db push` a prod lo hace `activate.sh` en el deploy. En local,
> si tu `.env` apunta a una DB de desarrollo segura, podés correr `npm run db:push`.
> NO correr db:push si tu `.env` local apunta a la DB de producción.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma
git commit -m "schema: Pulso — AiConversation/AiMessage + gating flags"
```

---

## Task 3: Resolver de scope (restaurante)

**Files:**
- Create: `src/lib/ai/scope.ts`

- [ ] **Step 1: Implementar `resolveInsightsScope`**

El scope se deriva SIEMPRE de la sesión. En este plan solo soportamos scope de
restaurante (grupo = Plan 3). Reusar el patrón de `getActiveRestaurantId`.

```ts
import { getActiveRestaurantId } from "@/lib/activeRestaurant";

export type InsightsScope = {
  kind: "restaurant";
  restaurantId: string;
};

/**
 * Resuelve el scope del asistente desde la sesión del operador. NUNCA confía en
 * input del cliente/modelo. Devuelve null si no hay restaurante activo.
 */
export async function resolveInsightsScope(): Promise<InsightsScope | null> {
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) return null;
  return { kind: "restaurant", restaurantId };
}
```

- [ ] **Step 2: Build check**

Run: `npx tsc --noEmit`
Expected: sin errores nuevos en `src/lib/ai/scope.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/lib/ai/scope.ts
git commit -m "feat(pulso): scope resolver (restaurant) from session"
```

---

## Task 4: Gating + límite diario (`aiAccess`)

**Files:**
- Create: `src/lib/ai/aiAccess.ts`
- Test: `src/lib/ai/aiAccess.test.ts`

- [ ] **Step 1: Escribir el test que falla (lógica pura de gating)**

```ts
import { describe, it, expect } from "vitest";
import { isAiEnabledForPlan, resolveAiEnabled } from "./aiAccess";

describe("isAiEnabledForPlan", () => {
  it("habilita trial y pro, no basic", () => {
    expect(isAiEnabledForPlan("trial")).toBe(true);
    expect(isAiEnabledForPlan("pro")).toBe(true);
    expect(isAiEnabledForPlan("basic")).toBe(false);
  });
});

describe("resolveAiEnabled (override gana al plan)", () => {
  it("override=true habilita aunque el plan sea basic", () => {
    expect(resolveAiEnabled({ plan: "basic", aiInsightsEnabled: true })).toBe(true);
  });
  it("override=false deshabilita aunque el plan sea pro", () => {
    expect(resolveAiEnabled({ plan: "pro", aiInsightsEnabled: false })).toBe(false);
  });
  it("override=null cae al plan", () => {
    expect(resolveAiEnabled({ plan: "pro", aiInsightsEnabled: null })).toBe(true);
    expect(resolveAiEnabled({ plan: "basic", aiInsightsEnabled: null })).toBe(false);
  });
});
```

- [ ] **Step 2: Correr el test → debe fallar**

Run: `npm test -- src/lib/ai/aiAccess.test.ts`
Expected: FAIL ("isAiEnabledForPlan is not a function" / módulo inexistente).

- [ ] **Step 3: Implementar `aiAccess.ts`**

```ts
import { db } from "@/lib/db";

const AI_PLANS = new Set(["trial", "pro"]); // basic (Esencial) queda fuera

export function isAiEnabledForPlan(plan: string): boolean {
  return AI_PLANS.has(plan);
}

/** Override por comercio gana al plan. null = según plan. */
export function resolveAiEnabled(r: {
  plan: string;
  aiInsightsEnabled: boolean | null;
}): boolean {
  if (r.aiInsightsEnabled === true) return true;
  if (r.aiInsightsEnabled === false) return false;
  return isAiEnabledForPlan(r.plan);
}

/** Límite diario efectivo (override del comercio o default global). */
export async function dailyMessageLimit(
  restaurantDailyLimit: number | null,
): Promise<number> {
  if (typeof restaurantDailyLimit === "number") return restaurantDailyLimit;
  const cfg = await db.platformConfig.findUnique({ where: { id: "singleton" } });
  return cfg?.aiDailyMessageLimit ?? 50;
}

/**
 * ¿Cuántos mensajes de usuario ya gastó hoy este comercio? (zona UTC del server;
 * suficiente para un límite operativo). Cuenta AiMessage role="user" del día.
 */
export async function messagesUsedToday(restaurantId: string): Promise<number> {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return db.aiMessage.count({
    where: {
      role: "user",
      createdAt: { gte: start },
      conversation: { restaurantId },
    },
  });
}
```

- [ ] **Step 4: Correr el test → debe pasar**

Run: `npm test -- src/lib/ai/aiAccess.test.ts`
Expected: PASS (los 4 casos de gating). Las funciones async no se testean acá
(necesitan DB); se verifican en el endpoint.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/aiAccess.ts src/lib/ai/aiAccess.test.ts
git commit -m "feat(pulso): plan gating + daily limit helpers (tested)"
```

---

## Task 5: Tipos compartidos + rangos de fecha

**Files:**
- Create: `src/lib/ai/tools/types.ts`
- Create: `src/lib/ai/tools/dateRange.ts`
- Test: `src/lib/ai/tools/dateRange.test.ts`

- [ ] **Step 1: Crear `types.ts`**

```ts
import type { ZodTypeAny } from "zod";
import type { InsightsScope } from "../scope";

export type ToolContext = { scope: InsightsScope; timezone: string };

/** Una herramienta de analítica para el agente. */
export type ToolDef<I> = {
  name: string;
  description: string;
  inputSchema: ZodTypeAny; // valida el input que manda Claude
  jsonSchema: Record<string, unknown>; // schema que ve Claude (input_schema)
  run: (input: I, ctx: ToolContext) => Promise<unknown>;
};
```

- [ ] **Step 2: Escribir el test de `dateRange` (falla)**

```ts
import { describe, it, expect } from "vitest";
import { resolveRange, timezoneForCountry } from "./dateRange";

describe("timezoneForCountry", () => {
  it("mapea CO y MX, default Bogota", () => {
    expect(timezoneForCountry("CO")).toBe("America/Bogota");
    expect(timezoneForCountry("MX")).toBe("America/Mexico_City");
    expect(timezoneForCountry(null)).toBe("America/Bogota");
  });
});

describe("resolveRange", () => {
  it("preset 30d devuelve from <= to y ~30 días", () => {
    const now = new Date("2026-06-08T12:00:00Z");
    const r = resolveRange({ preset: "30d" }, now);
    const days = (r.to.getTime() - r.from.getTime()) / 86400000;
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThan(31);
    expect(r.from.getTime()).toBeLessThanOrEqual(r.to.getTime());
  });
  it("clampea rangos > 13 meses", () => {
    const now = new Date("2026-06-08T12:00:00Z");
    const r = resolveRange({ from: "2000-01-01", to: "2026-06-08" }, now);
    const days = (r.to.getTime() - r.from.getTime()) / 86400000;
    expect(days).toBeLessThanOrEqual(400);
  });
});
```

- [ ] **Step 3: Correr → falla**

Run: `npm test -- src/lib/ai/tools/dateRange.test.ts`
Expected: FAIL (módulo inexistente).

- [ ] **Step 4: Implementar `dateRange.ts`**

```ts
export type DateRange = { from: Date; to: Date };
export type RangeInput =
  | { preset: "7d" | "30d" | "90d" | "mtd" | "qtd" }
  | { from: string; to: string };

const MAX_DAYS = 400; // ~13 meses

export function timezoneForCountry(country: string | null | undefined): string {
  switch ((country || "").toUpperCase()) {
    case "MX":
      return "America/Mexico_City";
    case "CO":
      return "America/Bogota";
    default:
      return "America/Bogota";
  }
}

export function resolveRange(input: RangeInput, now = new Date()): DateRange {
  let to = now;
  let from: Date;
  if ("preset" in input) {
    const map: Record<string, number> = { "7d": 7, "30d": 30, "90d": 90 };
    if (input.preset === "mtd") {
      from = new Date(now.getFullYear(), now.getMonth(), 1);
    } else if (input.preset === "qtd") {
      const q = Math.floor(now.getMonth() / 3) * 3;
      from = new Date(now.getFullYear(), q, 1);
    } else {
      from = new Date(now.getTime() - (map[input.preset] ?? 30) * 86400000);
    }
  } else {
    from = new Date(input.from);
    to = new Date(input.to);
  }
  // clamp
  if ((to.getTime() - from.getTime()) / 86400000 > MAX_DAYS) {
    from = new Date(to.getTime() - MAX_DAYS * 86400000);
  }
  if (from.getTime() > to.getTime()) from = new Date(to.getTime() - 30 * 86400000);
  return { from, to };
}
```

- [ ] **Step 5: Correr → pasa**

Run: `npm test -- src/lib/ai/tools/dateRange.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/ai/tools/types.ts src/lib/ai/tools/dateRange.ts src/lib/ai/tools/dateRange.test.ts
git commit -m "feat(pulso): tool types + date-range/timezone helpers (tested)"
```

---

## Task 6: Primera tool — `top_dishes`

Diseño: `run()` hace el fetch fino (Prisma) y delega TODO el cálculo a un
agregador **puro** `aggregateTopDishes(rows, opts)` que se testea con fixtures.

**Files:**
- Create: `src/lib/ai/tools/topDishes.ts`
- Test: `src/lib/ai/tools/topDishes.test.ts`

- [ ] **Step 1: Escribir el test del agregador puro (falla)**

```ts
import { describe, it, expect } from "vitest";
import { aggregateTopDishes, type DishRow } from "./topDishes";

const rows: DishRow[] = [
  { name: "Taco", qty: 3, priceCents: 1000 },
  { name: "Taco", qty: 2, priceCents: 1000 },
  { name: "Agua", qty: 10, priceCents: 200 },
  { name: "Pizza", qty: 1, priceCents: 5000 },
];

describe("aggregateTopDishes", () => {
  it("ordena por cantidad y suma por nombre", () => {
    const out = aggregateTopDishes(rows, { by: "qty", limit: 2 });
    expect(out.map((d) => d.name)).toEqual(["Agua", "Taco"]);
    expect(out[0]).toMatchObject({ name: "Agua", qty: 10, revenueCents: 2000 });
    expect(out[1]).toMatchObject({ name: "Taco", qty: 5, revenueCents: 5000 });
  });
  it("ordena por ingreso", () => {
    const out = aggregateTopDishes(rows, { by: "revenue", limit: 1 });
    expect(out[0].name).toBe("Pizza"); // 5000
  });
});
```

- [ ] **Step 2: Correr → falla**

Run: `npm test -- src/lib/ai/tools/topDishes.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementar `topDishes.ts` (agregador puro + tool)**

```ts
import { z } from "zod";
import { db } from "@/lib/db";
import type { ToolContext, ToolDef } from "./types";
import { resolveRange, type RangeInput } from "./dateRange";

export type DishRow = { name: string; qty: number; priceCents: number };
export type TopDish = { name: string; qty: number; revenueCents: number };

/** PURO: agrupa por nombre, ordena por qty o ingreso, top-N. */
export function aggregateTopDishes(
  rows: DishRow[],
  opts: { by: "qty" | "revenue"; limit: number },
): TopDish[] {
  const map = new Map<string, TopDish>();
  for (const r of rows) {
    const cur = map.get(r.name) ?? { name: r.name, qty: 0, revenueCents: 0 };
    cur.qty += r.qty;
    cur.revenueCents += r.qty * r.priceCents;
    map.set(r.name, cur);
  }
  const arr = [...map.values()];
  arr.sort((a, b) =>
    opts.by === "revenue" ? b.revenueCents - a.revenueCents : b.qty - a.qty,
  );
  return arr.slice(0, opts.limit);
}

const inputSchema = z.object({
  range: z
    .union([
      z.object({ preset: z.enum(["7d", "30d", "90d", "mtd", "qtd"]) }),
      z.object({ from: z.string(), to: z.string() }),
    ])
    .default({ preset: "30d" }),
  by: z.enum(["qty", "revenue"]).default("qty"),
  limit: z.number().int().min(1).max(25).default(10),
});
type Input = z.infer<typeof inputSchema>;

export const topDishesTool: ToolDef<Input> = {
  name: "top_dishes",
  description:
    "Platos más vendidos del restaurante en un rango. Devuelve top-N por " +
    "cantidad o por ingreso. Útil para 'qué se vende más/menos'.",
  inputSchema,
  jsonSchema: {
    type: "object",
    properties: {
      range: {
        description: "Rango de fechas. Default últimos 30 días.",
        oneOf: [
          { type: "object", properties: { preset: { enum: ["7d", "30d", "90d", "mtd", "qtd"] } }, required: ["preset"] },
          { type: "object", properties: { from: { type: "string" }, to: { type: "string" } }, required: ["from", "to"] },
        ],
      },
      by: { type: "string", enum: ["qty", "revenue"], description: "Ordenar por cantidad o ingreso." },
      limit: { type: "integer", minimum: 1, maximum: 25 },
    },
  },
  async run(input: Input, ctx: ToolContext) {
    const { from, to } = resolveRange(input.range as RangeInput);
    const items = await db.orderItem.findMany({
      where: {
        cancelledAt: null,
        order: {
          restaurantId: ctx.scope.restaurantId, // SCOPE del server
          paidAt: { gte: from, lte: to },
        },
      },
      select: { nameSnapshot: true, qty: true, priceCentsSnapshot: true },
    });
    const rows: DishRow[] = items.map((i) => ({
      name: i.nameSnapshot,
      qty: i.qty,
      priceCents: i.priceCentsSnapshot,
    }));
    return {
      range: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
      by: input.by,
      dishes: aggregateTopDishes(rows, { by: input.by, limit: input.limit }),
    };
  },
};
```

- [ ] **Step 4: Correr → pasa**

Run: `npm test -- src/lib/ai/tools/topDishes.test.ts`
Expected: PASS (ambos casos).

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/tools/topDishes.ts src/lib/ai/tools/topDishes.test.ts
git commit -m "feat(pulso): top_dishes tool (pure aggregator tested)"
```

---

## Task 7: Tool registry

**Files:**
- Create: `src/lib/ai/toolRegistry.ts`

- [ ] **Step 1: Implementar el registry**

```ts
import type Anthropic from "@anthropic-ai/sdk";
import type { ToolContext, ToolDef } from "./tools/types";
import { topDishesTool } from "./tools/topDishes";

// Lista de tools disponibles. Planes siguientes agregan más acá.
const TOOLS: ToolDef<any>[] = [topDishesTool];

/** Definiciones que ve Claude (name/description/input_schema). */
export function anthropicTools(): Anthropic.Tool[] {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.jsonSchema as Anthropic.Tool.InputSchema,
  }));
}

/** Ejecuta una tool por nombre, validando el input con su Zod schema. */
export async function executeTool(
  name: string,
  rawInput: unknown,
  ctx: ToolContext,
): Promise<unknown> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { error: `tool desconocida: ${name}` };
  const parsed = tool.inputSchema.safeParse(rawInput ?? {});
  if (!parsed.success) return { error: "input inválido", issues: parsed.error.issues.slice(0, 3) };
  try {
    return await tool.run(parsed.data, ctx);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "tool falló" };
  }
}
```

- [ ] **Step 2: Build check**

Run: `npx tsc --noEmit`
Expected: sin errores nuevos.

- [ ] **Step 3: Commit**

```bash
git add src/lib/ai/toolRegistry.ts
git commit -m "feat(pulso): tool registry (anthropic schemas + executor)"
```

---

## Task 8: Loop del agente

**Files:**
- Create: `src/lib/ai/insightsAgent.ts`
- Test: `src/lib/ai/insightsAgent.test.ts`

- [ ] **Step 1: Escribir el test del loop (mock del cliente Anthropic) — falla**

```ts
import { describe, it, expect, vi } from "vitest";
import { runInsightsAgent } from "./insightsAgent";

function fakeClient(responses: any[]) {
  let i = 0;
  return { messages: { create: vi.fn(async () => responses[i++]) } } as any;
}
const ctx = { scope: { kind: "restaurant", restaurantId: "r1" }, timezone: "America/Bogota" } as any;

describe("runInsightsAgent", () => {
  it("ejecuta tool y devuelve el texto final", async () => {
    const client = fakeClient([
      { stop_reason: "tool_use", content: [
        { type: "tool_use", id: "t1", name: "top_dishes", input: { range: { preset: "30d" }, by: "qty", limit: 5 } },
      ]},
      { stop_reason: "end_turn", content: [{ type: "text", text: "Tu plato top es Taco." }] },
    ]);
    const exec = vi.fn(async () => ({ dishes: [{ name: "Taco", qty: 9 }] }));
    const out = await runInsightsAgent({
      client, model: "claude-x", system: "sys", messages: [{ role: "user", content: "top?" }],
      ctx, executeTool: exec, maxIterations: 6,
    });
    expect(exec).toHaveBeenCalledWith("top_dishes", expect.any(Object), ctx);
    expect(out.text).toContain("Taco");
    expect(out.toolCalls.map((c) => c.name)).toEqual(["top_dishes"]);
  });

  it("corta en maxIterations sin loop infinito", async () => {
    const toolMsg = { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t", name: "top_dishes", input: {} }] };
    const client = fakeClient([toolMsg, toolMsg, toolMsg, toolMsg]);
    const out = await runInsightsAgent({
      client, model: "m", system: "s", messages: [{ role: "user", content: "x" }],
      ctx, executeTool: vi.fn(async () => ({})), maxIterations: 2,
    });
    expect(client.messages.create).toHaveBeenCalledTimes(2);
    expect(out.text).toMatch(/no pude completar|límite/i);
  });
});
```

- [ ] **Step 2: Correr → falla**

Run: `npm test -- src/lib/ai/insightsAgent.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementar `insightsAgent.ts`**

```ts
import type Anthropic from "@anthropic-ai/sdk";
import type { ToolContext } from "./tools/types";

export type AgentMessage = { role: "user" | "assistant"; content: any };
export type AgentResult = {
  text: string;
  toolCalls: { name: string; input: unknown }[];
};

export async function runInsightsAgent(args: {
  client: Anthropic;
  model: string;
  system: string;
  messages: AgentMessage[];
  ctx: ToolContext;
  executeTool: (name: string, input: unknown, ctx: ToolContext) => Promise<unknown>;
  tools?: Anthropic.Tool[];
  maxIterations?: number;
}): Promise<AgentResult> {
  const { client, model, system, ctx, executeTool } = args;
  const messages: any[] = [...args.messages];
  const toolCalls: { name: string; input: unknown }[] = [];
  const maxIterations = args.maxIterations ?? 6;

  for (let i = 0; i < maxIterations; i++) {
    const res: any = await client.messages.create({
      model,
      max_tokens: 1500,
      system,
      tools: args.tools,
      messages,
    });
    const toolUses = (res.content ?? []).filter((b: any) => b.type === "tool_use");
    if (res.stop_reason !== "tool_use" || toolUses.length === 0) {
      const text = (res.content ?? [])
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("\n")
        .trim();
      return { text: text || "(sin respuesta)", toolCalls };
    }
    // Ejecutar todas las tools pedidas y devolver los resultados.
    messages.push({ role: "assistant", content: res.content });
    const results: any[] = [];
    for (const tu of toolUses) {
      toolCalls.push({ name: tu.name, input: tu.input });
      const out = await executeTool(tu.name, tu.input, ctx);
      results.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(out) });
    }
    messages.push({ role: "user", content: results });
  }
  return {
    text: "No pude completar el análisis (alcancé el límite de pasos). Probá una pregunta más específica.",
    toolCalls,
  };
}
```

- [ ] **Step 4: Correr → pasa**

Run: `npm test -- src/lib/ai/insightsAgent.test.ts`
Expected: PASS (ambos casos).

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/insightsAgent.ts src/lib/ai/insightsAgent.test.ts
git commit -m "feat(pulso): tool-use agent loop (tested with mocked client)"
```

---

## Task 9: Endpoint del chat

**Files:**
- Create: `src/app/api/operator/insights/chat/route.ts`

Patrón de auth: copiar de una route existente de operator (ej.
`src/app/api/operator/wallet/balance/route.ts`) — `auth()` + chequeo de rol.

- [ ] **Step 1: Implementar el endpoint**

```ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { getLocale } from "next-intl/server";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getClient, INSIGHTS_MODEL } from "@/lib/anthropic";
import { resolveInsightsScope } from "@/lib/ai/scope";
import { resolveAiEnabled, dailyMessageLimit, messagesUsedToday } from "@/lib/ai/aiAccess";
import { anthropicTools, executeTool } from "@/lib/ai/toolRegistry";
import { runInsightsAgent } from "@/lib/ai/insightsAgent";
import { timezoneForCountry } from "@/lib/ai/tools/dateRange";

const schema = z.object({
  message: z.string().min(1).max(2000),
  conversationId: z.string().optional(),
});

export async function POST(req: Request) {
  const session = await auth();
  const role = session?.user?.role;
  if (!session?.user || (role !== "operator" && role !== "platform_admin")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const scope = await resolveInsightsScope();
  if (!scope) return NextResponse.json({ error: "no_restaurant" }, { status: 400 });

  const r = await db.restaurant.findUnique({
    where: { id: scope.restaurantId },
    select: { plan: true, aiInsightsEnabled: true, aiDailyMessageLimit: true, name: true, country: true },
  });
  if (!r) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!resolveAiEnabled(r)) return NextResponse.json({ error: "feature_disabled" }, { status: 403 });

  const limit = await dailyMessageLimit(r.aiDailyMessageLimit);
  if ((await messagesUsedToday(scope.restaurantId)) >= limit) {
    return NextResponse.json({ error: "daily_limit", limit }, { status: 429 });
  }

  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });

  // Conversación (crear o continuar)
  let conv = parsed.data.conversationId
    ? await db.aiConversation.findFirst({ where: { id: parsed.data.conversationId, restaurantId: scope.restaurantId } })
    : null;
  if (!conv) {
    conv = await db.aiConversation.create({
      data: { restaurantId: scope.restaurantId, userId: session.user.id, title: parsed.data.message.slice(0, 60) },
    });
  }
  await db.aiMessage.create({ data: { conversationId: conv.id, role: "user", content: parsed.data.message } });

  // Historial reciente (últimos 10) como contexto
  const history = await db.aiMessage.findMany({
    where: { conversationId: conv.id },
    orderBy: { createdAt: "asc" },
    take: 20,
  });
  const messages = history.map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

  const locale = await getLocale(); // cookie MESAPAY_LOCALE (next-intl)
  const today = new Date().toISOString().slice(0, 10);
  const system =
    `Sos "Pulso", el analista de negocio del restaurante "${r.name}". Hoy es ${today}. ` +
    `Respondé SIEMPRE en el idioma: ${locale}. Usá SOLO las herramientas para obtener datos ` +
    `(nunca inventes cifras). Sé concreto: números clave, comparaciones y 1-2 recomendaciones ` +
    `accionables. Si una pregunta no se puede responder con las herramientas, decilo.`;

  const result = await runInsightsAgent({
    client: getClient(),
    model: INSIGHTS_MODEL,
    system,
    messages,
    ctx: { scope, timezone: timezoneForCountry(r.country) },
    executeTool,
    tools: anthropicTools(),
  });

  await db.aiMessage.create({
    data: { conversationId: conv.id, role: "assistant", content: result.text, toolCalls: result.toolCalls as any },
  });

  return NextResponse.json({ conversationId: conv.id, text: result.text, toolCalls: result.toolCalls });
}
```

- [ ] **Step 2: Exponer `getClient` + `INSIGHTS_MODEL` desde `src/lib/anthropic.ts`**

En `src/lib/anthropic.ts`: si `getClient()` es privada, exportarla
(`export function getClient()`), y agregar al final:
```ts
export const INSIGHTS_MODEL = process.env.ANTHROPIC_INSIGHTS_MODEL ?? "claude-sonnet-4-5";
```
> Confirmá el alias de Sonnet vigente en `node_modules/@anthropic-ai/sdk` o la doc;
> si difiere, ajustá el default. Es overrideable por env.

- [ ] **Step 3: Build check**

Run: `npx tsc --noEmit && npm run build`
Expected: compila. (No hay test automático del endpoint; se valida en runtime.)

- [ ] **Step 4: Commit**

```bash
git add "src/app/api/operator/insights/chat/route.ts" src/lib/anthropic.ts
git commit -m "feat(pulso): chat endpoint (gating, limit, persistence, agent)"
```

---

## Task 10: UI mínima del chat

**Files:**
- Create: `src/app/operator/insights/page.tsx`
- Create: `src/app/operator/insights/InsightsChat.tsx`

- [ ] **Step 1: Página server con gating**

```tsx
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { resolveAiEnabled } from "@/lib/ai/aiAccess";
import { InsightsChat } from "./InsightsChat";

export const dynamic = "force-dynamic";

export default async function InsightsPage() {
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) redirect("/operator");
  const r = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: { plan: true, aiInsightsEnabled: true },
  });
  const t = await getTranslations("insights");
  if (!r || !resolveAiEnabled(r)) {
    return <div className="p-6 max-w-2xl mx-auto text-op-muted">{t("disabled")}</div>;
  }
  return (
    <div className="p-4 sm:p-6 max-w-3xl mx-auto w-full">
      <h1 className="font-display text-3xl mb-1">{t("title")}</h1>
      <p className="text-op-muted text-sm mb-4">{t("subtitle")}</p>
      <InsightsChat />
    </div>
  );
}
```

- [ ] **Step 2: Cliente del chat (no-stream en v1; respuesta completa)**

```tsx
"use client";
import { useState } from "react";
import { useTranslations } from "next-intl";

type Msg = { role: "user" | "assistant"; content: string };

export function InsightsChat() {
  const t = useTranslations("insights");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [convId, setConvId] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const suggestions = [t("sug1"), t("sug2"), t("sug3")];

  async function send(text: string) {
    if (!text.trim() || busy) return;
    setMsgs((m) => [...m, { role: "user", content: text }]);
    setInput("");
    setBusy(true);
    try {
      const res = await fetch("/api/operator/insights/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: text, conversationId: convId }),
      });
      const j = await res.json();
      if (!res.ok) {
        setMsgs((m) => [...m, { role: "assistant", content: j.error === "daily_limit" ? t("limitReached") : t("error") }]);
      } else {
        setConvId(j.conversationId);
        setMsgs((m) => [...m, { role: "assistant", content: j.text }]);
      }
    } catch {
      setMsgs((m) => [...m, { role: "assistant", content: t("error") }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {msgs.length === 0 && (
        <div className="flex flex-wrap gap-2">
          {suggestions.map((s) => (
            <button key={s} onClick={() => send(s)}
              className="px-3 h-9 rounded-full border border-op-border bg-op-surface text-sm">
              {s}
            </button>
          ))}
        </div>
      )}
      <div className="flex flex-col gap-3">
        {msgs.map((m, i) => (
          <div key={i} className={m.role === "user" ? "self-end max-w-[85%]" : "self-start max-w-[90%]"}>
            <div className={"rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap " +
              (m.role === "user" ? "bg-ink text-bone" : "bg-op-surface border border-op-border")}>
              {m.content}
            </div>
          </div>
        ))}
        {busy && <div className="self-start text-op-muted text-sm">{t("thinking")}</div>}
      </div>
      <form onSubmit={(e) => { e.preventDefault(); send(input); }} className="flex gap-2 mt-2">
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder={t("placeholder")}
          className="flex-1 h-11 px-4 rounded-full border border-op-border bg-op-bg text-sm focus:outline-none focus:border-terracotta" />
        <button disabled={busy} className="h-11 px-5 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-50">
          {t("send")}
        </button>
      </form>
    </div>
  );
}
```

- [ ] **Step 3: Build check**

Run: `npm run build`
Expected: compila.

- [ ] **Step 4: Commit**

```bash
git add "src/app/operator/insights/page.tsx" "src/app/operator/insights/InsightsChat.tsx"
git commit -m "feat(pulso): minimal chat UI (operator)"
```

---

## Task 11: Admin — toggle + límite por comercio

**Files:**
- Modify: `src/app/admin/restaurants/[id]/page.tsx` (agregar un panel/sección)
- Modify or create: una route PATCH para guardar `aiInsightsEnabled` + `aiDailyMessageLimit` (reusar el patrón de `src/app/api/admin/restaurants/[id]/kushki/route.ts`).

- [ ] **Step 1: Route PATCH `/api/admin/restaurants/[id]/ai`**

```ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";

const schema = z.object({
  aiInsightsEnabled: z.boolean().nullable(),       // null = según plan
  aiDailyMessageLimit: z.number().int().min(1).max(1000).nullable(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (session?.user?.role !== "platform_admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  await db.restaurant.update({ where: { id }, data: parsed.data });
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 2: UI del panel en la página admin del comercio**

Agregar (siguiendo el estilo de los paneles existentes) un control client-side
con: select de `aiInsightsEnabled` (Heredar plan / Forzar ON / Forzar OFF) e
input de límite (vacío = default global), que hace PATCH a la route de arriba.
Reusar el patrón de `AdminPagosConfig.tsx` (select + save).

> El código completo del panel sigue el mismo patrón que `AdminPagosConfig.tsx`
> (Task de referencia: ese archivo). Crear `AdminAiConfig.tsx` con un Select y un
> input numérico que PATCHea `{ aiInsightsEnabled, aiDailyMessageLimit }`.

- [ ] **Step 3: Build check**

Run: `npm run build`
Expected: compila.

- [ ] **Step 4: Commit**

```bash
git add "src/app/api/admin/restaurants/[id]/ai/route.ts" "src/app/admin/restaurants/[id]"
git commit -m "feat(pulso): admin toggle + daily-limit override per commerce"
```

---

## Task 12: i18n + nav + verificación final

**Files:**
- Modify: `messages/es.json`, `messages/en.json`, `messages/pt.json`
- Modify: el nav de operator (donde estén los links de `/operator/*`) para agregar "Pulso", visible según gating.

- [ ] **Step 1: Agregar namespace `insights` a `es.json`**

```json
"insights": {
  "title": "Pulso",
  "subtitle": "Preguntale a tus datos sobre tu negocio.",
  "placeholder": "Escribí tu pregunta…",
  "send": "Enviar",
  "thinking": "Analizando tus datos…",
  "error": "Algo salió mal. Probá de nuevo.",
  "limitReached": "Alcanzaste el límite de preguntas de hoy.",
  "disabled": "El asistente Pulso no está habilitado para este comercio.",
  "sug1": "¿Cuáles son mis platos más vendidos este mes?",
  "sug2": "¿Qué platos casi no se venden?",
  "sug3": "Mostrame mis platos top por ingreso"
}
```

- [ ] **Step 2: Llenar en/pt y verificar paridad**

Run: `npm run i18n:sync` (necesita `ANTHROPIC_API_KEY`) — o copiar/traducir a mano.
Luego verificar paridad de claves entre los 3 catálogos.

- [ ] **Step 3: Agregar el link "Pulso" al nav de operator**

Localizar el componente de navegación de `/operator` (buscar los `<Link href="/operator/...">`)
y agregar un ítem a `/operator/insights`. (Opcional: ocultarlo si el feature está
deshabilitado — el page ya muestra un mensaje, así que mostrarlo siempre es aceptable v1.)

- [ ] **Step 4: Verificación final**

Run: `npm test && npm run lint && npm run build`
Expected: tests verdes, lint sin errores NUEVOS (los pre-existentes del repo no
cuentan), build OK.

- [ ] **Step 5: Commit**

```bash
git add messages/ src/app/operator
git commit -m "feat(pulso): i18n (es/en/pt) + operator nav entry"
```

---

## Self-review (cobertura del spec)

- ✅ Tool-use + scoping server-side (Tasks 3, 6, 9) — el `restaurantId` sale de la sesión.
- ✅ Gating por plan {trial,pro} + override + límite parametrizable (Tasks 4, 9, 11).
- ✅ Persistencia (AiConversation/AiMessage) (Tasks 2, 9).
- ✅ Modelo Sonnet, timezone por país (Tasks 9, 5).
- ✅ i18n, Claude responde en el locale (Tasks 9, 12).
- ✅ TDD de la lógica pura (aggregateTopDishes, gating, dateRange, loop) (Tasks 4,5,6,8).
- ⏭️ **Diferido a planes siguientes (explícito):** tools restantes (sales_overview,
  traffic_by_time, staff_performance, kitchen_bottlenecks, staffing_estimate,
  cancellations, category_breakdown, tables_turnover, payment_mix, revenue_trend,
  reservations_insights), captura de búsquedas (`SearchEvent`), scope de grupo, UI de
  historial, streaming. Cada uno sigue el patrón ya instalado en este plan.

**Nota de patrón para los planes siguientes:** agregar una tool = crear
`src/lib/ai/tools/<x>.ts` con un agregador puro (test con fixtures) + un `ToolDef`,
y registrarla en `TOOLS` de `toolRegistry.ts`. Nada más cambia.
