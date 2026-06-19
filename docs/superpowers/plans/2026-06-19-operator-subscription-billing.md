# Suscripción del operador con débito automático (Kushki) — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Página `/operator/settings/suscripcion` donde el operador ve su plan, su historial de pagos, administra la tarjeta para débito automático y cambia de plan — con cobro recurrente real vía Kushki.

**Architecture:** Modelo `BillingSubscription` (vínculo Kushki + estado de cobro + metadata de tarjeta, sin PAN) junto a los campos de plan que ya tiene `Restaurant`. Cobro vía abstracción `SubscriptionProvider` (mock-first, live = Kushki One-click & scheduled payments con la cuenta de plataforma). El historial reúsa `MembershipPayment`.

**Tech Stack:** Next.js (App Router modificado), Prisma/Postgres, next-intl (es/en/pt), Kushki JS SDK (tokenización client-side), provider abstraction existente en `src/lib/payments/`.

**Verificación (este repo NO usa jest/vitest):** cada tarea se verifica con `npx prisma generate` (si toca schema), `npx tsc --noEmit` (filtrando `.next/`), `npx eslint <archivos>`, el script de paridad i18n, y `npm run build`. Para lógica pura (prorrateo/fechas) se incluye un assert standalone con `node -e`. Workflow del repo: cada tarea/fase se mergea como PR squash a `main` (deploy blue/green corre `prisma db push`).

**Alcance de este plan:** Fase 1 (schema + provider + mock + env) y Fase 2 (página solo-lectura) — completas y entregables. Fases 3–5 (tokenización live + activar/cobrar, motor recurrente, cambio de plan) quedan como tareas resumidas al final; cada una se expandirá a plan detallado al llegar, porque dependen de confirmar el SDK/endpoints/webhook reales de Kushki en producción.

Spec: `docs/superpowers/specs/2026-06-19-operator-subscription-billing-design.md`

---

## Mapa de archivos

**Crear**
- `src/lib/payments/subscription.ts` — interface `SubscriptionProvider` + tipos request/result + resolver `getSubscriptionProvider(mode)`.
- `src/lib/payments/kushki/subscriptionMock.ts` — `MockSubscriptionProvider`.
- `src/lib/payments/kushki/subscriptionLive.ts` — `LiveSubscriptionProvider` (esqueleto con endpoints reales; lanza `not_configured` si faltan claves).
- `src/lib/billing/subscription.ts` — helpers puros: `currencyForCountry`, `prorationCents`, `addMonthsIso`, `resolvePlanPrice`.
- `src/app/operator/settings/suscripcion/page.tsx` — página server (solo-lectura en Fase 2).
- `src/app/operator/settings/suscripcion/SubscriptionClient.tsx` — sección cliente (en Fase 2 sólo render; crece en fases 3–5).

**Modificar**
- `prisma/schema.prisma` — `BillingSubscription`, `Restaurant.billingSubscription`, `MembershipMethod += kushki_card`, `MembershipPayment += providerRef, kind`.
- `src/app/operator/settings/page.tsx` — `SettingCard` hacia `/operator/settings/suscripcion`.
- `messages/{es,en,pt}.json` — namespace `opSubscription`.
- `eslint.config.mjs` — agregar los globs nuevos a `MIGRATED`.

---

## FASE 1 — Schema + provider abstraction + mock + env

### Task 1: Schema de facturación

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Agregar el enum value y campos a MembershipPayment**

En `enum MembershipMethod { manual_cash manual_transfer wompi }` agregar `kushki_card`:
```prisma
enum MembershipMethod {
  manual_cash
  manual_transfer
  wompi
  kushki_card
}
```
En `model MembershipPayment` agregar (después de `note`):
```prisma
  providerRef String? // id de transacción Kushki (null en pagos manuales)
  kind        String  @default("manual") // "initial" | "recurring" | "proration" | "manual"
```

- [ ] **Step 2: Agregar el modelo BillingSubscription**

Después de `model MembershipPayment { ... }`:
```prisma
/// Suscripción de débito automático del restaurante (1 por comercio).
/// Vincula al comercio con Kushki (One-click & scheduled payments) y
/// guarda SOLO metadata de tarjeta para mostrar — nunca el PAN. La
/// fuente de verdad del plan sigue en Restaurant (plan/monthlyPriceCents/
/// periodEndsAt/suspended); este modelo agrega el medio de pago + estado
/// de cobro recurrente. Ver docs/superpowers/specs/2026-06-19-operator-subscription-billing-design.md
model BillingSubscription {
  id                   String     @id @default(cuid())
  restaurantId         String     @unique
  restaurant           Restaurant @relation(fields: [restaurantId], references: [id], onDelete: Cascade)
  provider             String     @default("kushki")
  kushkiSubscriptionId String?
  plan                 Plan
  amountCents          Int
  currency             String // "COP" | "MXN"
  status               String     @default("active") // "active" | "past_due" | "canceled"
  cardBrand            String?
  cardLast4            String?
  cardExpMonth         Int?
  cardExpYear          Int?
  startedAt            DateTime   @default(now())
  currentPeriodEnd     DateTime?
  nextChargeAt         DateTime?
  failedAttempts       Int        @default(0)
  canceledAt           DateTime?
  createdAt            DateTime   @default(now())
  updatedAt            DateTime   @updatedAt

  @@index([status, nextChargeAt])
}
```
En `model Restaurant`, junto a `membershipPayments  MembershipPayment[]`, agregar:
```prisma
  billingSubscription BillingSubscription?
```

- [ ] **Step 3: Regenerar el cliente Prisma**

Run: `npx prisma generate`
Expected: "Generated Prisma Client" sin errores.

- [ ] **Step 4: Verificar typecheck**

Run: `npx tsc --noEmit 2>&1 | grep -v "\.next/" | head`
Expected: sin salida (exit 0). El nuevo modelo/campos compilan.

- [ ] **Step 5: Commit**

```bash
git checkout -b feat/billing-subscription-schema
git add prisma/schema.prisma
git commit -m "feat(billing): schema BillingSubscription + kushki_card + campos MembershipPayment"
```

### Task 2: Helpers puros de facturación

**Files:**
- Create: `src/lib/billing/subscription.ts`

- [ ] **Step 1: Escribir los helpers**

```ts
import type { Plan } from "@prisma/client";

/** Moneda de cobro según país ISO alpha-2 del comercio. Default COP. */
export function currencyForCountry(country: string | null | undefined): "COP" | "MXN" {
  return country === "MX" ? "MXN" : "COP";
}

/**
 * Suma `months` meses a una fecha y devuelve un ISO date (YYYY-MM-DD) en UTC.
 * Clampa el día si el mes destino es más corto (ej. 31 ene + 1 mes = 28/29 feb).
 */
export function addMonthsIso(from: Date, months: number): string {
  const y = from.getUTCFullYear();
  const m = from.getUTCMonth();
  const d = from.getUTCDate();
  const target = new Date(Date.UTC(y, m + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

/**
 * Diferencia prorrateada a cobrar AHORA en un upgrade.
 *   prorated = round((newMonthly - oldMonthly) * daysLeft / daysInPeriod)
 * Devuelve 0 si no es upgrade (newMonthly <= oldMonthly) o si daysLeft <= 0.
 */
export function prorationCents(args: {
  oldMonthlyCents: number;
  newMonthlyCents: number;
  daysLeft: number;
  daysInPeriod: number;
}): number {
  const { oldMonthlyCents, newMonthlyCents, daysLeft, daysInPeriod } = args;
  if (newMonthlyCents <= oldMonthlyCents) return 0;
  if (daysLeft <= 0 || daysInPeriod <= 0) return 0;
  const clampedDays = Math.min(daysLeft, daysInPeriod);
  return Math.round(((newMonthlyCents - oldMonthlyCents) * clampedDays) / daysInPeriod);
}

/** Días enteros entre dos fechas (b - a), mínimo 0. */
export function daysBetween(a: Date, b: Date): number {
  return Math.max(0, Math.floor((b.getTime() - a.getTime()) / 86_400_000));
}
```

- [ ] **Step 2: Sanity-check de la lógica pura (sin framework de tests)**

Run:
```bash
node --input-type=module -e '
import { prorationCents, addMonthsIso, daysBetween } from "./src/lib/billing/subscription.ts";
' 2>/dev/null || true
node -e '
const { execSync } = require("child_process");
' 2>/dev/null || true
```
Como el repo no transpila TS para node directo, validar la fórmula con un assert JS equivalente:
```bash
node -e '
function prorationCents({oldMonthlyCents,newMonthlyCents,daysLeft,daysInPeriod}){if(newMonthlyCents<=oldMonthlyCents)return 0;if(daysLeft<=0||daysInPeriod<=0)return 0;const c=Math.min(daysLeft,daysInPeriod);return Math.round(((newMonthlyCents-oldMonthlyCents)*c)/daysInPeriod);}
const a = prorationCents({oldMonthlyCents:20000000,newMonthlyCents:40000000,daysLeft:15,daysInPeriod:30});
if(a!==10000000) throw new Error("upgrade medio ciclo: esperado 10000000, dio "+a);
const b = prorationCents({oldMonthlyCents:40000000,newMonthlyCents:20000000,daysLeft:15,daysInPeriod:30});
if(b!==0) throw new Error("downgrade no cobra: esperado 0, dio "+b);
console.log("proration OK");
'
```
Expected: `proration OK`.

- [ ] **Step 3: Verificar typecheck + lint**

Run: `npx tsc --noEmit 2>&1 | grep -v "\.next/" | head && npx eslint src/lib/billing/subscription.ts`
Expected: ambos sin salida (exit 0).

- [ ] **Step 4: Commit**

```bash
git add src/lib/billing/subscription.ts
git commit -m "feat(billing): helpers puros (moneda por país, prorrateo, fechas)"
```

### Task 3: Interface SubscriptionProvider + tipos + resolver

**Files:**
- Create: `src/lib/payments/subscription.ts`
- Reference (patrón a imitar): `src/lib/payments/index.ts:19-67`

- [ ] **Step 1: Escribir la interface y el resolver**

```ts
import { resolveKushkiMode } from "@/lib/payments"; // si no existe export, usar process.env.KUSHKI_MODE / PlatformConfig (ver index.ts)
import { MockSubscriptionProvider } from "@/lib/payments/kushki/subscriptionMock";
import { LiveSubscriptionProvider } from "@/lib/payments/kushki/subscriptionLive";

export type CardMeta = {
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
};

export type CreateSubscriptionReq = {
  token: string;
  planName: string;
  amountCents: number;
  currency: "COP" | "MXN";
  startDateIso: string; // YYYY-MM-DD futuro
  contactDetails: { firstName: string; lastName: string; email: string };
  metadata?: Record<string, string>;
};
export type CreateSubscriptionResult = { subscriptionId: string; card: CardMeta };

export type ChargeNowReq = {
  subscriptionId: string;
  amountCents: number;
  currency: "COP" | "MXN";
  metadata?: Record<string, string>;
};
export type ChargeNowResult = {
  status: "approved" | "declined";
  transactionId: string | null;
  message?: string;
};

export interface SubscriptionProvider {
  createCardSubscription(req: CreateSubscriptionReq): Promise<CreateSubscriptionResult>;
  chargeSubscriptionNow(req: ChargeNowReq): Promise<ChargeNowResult>;
  updateSubscriptionCard(req: { subscriptionId: string; token: string }): Promise<{ card: CardMeta }>;
  cancelSubscription(req: { subscriptionId: string }): Promise<{ ok: boolean }>;
  getSubscription(req: { subscriptionId: string }): Promise<{ status: string; card: CardMeta } | null>;
}

/** mock | sandbox | production → mock usa el simulador; los otros, live. */
export function getSubscriptionProvider(mode: string): SubscriptionProvider {
  return mode === "mock" ? new MockSubscriptionProvider() : new LiveSubscriptionProvider();
}
```
NOTA al implementar: confirmar cómo `index.ts` resuelve el modo (función exportada vs inline) y reusar exactamente ese mecanismo; si no hay export reutilizable, leer `PlatformConfig.kushkiMode` con fallback a `process.env.KUSHKI_MODE` igual que ahí.

- [ ] **Step 2: typecheck**

Run: `npx tsc --noEmit 2>&1 | grep -v "\.next/" | head`
Expected: errores SÓLO por los imports de mock/live aún inexistentes (Task 4/5). Crear primero los archivos vacíos exportando las clases si se quiere verde intermedio.

- [ ] **Step 3: Commit** (junto con Task 4 y 5 para que compile)

### Task 4: MockSubscriptionProvider

**Files:**
- Create: `src/lib/payments/kushki/subscriptionMock.ts`

- [ ] **Step 1: Implementar el mock**

```ts
import type {
  SubscriptionProvider, CreateSubscriptionReq, CreateSubscriptionResult,
  ChargeNowReq, ChargeNowResult, CardMeta,
} from "@/lib/payments/subscription";

const MOCK_CARD: CardMeta = { brand: "visa", last4: "4242", expMonth: 12, expYear: 2030 };

/** Simula Kushki sin red. Cobro declinado determinístico: montos cuyos
 *  últimos 2 dígitos de pesos son "13" → declined (para probar dunning). */
export class MockSubscriptionProvider implements SubscriptionProvider {
  async createCardSubscription(req: CreateSubscriptionReq): Promise<CreateSubscriptionResult> {
    return { subscriptionId: `mock_sub_${req.planName}_${req.startDateIso}`, card: MOCK_CARD };
  }
  async chargeSubscriptionNow(req: ChargeNowReq): Promise<ChargeNowResult> {
    const declined = Math.floor(req.amountCents / 100) % 100 === 13;
    return declined
      ? { status: "declined", transactionId: null, message: "Tarjeta rechazada (mock)" }
      : { status: "approved", transactionId: `mock_tx_${req.subscriptionId}` };
  }
  async updateSubscriptionCard(): Promise<{ card: CardMeta }> {
    return { card: MOCK_CARD };
  }
  async cancelSubscription(): Promise<{ ok: boolean }> {
    return { ok: true };
  }
  async getSubscription(req: { subscriptionId: string }): Promise<{ status: string; card: CardMeta } | null> {
    return { status: "active", card: MOCK_CARD };
  }
}
```

- [ ] **Step 2: typecheck** — `npx tsc --noEmit 2>&1 | grep -v "\.next/" | head` (verde si Task 3+5 están).

### Task 5: LiveSubscriptionProvider (esqueleto real)

**Files:**
- Create: `src/lib/payments/kushki/subscriptionLive.ts`
- Reference: `src/lib/payments/kushki/live.ts` (cómo arma headers/baseUrl)

- [ ] **Step 1: Implementar el esqueleto con endpoints reales**

```ts
import type {
  SubscriptionProvider, CreateSubscriptionReq, CreateSubscriptionResult,
  ChargeNowReq, ChargeNowResult, CardMeta,
} from "@/lib/payments/subscription";

const BASE = process.env.KUSHKI_MODE === "production"
  ? "https://api.kushkipagos.com"
  : "https://api-uat.kushkipagos.com";

function privateKey(): string {
  const k = process.env.KUSHKI_BILLING_PRIVATE_KEY;
  if (!k) throw new Error("billing_not_configured: falta KUSHKI_BILLING_PRIVATE_KEY");
  return k;
}

/** Kushki One-click & scheduled payments con la cuenta de PLATAFORMA.
 *  Endpoints (confirmar contra doc/partner al activar producción):
 *   POST   /subscriptions/v1/card                 → crear (Private-Merchant-Id)
 *   POST   /subscriptions/v1/card/{id} (charge)   → cobro one-click
 *   PATCH  /subscriptions/v1/card/{id}            → cambiar tarjeta
 *   DELETE /subscriptions/v1/card/{id}            → cancelar
 *   GET    /subscriptions/v1/card/search/{id}     → consultar */
export class LiveSubscriptionProvider implements SubscriptionProvider {
  private async req(path: string, method: string, body?: unknown) {
    const r = await fetch(`${BASE}${path}`, {
      method,
      headers: { "content-type": "application/json", "Private-Merchant-Id": privateKey() },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`kushki_subscription_error:${r.status}:${JSON.stringify(json)}`);
    return json as Record<string, unknown>;
  }
  async createCardSubscription(req: CreateSubscriptionReq): Promise<CreateSubscriptionResult> {
    const resp = await this.req("/subscriptions/v1/card", "POST", {
      token: req.token,
      planName: req.planName,
      periodicity: "monthly",
      startDate: req.startDateIso,
      contactDetails: req.contactDetails,
      amount: { currency: req.currency, subtotalIva0: req.amountCents / 100, subtotalIva: 0, iva: 0, ice: 0 },
      metadata: req.metadata ?? {},
    });
    return {
      subscriptionId: String(resp.subscriptionId ?? ""),
      card: cardFrom(resp),
    };
  }
  async chargeSubscriptionNow(req: ChargeNowReq): Promise<ChargeNowResult> {
    const resp = await this.req(`/subscriptions/v1/card/${req.subscriptionId}`, "POST", {
      amount: { currency: req.currency, subtotalIva0: req.amountCents / 100, subtotalIva: 0, iva: 0, ice: 0 },
      metadata: req.metadata ?? {},
    });
    const ticket = resp.ticketNumber ?? resp.transactionReference;
    return ticket ? { status: "approved", transactionId: String(ticket) } : { status: "declined", transactionId: null };
  }
  async updateSubscriptionCard(req: { subscriptionId: string; token: string }): Promise<{ card: CardMeta }> {
    const resp = await this.req(`/subscriptions/v1/card/${req.subscriptionId}`, "PATCH", { token: req.token });
    return { card: cardFrom(resp) };
  }
  async cancelSubscription(req: { subscriptionId: string }): Promise<{ ok: boolean }> {
    await this.req(`/subscriptions/v1/card/${req.subscriptionId}`, "DELETE");
    return { ok: true };
  }
  async getSubscription(req: { subscriptionId: string }): Promise<{ status: string; card: CardMeta } | null> {
    const resp = await this.req(`/subscriptions/v1/card/search/${req.subscriptionId}`, "GET");
    return { status: String(resp.status ?? "active"), card: cardFrom(resp) };
  }
}

function cardFrom(resp: Record<string, unknown>): CardMeta {
  const c = (resp.card ?? {}) as Record<string, unknown>;
  return {
    brand: (c.brand as string) ?? null,
    last4: (c.lastFourDigits as string) ?? null,
    expMonth: c.expiryMonth ? Number(c.expiryMonth) : null,
    expYear: c.expiryYear ? Number(c.expiryYear) : null,
  };
}
```

- [ ] **Step 2: typecheck + lint** — `npx tsc --noEmit 2>&1 | grep -v "\.next/" | head && npx eslint src/lib/payments/subscription.ts src/lib/payments/kushki/subscriptionMock.ts src/lib/payments/kushki/subscriptionLive.ts`
Expected: exit 0.

- [ ] **Step 3: build + commit**

```bash
npm run build   # debe compilar verde
git add src/lib/payments/subscription.ts src/lib/payments/kushki/subscriptionMock.ts src/lib/payments/kushki/subscriptionLive.ts
git commit -m "feat(billing): SubscriptionProvider (interface + resolver + mock + live skeleton)"
```

- [ ] **Step 4: PR de la Fase 1**

```bash
git push -u origin feat/billing-subscription-schema
gh pr create --base main --title "feat(billing): fundación suscripción/débito automático (schema + provider + mock)" --body "Fase 1 del spec de suscripción. Sin UI. Ver docs/superpowers/specs/2026-06-19-operator-subscription-billing-design.md"
gh pr merge --squash --delete-branch
```

---

## FASE 2 — Página del operador (solo-lectura)

### Task 6: i18n del namespace opSubscription

**Files:**
- Modify: `messages/es.json`, `messages/en.json`, `messages/pt.json`

- [ ] **Step 1: Agregar el namespace `opSubscription` en `es.json`** (fuente de verdad)

```json
"opSubscription": {
  "title": "Suscripción",
  "subtitle": "Tu plan, tus pagos y tu método de débito automático.",
  "noRestaurant": "Sin restaurante.",
  "planKicker": "Plan activo",
  "planPrice": "{amount}/mes",
  "statusActive": "Activo",
  "statusOverdue": "Vencido",
  "statusSuspended": "Suspendido",
  "statusCanceled": "Débito cancelado",
  "nextChargeLabel": "Próximo cobro",
  "renewsLabel": "Vence",
  "noAutoDebit": "Sin débito automático",
  "historyKicker": "Historial de pagos",
  "historyEmpty": "Todavía no hay pagos registrados.",
  "colDate": "Fecha",
  "colPeriod": "Período",
  "colAmount": "Monto",
  "colMethod": "Método",
  "methodKushkiCard": "Tarjeta (débito automático)",
  "methodManualCash": "Efectivo",
  "methodManualTransfer": "Transferencia",
  "methodWompi": "Wompi",
  "kindInitial": "Activación",
  "kindRecurring": "Mensualidad",
  "kindProration": "Ajuste de plan",
  "kindManual": "Manual"
}
```

- [ ] **Step 2: Traducir a en.json y pt.json** (mismas claves, valores traducidos). Si `ANTHROPIC_API_KEY` está disponible: `npm run i18n:sync`. Si no, agregar las claves a mano en `en.json` y `pt.json`.

- [ ] **Step 3: Verificar paridad**

Run:
```bash
node -e '
const fs=require("fs");const es=JSON.parse(fs.readFileSync("messages/es.json")),en=JSON.parse(fs.readFileSync("messages/en.json")),pt=JSON.parse(fs.readFileSync("messages/pt.json"));
function k(o,p=""){let r=[];for(const x in o){const v=o[x],kp=p?p+"."+x:x;if(v&&typeof v==="object"&&!Array.isArray(v))r=r.concat(k(v,kp));else r.push(kp);}return r;}
const a=k(es),b=k(en),c=k(pt);console.log(a.length,b.length,c.length);
console.log("missing en",a.filter(x=>!b.includes(x)),"missing pt",a.filter(x=>!c.includes(x)));
'
```
Expected: los tres counts iguales; "missing" vacíos.

- [ ] **Step 4: Commit**

```bash
git checkout -b feat/operator-subscription-page
git add messages/es.json messages/en.json messages/pt.json
git commit -m "feat(i18n): namespace opSubscription (es/en/pt)"
```

### Task 7: Página server `/operator/settings/suscripcion`

**Files:**
- Create: `src/app/operator/settings/suscripcion/page.tsx`
- Reference (patrón de page operator + getActiveRestaurantId): `src/app/operator/settings/staff-policies/page.tsx`
- Reference (historial/billing): `src/app/admin/restaurants/[id]/BillingPanel.tsx`

- [ ] **Step 1: Escribir la página**

```tsx
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { fmtMoney } from "@/lib/format";
import { SubscriptionClient } from "./SubscriptionClient";

export const dynamic = "force-dynamic";

export default async function SubscriptionPage() {
  const t = await getTranslations("opSubscription");
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) return <div className="p-6">{t("noRestaurant")}</div>;

  const tenant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: {
      plan: true, monthlyPriceCents: true, periodEndsAt: true, suspended: true, country: true,
      billingSubscription: true,
      membershipPayments: { orderBy: { createdAt: "desc" }, take: 50 },
    },
  });
  if (!tenant) return <div className="p-6">{t("noRestaurant")}</div>;

  return (
    <div className="p-6 max-w-3xl mx-auto w-full">
      <Link href="/operator/settings" className="text-sm text-op-muted hover:underline">
        {/* reusar key existente de backToSettings del namespace opSettings vía getTranslations en server si se quiere */}
        ←
      </Link>
      <div className="font-display text-3xl mt-2 mb-1">{t("title")}</div>
      <p className="text-sm text-op-muted mb-6">{t("subtitle")}</p>

      <SubscriptionClient
        plan={tenant.plan}
        monthlyPriceCents={tenant.monthlyPriceCents}
        periodEndsAtIso={tenant.periodEndsAt?.toISOString() ?? null}
        suspended={tenant.suspended}
        country={tenant.country}
        subscription={
          tenant.billingSubscription
            ? {
                status: tenant.billingSubscription.status,
                cardBrand: tenant.billingSubscription.cardBrand,
                cardLast4: tenant.billingSubscription.cardLast4,
                cardExpMonth: tenant.billingSubscription.cardExpMonth,
                cardExpYear: tenant.billingSubscription.cardExpYear,
                nextChargeAtIso: tenant.billingSubscription.nextChargeAt?.toISOString() ?? null,
              }
            : null
        }
        payments={tenant.membershipPayments.map((p) => ({
          id: p.id,
          createdAtIso: p.createdAt.toISOString(),
          periodStartIso: p.periodStart.toISOString(),
          periodEndIso: p.periodEnd.toISOString(),
          amountCents: p.amountCents,
          method: p.method,
          kind: p.kind,
        }))}
      />
    </div>
  );
}
```
NOTA: confirmar la firma de `fmtMoney` en `src/lib/format.ts` (currency + locale). El cliente usa `useFormatter`/`fmtMoney` igual que el resto de superficies operator.

- [ ] **Step 2: typecheck** — `npx tsc --noEmit 2>&1 | grep -v "\.next/" | head` (errores sólo por `SubscriptionClient` aún inexistente; crear en Task 8).

### Task 8: SubscriptionClient (render solo-lectura)

**Files:**
- Create: `src/app/operator/settings/suscripcion/SubscriptionClient.tsx`

- [ ] **Step 1: Escribir el componente cliente** (3 cards: plan activo, método de pago, historial). Solo-lectura en Fase 2: el método de pago muestra la tarjeta guardada o "Sin débito automático" (los botones de activar/cambiar/cancelar y cambiar plan llegan en fases 3–5). Usa `useTranslations("opSubscription")` y `fmtMoney`. Estado derivado: `suspended` → `statusSuspended`; si `periodEndsAt < now` → `statusOverdue`; si `subscription?.status === "canceled"` → `statusCanceled`; si no → `statusActive`. Mapear `method`/`kind` con las keys `methodX`/`kindX`. Formatear fechas con `@/lib/format` (`formatDate`). Tabla del historial más reciente primero (ya viene ordenada).

- [ ] **Step 2: typecheck + lint + build**

Run: `npx tsc --noEmit 2>&1 | grep -v "\.next/" | head && npx eslint src/app/operator/settings/suscripcion/page.tsx src/app/operator/settings/suscripcion/SubscriptionClient.tsx && npm run build`
Expected: exit 0; la ruta `/operator/settings/suscripcion` aparece en el output del build.

- [ ] **Step 3: Commit**

```bash
git add src/app/operator/settings/suscripcion
git commit -m "feat(operator): página de suscripción (plan + historial, solo-lectura)"
```

### Task 9: SettingCard + glob MIGRATED

**Files:**
- Modify: `src/app/operator/settings/page.tsx`
- Modify: `eslint.config.mjs`

- [ ] **Step 1: Agregar el SettingCard** hacia `/operator/settings/suscripcion` (copiar el patrón de un `SettingCard` existente, con título `t("...")` del namespace `opSettings` — agregar las keys `subscriptionCardTitle`/`subscriptionCardDesc` a `opSettings` en los 3 catálogos y verificar paridad).

- [ ] **Step 2: Agregar los globs a MIGRATED** en `eslint.config.mjs`:
```js
"src/app/operator/settings/suscripcion/**/*.{ts,tsx}",
```

- [ ] **Step 3: lint + paridad + build**

Run: `npx eslint src/app/operator/settings/suscripcion src/app/operator/settings/page.tsx && npm run build` + el script de paridad i18n del Task 6.
Expected: exit 0; sin literales hardcodeados en los archivos migrados.

- [ ] **Step 4: Commit + PR de la Fase 2**

```bash
git add src/app/operator/settings/page.tsx eslint.config.mjs messages/*.json
git commit -m "feat(operator): entrada Suscripción en Configuración + glob MIGRATED"
git push -u origin feat/operator-subscription-page
gh pr create --base main --title "feat(operator): página de suscripción (plan + historial)" --body "Fase 2. Solo-lectura; activar/cambiar tarjeta y cambiar plan en fases 3-5."
gh pr merge --squash --delete-branch
```

---

## FASES 3–5 (resumen — se expanden a plan detallado al llegar)

Dependen de confirmar el **SDK JS de Kushki** (carga del script, `requestSubscriptionToken`, clave pública de plataforma) y el **payload del webhook** de recurring payments contra la doc/partner. Por eso se planifican en detalle justo antes de ejecutarlas.

**Fase 3 — Bóveda de tarjeta + activar:**
- Cargar el SDK de Kushki en la página; componente `CardForm` que tokeniza (clave pública de plataforma) sin que el PAN toque el server.
- `POST /api/operator/subscription/activate { token, planTier }`: resolver precio (planCatalog) + moneda (`currencyForCountry`), `startDate` condicional (Regla A del spec), `createCardSubscription` + cobro one-click condicional, persistir `BillingSubscription` + `MembershipPayment(initial)` + avanzar `Restaurant`. Cancelar suscripción huérfana si el primer cobro es declined. Audit `subscription.activate`.
- `PATCH /api/operator/subscription/card { token }` (cambiar tarjeta). `POST /api/operator/subscription/cancel` (cancelar). UI: botones en `SubscriptionClient` + sheet de tarjeta. i18n.

**Fase 4 — Motor recurrente:**
- `POST /api/webhooks/kushki/billing`: validar firma + idempotencia (patrón del webhook Kushki actual), aplicar approved/declined (helper `applyChargeResult` en `src/lib/billing/subscription.ts`), `MembershipPayment(recurring)` + avanzar `periodEndsAt`/`nextChargeAt`, o `past_due`+`failedAttempts++`.
- `GET /api/cron/billing-sync` (header `x-cron-secret`): reconciliación de cobros con webhook perdido.
- Enganchar `past_due` al cron de recordatorios/auto-suspend existente.

**Fase 5 — Cambio de plan self-service:**
- `POST /api/operator/subscription/change-plan { planTier }`: prorrateo (`prorationCents`), upgrade = cobro one-click ahora + `MembershipPayment(proration)` + cambiar features; downgrade = features ya, sin reembolso; en ambos cancel+recreate de la suscripción Kushki al nuevo monto con `startDate = periodEndsAt`. Audit `subscription.change_plan`.
- UI: selector de planes (tiers visibles de `PlanConfig`) con preview del prorrateo antes de confirmar.

---

## Self-review

**1. Cobertura del spec:**
- Procesador Kushki plataforma mock-first → Task 3/4/5 (provider + mock + live) + env en Task 5. ✓
- Modelo `BillingSubscription` + `MembershipMethod.kushki_card` + `MembershipPayment` campos → Task 1. ✓
- Tokenización PCI (SDK, sin PAN) → Fase 3 (resumen). ✓
- Activar (primer cobro condicional) / recurrente / cambiar tarjeta / cambiar plan prorrateo / cancelar → Fase 3/4/5. ✓
- Página operador (plan, método, cambiar plan, historial) → Task 7/8 (lectura) + Fase 3/5 (acciones). ✓
- i18n es/en/pt → Task 6/9. ✓
- Helpers (moneda, prorrateo, fechas) → Task 2. ✓
- Seguridad/audit/idempotencia → Fase 3/4 (resumen) + auth `getActiveRestaurantId` en Task 7. ✓

**2. Placeholders:** Las "NOTA" en Task 3/7 son confirmaciones de patrón existente (no gaps de código). Fases 3–5 están explícitamente diferidas a plan detallado por dependencia externa (Kushki SDK/webhook real), no por pereza.

**3. Consistencia de tipos:** `SubscriptionProvider`, `CardMeta`, `CreateSubscriptionReq/Result`, `ChargeNowReq/Result` se usan idénticos en mock (Task 4) y live (Task 5). `BillingSubscription` campos coinciden entre Task 1 (schema) y Task 7 (select). `MembershipPayment.kind`/`providerRef` coinciden Task 1 ↔ Task 7/8.
