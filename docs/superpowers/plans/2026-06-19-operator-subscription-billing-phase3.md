# Suscripción operador — Fase 3 (activar/cambiar/cancelar con Kushki)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que el operador pueda activar débito automático (tokenizar tarjeta en browser → crear suscripción Kushki + cobro one-click → persistir), cambiar tarjeta, y cancelar; probado en mock y sandbox.

**Architecture:** Browser tokeniza la tarjeta contra Kushki con `KUSHKI_BILLING_PUBLIC_KEY` (nunca llega el PAN al servidor MESAPAY). El backend usa `LiveSubscriptionProvider` refactorizado para pasar por `kushkiFetch` con `auth: { kind: "billing" }` (header `Private-Merchant-Id: KUSHKI_BILLING_PRIVATE_KEY`). Tres endpoints REST protegidos (operator/platform_admin). En mock: token falso + MockSubscriptionProvider aprueba.

**Tech Stack:** Next.js App Router, Prisma (sin migrations — prod DB), next-intl (es/en/pt), zod, kushkiFetch (client.ts ya existe), react useTranslations

---

## File map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/lib/env.ts` | Modify | Añadir `KUSHKI_BILLING_PUBLIC_KEY` optional |
| `src/lib/payments/kushki/client.ts` | Modify | Añadir variante `billing` en `FetchOpts.auth` |
| `src/lib/payments/kushki/subscriptionLive.ts` | Rewrite | Usar `kushkiFetch` + `mode` por constructor; quitar `req()` |
| `src/lib/payments/subscription.ts` | Modify | `providerFor` pasa `mode` al constructor de Live |
| `src/lib/billing/subscription.ts` | Modify | Añadir `resolvePlanPrice()` + `applyInitialCharge()` |
| `src/lib/auditLog.ts` | Modify | Añadir 3 AuditKind values + labels |
| `src/app/api/operator/subscription/activate/route.ts` | Create | POST activate endpoint |
| `src/app/api/operator/subscription/cancel/route.ts` | Create | POST cancel endpoint |
| `src/app/api/operator/subscription/card/route.ts` | Create | PATCH card endpoint |
| `src/app/operator/settings/suscripcion/CardForm.tsx` | Create | UI: inputs tarjeta + tokenización Kushki |
| `src/app/operator/settings/suscripcion/SubscriptionClient.tsx` | Modify | Añadir botones activate/change-card/cancel + integrar CardForm |
| `src/app/operator/settings/suscripcion/page.tsx` | Modify | Pasar `kushkiPublicKey` + `kushkiMode` al cliente |
| `messages/es.json` | Modify | Keys nuevas en `opSubscription` |
| `messages/en.json` | Modify | Traducción inglés |
| `messages/pt.json` | Modify | Traducción portugués |

---

## Task 1: env.ts + kushkiFetch billing auth + refactorizar subscriptionLive.ts

**Files:**
- Modify: `src/lib/env.ts`
- Modify: `src/lib/payments/kushki/client.ts`
- Modify: `src/lib/payments/kushki/subscriptionLive.ts`
- Modify: `src/lib/payments/subscription.ts`

### Context antes de editar

`client.ts` tiene `FetchOpts.auth` con tres variantes: `partner`, `submerchant`, `submerchant_public`. Necesitamos `billing` que usa `KUSHKI_BILLING_PRIVATE_KEY`.

`subscriptionLive.ts` actualmente tiene un `req()` privado propio que hace `fetch` crudo usando `process.env.KUSHKI_MODE`. Hay un TODO explícito en línea 29 que dice exactamente lo que hay que hacer. El constructor no toma `mode` — hay que añadírselo.

`subscription.ts` en `providerFor` crea `new LiveSubscriptionProvider()` sin argumentos — hay que pasar `mode`.

- [ ] **Step 1.1: Añadir `KUSHKI_BILLING_PUBLIC_KEY` en `src/lib/env.ts`**

En `src/lib/env.ts`, dentro del schema zod, después del bloque `KUSHKI_BILLING_PRIVATE_KEY`, añadir:

```typescript
  // Clave PÚBLICA de la cuenta de plataforma para tokenizar en el browser.
  // Segura de exponer al cliente. Requerida en sandbox/production.
  KUSHKI_BILLING_PUBLIC_KEY: z.string().optional(),
```

- [ ] **Step 1.2: Añadir variante `billing` en `src/lib/payments/kushki/client.ts`**

En `client.ts`, la definición de `FetchOpts.auth` (líneas 66–72 aprox.) actualmente termina en:
```typescript
  auth:
    | { kind: "partner" }
    | { kind: "submerchant"; privateKey: string }
    | { kind: "submerchant_public"; publicKey: string };
```

Cambiar a:
```typescript
  auth:
    | { kind: "partner" }
    | { kind: "submerchant"; privateKey: string }
    | { kind: "submerchant_public"; publicKey: string }
    | { kind: "billing" };
```

En la función `kushkiFetch`, en el bloque que setea el header (líneas 88–95 aprox.), añadir el caso `billing` al final del if-else:

```typescript
  if (opts.auth.kind === "partner") {
    headers["Private-Merchant-Id"] = requireKushkiKey();
  } else if (opts.auth.kind === "submerchant") {
    headers["Private-Merchant-Id"] = opts.auth.privateKey;
  } else if (opts.auth.kind === "billing") {
    const billingKey = env.KUSHKI_BILLING_PRIVATE_KEY;
    if (!billingKey) throw new Error("billing_not_configured: falta KUSHKI_BILLING_PRIVATE_KEY");
    headers["Private-Merchant-Id"] = billingKey;
  } else {
    headers["Public-Merchant-Id"] = opts.auth.publicKey;
  }
```

Añadir import de `env` al tope del archivo si no está (ya tiene `requireKushkiKey` que importa de `../../env`; `env` viene del mismo módulo):

```typescript
import { requireKushkiKey, env } from "../../env";
```

- [ ] **Step 1.3: Reescribir `src/lib/payments/kushki/subscriptionLive.ts`**

Reemplazar el archivo completo. La reescritura:
- Elimina `req()` propio y la constante `BASE`
- Agrega constructor con `mode?: KushkiMode`
- Usa `kushkiFetch<Record<string,unknown>>(path, { method, auth: { kind:"billing" }, mode: this.mode, body })` en cada método
- Mantiene los mismos 5 métodos y la misma interfaz pública
- Agrega logging verbose `console.log("[billing] ...")` con shapes seguros (no el token, no el PAN, no la private key)
- Deja `// VERIFY vs sandbox` en los endpoints donde el shape exacto no está confirmado

```typescript
import type {
  SubscriptionProvider,
  CreateSubscriptionReq,
  CreateSubscriptionResult,
  ChargeNowReq,
  ChargeNowResult,
  CardMeta,
} from "@/lib/payments/subscription";
import { kushkiFetch } from "@/lib/payments/kushki/client";
import type { KushkiMode } from "@/lib/platformConfig";

/**
 * Kushki One-click & scheduled payments con la cuenta de PLATAFORMA.
 *
 * Endpoints usados (base: api-uat.kushkipagos.com o api.kushkipagos.com):
 *   POST   /subscriptions/v1/card               → crear suscripción    // VERIFY vs sandbox
 *   POST   /subscriptions/v1/card/{id}/charge   → cobro on-demand      // VERIFY vs sandbox: puede ser /subscriptions/v1/card/{id}
 *   PATCH  /subscriptions/v1/card/{id}          → cambiar tarjeta      // VERIFY vs sandbox
 *   DELETE /subscriptions/v1/card/{id}          → cancelar             // VERIFY vs sandbox
 *   GET    /subscriptions/v1/card/search/{id}   → consultar            // VERIFY vs sandbox
 *
 * Auth: Private-Merchant-Id con KUSHKI_BILLING_PRIVATE_KEY (via kushkiFetch billing).
 * PCI: el PAN nunca llega aquí; solo el token generado por el browser.
 */
export class LiveSubscriptionProvider implements SubscriptionProvider {
  private readonly mode: KushkiMode | undefined;

  constructor(mode?: KushkiMode) {
    this.mode = mode;
  }

  async createCardSubscription(req: CreateSubscriptionReq): Promise<CreateSubscriptionResult> {
    const body = {
      token: req.token,
      planName: req.planName,
      periodicity: "monthly",
      startDate: req.startDateIso, // YYYY-MM-DD futuro (no mismo día)
      contactDetails: req.contactDetails,
      amount: {
        currency: req.currency,
        subtotalIva0: req.amountCents / 100,
        subtotalIva: 0,
        iva: 0,
        ice: 0,
      },
      metadata: req.metadata ?? {},
    };
    console.log("[billing] createCardSubscription req shape", {
      planName: req.planName,
      amountCents: req.amountCents,
      currency: req.currency,
      startDateIso: req.startDateIso,
      hasToken: !!req.token,
      contactEmail: req.contactDetails.email,
    });

    // VERIFY vs sandbox: confirmar que POST /subscriptions/v1/card acepta este body.
    const resp = await kushkiFetch<Record<string, unknown>>(
      "/subscriptions/v1/card",
      { method: "POST", auth: { kind: "billing" }, mode: this.mode, body },
    );
    console.log("[billing] createCardSubscription resp shape", {
      subscriptionId: resp.subscriptionId,
      hasCard: !!(resp.card),
    });

    return {
      subscriptionId: String(resp.subscriptionId ?? ""),
      card: cardFrom(resp),
    };
  }

  async chargeSubscriptionNow(req: ChargeNowReq): Promise<ChargeNowResult> {
    const body = {
      amount: {
        currency: req.currency,
        subtotalIva0: req.amountCents / 100,
        subtotalIva: 0,
        iva: 0,
        ice: 0,
      },
      metadata: req.metadata ?? {},
    };
    console.log("[billing] chargeSubscriptionNow req shape", {
      subscriptionId: req.subscriptionId,
      amountCents: req.amountCents,
      currency: req.currency,
    });

    // VERIFY vs sandbox: confirmar el path de cobro on-demand.
    // Puede ser /subscriptions/v1/card/{id} (POST distinto al de crear)
    // o /subscriptions/v1/card/{id}/charge. El body de arriba es best-guess.
    const resp = await kushkiFetch<Record<string, unknown>>(
      `/subscriptions/v1/card/${req.subscriptionId}`,
      { method: "POST", auth: { kind: "billing" }, mode: this.mode, body },
    );

    // VERIFY vs sandbox: confirmar qué campo indica aprobación.
    // Intentamos ticketNumber, transactionReference, transactionId.
    const ticket =
      (resp.ticketNumber ?? resp.transactionReference ?? resp.transactionId) as string | undefined;
    const approved = ticket != null;
    console.log("[billing] chargeSubscriptionNow resp shape", {
      hasTicket: approved,
      ticket,
      status: resp.ticketStatus ?? resp.status,
    });

    return approved
      ? { status: "approved", transactionId: String(ticket) }
      : { status: "declined", transactionId: null, message: String(resp.message ?? resp.text ?? "declined") };
  }

  async updateSubscriptionCard(req: { subscriptionId: string; token: string }): Promise<{ card: CardMeta }> {
    console.log("[billing] updateSubscriptionCard req shape", {
      subscriptionId: req.subscriptionId,
      hasToken: !!req.token,
    });

    // VERIFY vs sandbox: confirmar que PATCH /subscriptions/v1/card/{id} acepta { token }.
    const resp = await kushkiFetch<Record<string, unknown>>(
      `/subscriptions/v1/card/${req.subscriptionId}`,
      { method: "PUT", auth: { kind: "billing" }, mode: this.mode, body: { token: req.token } },
    );
    console.log("[billing] updateSubscriptionCard resp shape", { hasCard: !!(resp.card) });
    return { card: cardFrom(resp) };
  }

  async cancelSubscription(req: { subscriptionId: string }): Promise<{ ok: boolean }> {
    console.log("[billing] cancelSubscription req shape", {
      subscriptionId: req.subscriptionId,
    });

    // VERIFY vs sandbox: confirmar que DELETE /subscriptions/v1/card/{id} cancela.
    await kushkiFetch<Record<string, unknown>>(
      `/subscriptions/v1/card/${req.subscriptionId}`,
      { method: "DELETE", auth: { kind: "billing" }, mode: this.mode },
    );
    console.log("[billing] cancelSubscription ok");
    return { ok: true };
  }

  async getSubscription(req: { subscriptionId: string }): Promise<{ status: string; card: CardMeta } | null> {
    console.log("[billing] getSubscription req shape", {
      subscriptionId: req.subscriptionId,
    });

    // VERIFY vs sandbox: confirmar path GET /subscriptions/v1/card/search/{id}.
    const resp = await kushkiFetch<Record<string, unknown>>(
      `/subscriptions/v1/card/search/${req.subscriptionId}`,
      { method: "GET", auth: { kind: "billing" }, mode: this.mode },
    );
    console.log("[billing] getSubscription resp shape", {
      status: resp.status ?? resp.subscriptionStatus,
      hasCard: !!(resp.card),
    });
    return { status: String(resp.status ?? resp.subscriptionStatus ?? "active"), card: cardFrom(resp) };
  }
}

/**
 * Extrae metadatos de tarjeta del response de Kushki.
 * Tolerante a variantes de nombres de campo (cardBrand, brand, lastFourDigits, last4, etc.).
 * VERIFY vs sandbox: confirmar los nombres exactos en las respuestas reales.
 */
function cardFrom(resp: Record<string, unknown>): CardMeta {
  const c = ((resp.card ?? resp.cardInfo ?? {}) as Record<string, unknown>);
  return {
    brand: (c.brand ?? c.cardBrand ?? resp.cardBrand) as string | null ?? null,
    last4: (c.lastFourDigits ?? c.last4 ?? resp.lastFourDigits) as string | null ?? null,
    expMonth: Number((c.expiryMonth ?? c.expMonth ?? resp.expiryMonth) ?? 0) || null,
    expYear: Number((c.expiryYear ?? c.expYear ?? resp.expiryYear) ?? 0) || null,
  };
}
```

- [ ] **Step 1.4: Actualizar `src/lib/payments/subscription.ts` para pasar `mode` al constructor**

En `subscription.ts`, en la función `providerFor`, cambiar la línea de creación de `LiveSubscriptionProvider`:

```typescript
// Antes:
const provider: SubscriptionProvider =
  mode === "mock" ? new MockSubscriptionProvider() : new LiveSubscriptionProvider();

// Después:
const provider: SubscriptionProvider =
  mode === "mock" ? new MockSubscriptionProvider() : new LiveSubscriptionProvider(mode);
```

- [ ] **Step 1.5: Verificar TypeScript**

```bash
cd /Users/nicolas/Documents/APPS/MESAPAY
npx tsc --noEmit 2>&1 | grep -v "\.next/" | head -30
```

Resultado esperado: sin output (0 errores).

- [ ] **Step 1.6: Commit Task 1**

```bash
cd /Users/nicolas/Documents/APPS/MESAPAY
git add src/lib/env.ts src/lib/payments/kushki/client.ts src/lib/payments/kushki/subscriptionLive.ts src/lib/payments/subscription.ts
git commit -m "$(cat <<'EOF'
feat(billing): kushkiFetch billing auth + reconcile LiveSubscriptionProvider

- env.ts: KUSHKI_BILLING_PUBLIC_KEY optional
- client.ts: nueva variante auth { kind: "billing" } → Private-Merchant-Id: BILLING_PRIVATE_KEY
- subscriptionLive.ts: usa kushkiFetch+billing en vez de fetch crudo; mode por constructor; logging verboso; flags VERIFY vs sandbox en endpoints
- subscription.ts: pasa mode al constructor de LiveSubscriptionProvider

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Billing helpers + 3 endpoints API

**Files:**
- Modify: `src/lib/billing/subscription.ts`
- Modify: `src/lib/auditLog.ts`
- Create: `src/app/api/operator/subscription/activate/route.ts`
- Create: `src/app/api/operator/subscription/cancel/route.ts`
- Create: `src/app/api/operator/subscription/card/route.ts`

### Context antes de editar

`src/lib/billing/subscription.ts` actualmente tiene: `currencyForCountry`, `addMonthsIso`, `prorationCents`, `daysBetween`. No toca la DB — hay que añadir funciones que sí la tocan.

`planCatalog.ts` tiene `getPlanByTier(tier: Plan): Promise<PlanCatalogEntry>` donde `PlanCatalogEntry.defaultPriceCents: number`.

El patrón de endpoint operator: `auth()` → guard `operator|platform_admin` → `getActiveRestaurantId()` → validar body zod → operar.

Para la tx de `applyInitialCharge`: la tabla Prisma relevante es `BillingSubscription` (upsert) y `MembershipPayment` (create). El restaurante se actualiza con `plan`, `monthlyPriceCents`, `periodEndsAt`, `suspended=false`.

- [ ] **Step 2.1: Añadir audit kinds + labels en `src/lib/auditLog.ts`**

En `auditLog.ts`, en la unión de tipo `AuditKind` (busca el bloque `// Catch-all`), añadir antes del catch-all:

```typescript
  // Suscripción del operador (débito automático)
  | "subscription.activate"
  | "subscription.cancel"
  | "subscription.card.update"
```

En el objeto `AUDIT_KIND_LABEL`, añadir:

```typescript
  "subscription.activate": "Activó débito automático",
  "subscription.cancel": "Canceló débito automático",
  "subscription.card.update": "Actualizó tarjeta de débito",
```

- [ ] **Step 2.2: Añadir helpers en `src/lib/billing/subscription.ts`**

Añadir al final del archivo:

```typescript
import { db } from "@/lib/db";
import { getPlanByTier } from "@/lib/planCatalog";
import { recordAuditEvent } from "@/lib/auditLog";
import type { Plan } from "@prisma/client";

/**
 * Resuelve el precio mensual en centavos del plan dado, usando el
 * precio del PlanConfig en DB (con fallback a defaultPriceCents del catálogo).
 * Si el restaurante ya tiene monthlyPriceCents no-cero, lo usa directamente.
 */
export async function resolvePlanPrice(args: {
  restaurantMonthlyPriceCents: number;
  tier: Plan;
}): Promise<number> {
  if (args.restaurantMonthlyPriceCents > 0) return args.restaurantMonthlyPriceCents;
  const entry = await getPlanByTier(args.tier);
  return entry.defaultPriceCents;
}

export type ApplyInitialChargeArgs = {
  restaurantId: string;
  plan: Plan;
  amountCents: number;
  currency: "COP" | "MXN";
  subscriptionId: string;
  transactionId: string | null;
  card: {
    brand: string | null;
    last4: string | null;
    expMonth: number | null;
    expYear: number | null;
  };
  startDateIso: string; // ISO date YYYY-MM-DD — cuándo empieza a cobrar Kushki
  periodEndsAt: Date;   // cuando vence el período que acabamos de pagar
};

/**
 * Persiste el resultado de un cobro de activación (kind="initial"):
 *   1. Crea MembershipPayment(kind="initial", method="kushki_card")
 *   2. Actualiza Restaurant(plan, monthlyPriceCents, periodEndsAt, suspended=false)
 *   3. Upserta BillingSubscription(status=active, nextChargeAt=startDate, card meta)
 * Todo en una transacción.
 */
export async function applyInitialCharge(args: ApplyInitialChargeArgs): Promise<void> {
  await db.$transaction(async (tx) => {
    // 1. Registrar el pago
    await tx.membershipPayment.create({
      data: {
        restaurantId: args.restaurantId,
        amountCents: args.amountCents,
        method: "kushki_card",
        kind: "initial",
        providerRef: args.transactionId,
        periodStart: new Date(),
        periodEnd: args.periodEndsAt,
      },
    });

    // 2. Avanzar el plan del restaurante
    await tx.restaurant.update({
      where: { id: args.restaurantId },
      data: {
        plan: args.plan,
        monthlyPriceCents: args.amountCents,
        periodEndsAt: args.periodEndsAt,
        suspended: false,
      },
    });

    // 3. Upsert BillingSubscription
    await tx.billingSubscription.upsert({
      where: { restaurantId: args.restaurantId },
      create: {
        restaurantId: args.restaurantId,
        provider: "kushki",
        kushkiSubscriptionId: args.subscriptionId,
        plan: args.plan,
        amountCents: args.amountCents,
        currency: args.currency,
        status: "active",
        cardBrand: args.card.brand,
        cardLast4: args.card.last4,
        cardExpMonth: args.card.expMonth,
        cardExpYear: args.card.expYear,
        nextChargeAt: new Date(args.startDateIso),
      },
      update: {
        kushkiSubscriptionId: args.subscriptionId,
        plan: args.plan,
        amountCents: args.amountCents,
        currency: args.currency,
        status: "active",
        cardBrand: args.card.brand,
        cardLast4: args.card.last4,
        cardExpMonth: args.card.expMonth,
        cardExpYear: args.card.expYear,
        nextChargeAt: new Date(args.startDateIso),
        canceledAt: null,
      },
    });
  });
}

/**
 * Persiste activación sin cobro inmediato (startDate futuro = periodEndsAt).
 * Solo crea/actualiza BillingSubscription; no crea MembershipPayment ni
 * toca el Restaurant (el período ya está vigente).
 */
export async function applySubscriptionWithoutCharge(args: {
  restaurantId: string;
  plan: Plan;
  amountCents: number;
  currency: "COP" | "MXN";
  subscriptionId: string;
  card: ApplyInitialChargeArgs["card"];
  nextChargeAt: Date;
}): Promise<void> {
  await db.billingSubscription.upsert({
    where: { restaurantId: args.restaurantId },
    create: {
      restaurantId: args.restaurantId,
      provider: "kushki",
      kushkiSubscriptionId: args.subscriptionId,
      plan: args.plan,
      amountCents: args.amountCents,
      currency: args.currency,
      status: "active",
      cardBrand: args.card.brand,
      cardLast4: args.card.last4,
      cardExpMonth: args.card.expMonth,
      cardExpYear: args.card.expYear,
      nextChargeAt: args.nextChargeAt,
    },
    update: {
      kushkiSubscriptionId: args.subscriptionId,
      plan: args.plan,
      amountCents: args.amountCents,
      currency: args.currency,
      status: "active",
      cardBrand: args.card.brand,
      cardLast4: args.card.last4,
      cardExpMonth: args.card.expMonth,
      cardExpYear: args.card.expYear,
      nextChargeAt: args.nextChargeAt,
      canceledAt: null,
    },
  });
}
```

**NOTA:** Las importaciones de `db`, `getPlanByTier`, `recordAuditEvent` van al TOPE del archivo, no dentro de la función. Si el archivo actualmente no importa nada, añadirlas. Si ya importa algo del mismo módulo, consolidar.

- [ ] **Step 2.3: Crear `src/app/api/operator/subscription/activate/route.ts`**

Crear directorio y archivo:

```typescript
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { getSubscriptionProvider } from "@/lib/payments/subscription";
import { getRestaurantKushkiMode } from "@/lib/platformConfig";
import { currencyForCountry, addMonthsIso, applyInitialCharge, applySubscriptionWithoutCharge } from "@/lib/billing/subscription";
import { resolvePlanPrice } from "@/lib/billing/subscription";
import { recordAuditEvent } from "@/lib/auditLog";
import type { Plan } from "@prisma/client";

function guard(role?: string) {
  return role === "operator" || role === "platform_admin";
}

const body = z.object({
  token: z.string().min(1),
  planTier: z.enum(["trial", "basic", "pro"]),
});

export async function POST(req: Request) {
  const session = await auth();
  if (!guard(session?.user?.role)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return NextResponse.json({ error: "no_restaurant" }, { status: 400 });
  }

  const parsed = body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "validation", issues: parsed.error.issues }, { status: 422 });
  }
  const { token, planTier } = parsed.data;

  // Cargar el restaurante para saber estado actual y país
  const tenant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: {
      plan: true,
      monthlyPriceCents: true,
      periodEndsAt: true,
      country: true,
      kushkiMode: true,
    },
  });
  if (!tenant) {
    return NextResponse.json({ error: "no_restaurant" }, { status: 404 });
  }

  const currency = currencyForCountry(tenant.country);
  const amountCents = await resolvePlanPrice({
    restaurantMonthlyPriceCents: tenant.monthlyPriceCents,
    tier: planTier as Plan,
  });

  // Regla de fecha: si hay período vigente → sin cobro inmediato; si no → cobrar ahora
  const now = new Date();
  const periodEndsAt = tenant.periodEndsAt;
  const hasFuturePeriod = periodEndsAt != null && periodEndsAt > now;

  // startDate para Kushki: debe ser FUTURO (no el mismo día según regla Kushki)
  let startDateIso: string;
  let doImmediateCharge: boolean;

  if (hasFuturePeriod) {
    // El restaurante ya tiene período vigente → primera renovación = cuando vence
    startDateIso = periodEndsAt!.toISOString().slice(0, 10);
    doImmediateCharge = false;
  } else {
    // Sin período vigente → cobrar ahora + agendar desde hoy+1mes
    startDateIso = addMonthsIso(now, 1);
    doImmediateCharge = true;
  }

  const mode = await getRestaurantKushkiMode(tenant);
  const provider = await getSubscriptionProvider(mode);

  // Datos de contacto mínimos (Kushki los requiere)
  const contactDetails = {
    firstName: session!.user!.name?.split(" ")[0] ?? "Operador",
    lastName: session!.user!.name?.split(" ").slice(1).join(" ") ?? "MESAPAY",
    email: session!.user!.email ?? "billing@mesapay.co",
  };

  console.log("[billing] activate: creating subscription", {
    restaurantId,
    planTier,
    amountCents,
    currency,
    startDateIso,
    doImmediateCharge,
    mode,
  });

  // 1. Crear la suscripción en Kushki
  let createResult: Awaited<ReturnType<typeof provider.createCardSubscription>>;
  try {
    createResult = await provider.createCardSubscription({
      token,
      planName: planTier,
      amountCents,
      currency,
      startDateIso,
      contactDetails,
      metadata: { restaurantId, platform: "mesapay" },
    });
  } catch (err) {
    console.error("[billing] activate: createCardSubscription failed", err);
    return NextResponse.json({ error: "create_failed", detail: String(err) }, { status: 502 });
  }

  const { subscriptionId, card } = createResult;
  console.log("[billing] activate: subscription created", {
    subscriptionId,
    cardLast4: card.last4,
    cardBrand: card.brand,
  });

  // 2. Cobro inmediato si aplica
  if (doImmediateCharge) {
    let chargeResult: Awaited<ReturnType<typeof provider.chargeSubscriptionNow>>;
    try {
      chargeResult = await provider.chargeSubscriptionNow({
        subscriptionId,
        amountCents,
        currency,
        metadata: { restaurantId, kind: "initial" },
      });
    } catch (err) {
      // Intentar cancelar la suscripción para no dejar huérfana
      try {
        await provider.cancelSubscription({ subscriptionId });
      } catch (cancelErr) {
        console.error("[billing] activate: failed to cancel orphan subscription", cancelErr);
      }
      console.error("[billing] activate: chargeSubscriptionNow threw", err);
      return NextResponse.json({ error: "charge_failed", detail: String(err) }, { status: 502 });
    }

    console.log("[billing] activate: charge result", {
      status: chargeResult.status,
      transactionId: chargeResult.transactionId,
    });

    if (chargeResult.status === "declined") {
      // Cancelar la suscripción para no dejar huérfana
      try {
        await provider.cancelSubscription({ subscriptionId });
      } catch (cancelErr) {
        console.error("[billing] activate: failed to cancel after declined charge", cancelErr);
      }
      return NextResponse.json(
        { error: "charge_declined", message: chargeResult.message ?? "Tarjeta rechazada" },
        { status: 402 },
      );
    }

    // Cobro aprobado → persistir
    const newPeriodEndsAt = new Date(addMonthsIso(now, 1));
    await applyInitialCharge({
      restaurantId,
      plan: planTier as Plan,
      amountCents,
      currency,
      subscriptionId,
      transactionId: chargeResult.transactionId,
      card,
      startDateIso,
      periodEndsAt: newPeriodEndsAt,
    });
  } else {
    // Sin cobro inmediato → solo persistir la suscripción
    await applySubscriptionWithoutCharge({
      restaurantId,
      plan: planTier as Plan,
      amountCents,
      currency,
      subscriptionId,
      card,
      nextChargeAt: new Date(startDateIso),
    });
  }

  await recordAuditEvent({
    kind: "subscription.activate",
    restaurantId,
    target: { type: "billing_subscription", id: subscriptionId },
    summary: `Activó débito automático plan=${planTier} monto=${amountCents} currency=${currency} startDate=${startDateIso} immediateCharge=${doImmediateCharge}`,
  });

  return NextResponse.json({ ok: true, subscriptionId, cardLast4: card.last4 });
}
```

- [ ] **Step 2.4: Crear `src/app/api/operator/subscription/cancel/route.ts`**

```typescript
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { getSubscriptionProvider } from "@/lib/payments/subscription";
import { getRestaurantKushkiMode } from "@/lib/platformConfig";
import { recordAuditEvent } from "@/lib/auditLog";

function guard(role?: string) {
  return role === "operator" || role === "platform_admin";
}

export async function POST() {
  const session = await auth();
  if (!guard(session?.user?.role)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return NextResponse.json({ error: "no_restaurant" }, { status: 400 });
  }

  const sub = await db.billingSubscription.findUnique({
    where: { restaurantId },
    include: { restaurant: { select: { kushkiMode: true } } },
  });

  if (!sub || sub.status === "canceled") {
    return NextResponse.json({ error: "no_active_subscription" }, { status: 404 });
  }

  const mode = await getRestaurantKushkiMode(sub.restaurant);
  const provider = await getSubscriptionProvider(mode);

  if (sub.kushkiSubscriptionId) {
    try {
      await provider.cancelSubscription({ subscriptionId: sub.kushkiSubscriptionId });
    } catch (err) {
      console.error("[billing] cancel: cancelSubscription failed", err);
      // No bloqueamos — si Kushki falla (ej: ya cancelada), igual marcamos en DB
    }
  }

  await db.billingSubscription.update({
    where: { restaurantId },
    data: {
      status: "canceled",
      canceledAt: new Date(),
    },
  });

  await recordAuditEvent({
    kind: "subscription.cancel",
    restaurantId,
    target: { type: "billing_subscription", id: sub.kushkiSubscriptionId ?? sub.id },
    summary: `Canceló débito automático (subscriptionId=${sub.kushkiSubscriptionId})`,
  });

  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 2.5: Crear `src/app/api/operator/subscription/card/route.ts`**

```typescript
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { getSubscriptionProvider } from "@/lib/payments/subscription";
import { getRestaurantKushkiMode } from "@/lib/platformConfig";
import { recordAuditEvent } from "@/lib/auditLog";

function guard(role?: string) {
  return role === "operator" || role === "platform_admin";
}

const body = z.object({
  token: z.string().min(1),
});

export async function PATCH(req: Request) {
  const session = await auth();
  if (!guard(session?.user?.role)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return NextResponse.json({ error: "no_restaurant" }, { status: 400 });
  }

  const parsed = body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "validation", issues: parsed.error.issues }, { status: 422 });
  }
  const { token } = parsed.data;

  const sub = await db.billingSubscription.findUnique({
    where: { restaurantId },
    include: { restaurant: { select: { kushkiMode: true } } },
  });

  if (!sub || sub.status === "canceled" || !sub.kushkiSubscriptionId) {
    return NextResponse.json({ error: "no_active_subscription" }, { status: 404 });
  }

  const mode = await getRestaurantKushkiMode(sub.restaurant);
  const provider = await getSubscriptionProvider(mode);

  let result: Awaited<ReturnType<typeof provider.updateSubscriptionCard>>;
  try {
    result = await provider.updateSubscriptionCard({
      subscriptionId: sub.kushkiSubscriptionId,
      token,
    });
  } catch (err) {
    console.error("[billing] card update: updateSubscriptionCard failed", err);
    return NextResponse.json({ error: "update_failed", detail: String(err) }, { status: 502 });
  }

  const { card } = result;
  await db.billingSubscription.update({
    where: { restaurantId },
    data: {
      cardBrand: card.brand,
      cardLast4: card.last4,
      cardExpMonth: card.expMonth,
      cardExpYear: card.expYear,
    },
  });

  await recordAuditEvent({
    kind: "subscription.card.update",
    restaurantId,
    target: { type: "billing_subscription", id: sub.kushkiSubscriptionId },
    summary: `Actualizó tarjeta de débito last4=${card.last4} brand=${card.brand}`,
  });

  return NextResponse.json({ ok: true, card });
}
```

- [ ] **Step 2.6: Verificar TypeScript**

```bash
cd /Users/nicolas/Documents/APPS/MESAPAY
npx tsc --noEmit 2>&1 | grep -v "\.next/" | head -30
```

Resultado esperado: sin output.

- [ ] **Step 2.7: Commit Task 2**

```bash
cd /Users/nicolas/Documents/APPS/MESAPAY
git add \
  src/lib/billing/subscription.ts \
  src/lib/auditLog.ts \
  src/app/api/operator/subscription/activate/route.ts \
  src/app/api/operator/subscription/cancel/route.ts \
  src/app/api/operator/subscription/card/route.ts
git commit -m "$(cat <<'EOF'
feat(billing): helpers + 3 endpoints activate/cancel/card

- billing/subscription.ts: resolvePlanPrice, applyInitialCharge, applySubscriptionWithoutCharge
- auditLog.ts: subscription.activate, subscription.cancel, subscription.card.update
- POST /api/operator/subscription/activate: token+plan → create sub + one-click charge (with date rule) + persist
- POST /api/operator/subscription/cancel: cancel Kushki + mark DB canceled
- PATCH /api/operator/subscription/card: update card token + persist card meta

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: UI — CardForm + SubscriptionClient + page.tsx + i18n

**Files:**
- Modify: `src/app/operator/settings/suscripcion/page.tsx`
- Create: `src/app/operator/settings/suscripcion/CardForm.tsx`
- Modify: `src/app/operator/settings/suscripcion/SubscriptionClient.tsx`
- Modify: `messages/es.json`
- Modify: `messages/en.json`
- Modify: `messages/pt.json`

### Context antes de editar

`page.tsx` actualmente no pasa `kushkiPublicKey` ni `kushkiMode` al cliente. Hay que leer `env.KUSHKI_BILLING_PUBLIC_KEY` en el server component y pasarlo.

`SubscriptionClient.tsx` muestra el estado pero no tiene ningún botón de acción — solo read-only. La nueva versión necesita: botón "Activar débito automático" (cuando no hay suscripción activa o está cancelada), botón "Cambiar tarjeta" (cuando hay suscripción activa), botón "Cancelar débito" (con confirm, cuando hay suscripción activa), y un modal/inline con `CardForm`.

`CardForm.tsx` es un nuevo componente cliente que replica el patrón de tokenización de `PayClient.tsx` (`card/v1/tokens` con `Public-Merchant-Id`), pero para suscripciones. El endpoint exacto puede diferir para suscripciones — se prueba `subscriptions/v1/card/tokens` primero y si da 404, se cae a `card/v1/tokens` (con un flag).

- [ ] **Step 3.1: Añadir keys i18n en `messages/es.json`**

En el objeto `"opSubscription"` de `messages/es.json`, añadir las siguientes keys ANTES del cierre `}` del objeto (después de `"kindManual"`):

```json
    "activateBtn": "Activar débito automático",
    "changeCardBtn": "Cambiar tarjeta",
    "cancelDebitBtn": "Cancelar débito automático",
    "cancelConfirm": "¿Confirmas que quieres cancelar el débito automático? Tu plan sigue activo hasta la fecha de vencimiento.",
    "cardFormTitle": "Datos de la tarjeta",
    "cardNumber": "Número de tarjeta",
    "cardName": "Nombre en la tarjeta",
    "cardExpiry": "Vencimiento (MM/AA)",
    "cardCvv": "CVV",
    "cardSubmit": "Confirmar tarjeta",
    "cardCancel": "Cancelar",
    "errCardNumber": "Número de tarjeta inválido",
    "errCardName": "Ingresa el nombre que aparece en la tarjeta",
    "errExpiry": "Formato inválido. Usa MM/AA",
    "errExpiryMonth": "Mes inválido (01–12)",
    "errCvv": "CVV debe tener 3 o 4 dígitos",
    "errTokenize": "No se pudo tokenizar la tarjeta. Verifica los datos.",
    "errActivate": "Error al activar el débito automático",
    "errChangeCard": "Error al actualizar la tarjeta",
    "errCancel": "Error al cancelar el débito automático",
    "errDeclined": "Tarjeta rechazada. Verifica los datos o usa otra tarjeta.",
    "activating": "Activando…",
    "changing": "Actualizando…",
    "canceling": "Cancelando…",
    "activateSuccess": "Débito automático activado",
    "changeCardSuccess": "Tarjeta actualizada",
    "cancelSuccess": "Débito automático cancelado",
    "paymentMethodKicker": "Método de pago",
    "planSelectorKicker": "Elige tu plan",
    "noPlanSelected": "Selecciona un plan para continuar"
```

- [ ] **Step 3.2: Añadir keys i18n en `messages/en.json`**

Mismo lugar en `"opSubscription"`, añadir las traducciones en inglés:

```json
    "activateBtn": "Activate automatic debit",
    "changeCardBtn": "Change card",
    "cancelDebitBtn": "Cancel automatic debit",
    "cancelConfirm": "Confirm you want to cancel automatic debit? Your plan stays active until the expiration date.",
    "cardFormTitle": "Card details",
    "cardNumber": "Card number",
    "cardName": "Name on card",
    "cardExpiry": "Expiry (MM/YY)",
    "cardCvv": "CVV",
    "cardSubmit": "Confirm card",
    "cardCancel": "Cancel",
    "errCardNumber": "Invalid card number",
    "errCardName": "Enter the name shown on the card",
    "errExpiry": "Invalid format. Use MM/YY",
    "errExpiryMonth": "Invalid month (01–12)",
    "errCvv": "CVV must have 3 or 4 digits",
    "errTokenize": "Could not tokenize card. Check your details.",
    "errActivate": "Failed to activate automatic debit",
    "errChangeCard": "Failed to update card",
    "errCancel": "Failed to cancel automatic debit",
    "errDeclined": "Card declined. Check your details or use a different card.",
    "activating": "Activating…",
    "changing": "Updating…",
    "canceling": "Canceling…",
    "activateSuccess": "Automatic debit activated",
    "changeCardSuccess": "Card updated",
    "cancelSuccess": "Automatic debit canceled",
    "paymentMethodKicker": "Payment method",
    "planSelectorKicker": "Choose your plan",
    "noPlanSelected": "Select a plan to continue"
```

- [ ] **Step 3.3: Añadir keys i18n en `messages/pt.json`**

```json
    "activateBtn": "Ativar débito automático",
    "changeCardBtn": "Alterar cartão",
    "cancelDebitBtn": "Cancelar débito automático",
    "cancelConfirm": "Confirma que deseja cancelar o débito automático? Seu plano permanece ativo até a data de vencimento.",
    "cardFormTitle": "Dados do cartão",
    "cardNumber": "Número do cartão",
    "cardName": "Nome no cartão",
    "cardExpiry": "Validade (MM/AA)",
    "cardCvv": "CVV",
    "cardSubmit": "Confirmar cartão",
    "cardCancel": "Cancelar",
    "errCardNumber": "Número de cartão inválido",
    "errCardName": "Insira o nome que aparece no cartão",
    "errExpiry": "Formato inválido. Use MM/AA",
    "errExpiryMonth": "Mês inválido (01–12)",
    "errCvv": "CVV deve ter 3 ou 4 dígitos",
    "errTokenize": "Não foi possível tokenizar o cartão. Verifique os dados.",
    "errActivate": "Erro ao ativar o débito automático",
    "errChangeCard": "Erro ao atualizar o cartão",
    "errCancel": "Erro ao cancelar o débito automático",
    "errDeclined": "Cartão recusado. Verifique os dados ou use outro cartão.",
    "activating": "Ativando…",
    "changing": "Atualizando…",
    "canceling": "Cancelando…",
    "activateSuccess": "Débito automático ativado",
    "changeCardSuccess": "Cartão atualizado",
    "cancelSuccess": "Débito automático cancelado",
    "paymentMethodKicker": "Método de pagamento",
    "planSelectorKicker": "Escolha seu plano",
    "noPlanSelected": "Selecione um plano para continuar"
```

- [ ] **Step 3.4: Verificar paridad i18n**

```bash
cd /Users/nicolas/Documents/APPS/MESAPAY
node -e "
const es = require('./messages/es.json');
const en = require('./messages/en.json');
const pt = require('./messages/pt.json');
function keys(obj, prefix='') {
  return Object.entries(obj).flatMap(([k,v]) =>
    typeof v === 'object' ? keys(v, prefix+k+'.') : [prefix+k]
  );
}
const esK = keys(es).sort();
const enK = keys(en).sort();
const ptK = keys(pt).sort();
const missingEn = esK.filter(k=>!enK.includes(k));
const missingPt = esK.filter(k=>!ptK.includes(k));
if (missingEn.length) console.error('Missing in en:', missingEn);
if (missingPt.length) console.error('Missing in pt:', missingPt);
if (!missingEn.length && !missingPt.length) console.log('Parity OK: es='+esK.length+' en='+enK.length+' pt='+ptK.length);
"
```

Resultado esperado: `Parity OK: es=N en=N pt=N` con N igual en los tres.

- [ ] **Step 3.5: Actualizar `src/app/operator/settings/suscripcion/page.tsx`**

Añadir al imports:

```typescript
import { env } from "@/lib/env";
import { getRestaurantKushkiMode } from "@/lib/platformConfig";
```

Dentro del server component, después de cargar el `tenant`, añadir:

```typescript
  // Modo Kushki efectivo para este restaurante (respeta override por comercio)
  const kushkiMode = await getRestaurantKushkiMode(tenant);
  // Clave pública de plataforma (segura en browser) — null si no configurada
  const kushkiPublicKey = env.KUSHKI_BILLING_PUBLIC_KEY ?? null;
```

Y pasar ambos al `SubscriptionClient`:

```tsx
      <SubscriptionClient
        plan={tenant.plan}
        monthlyPriceCents={tenant.monthlyPriceCents}
        periodEndsAtIso={tenant.periodEndsAt?.toISOString() ?? null}
        statusKey={
          tenant.suspended
            ? "suspended"
            : tenant.billingSubscription?.status === "canceled"
              ? "canceled"
              : tenant.periodEndsAt && tenant.periodEndsAt < new Date()
                ? "overdue"
                : "active"
        }
        country={tenant.country}
        subscription={
          tenant.billingSubscription
            ? {
                status: tenant.billingSubscription.status,
                cardBrand: tenant.billingSubscription.cardBrand,
                cardLast4: tenant.billingSubscription.cardLast4,
                cardExpMonth: tenant.billingSubscription.cardExpMonth,
                cardExpYear: tenant.billingSubscription.cardExpYear,
                nextChargeAtIso:
                  tenant.billingSubscription.nextChargeAt?.toISOString() ??
                  null,
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
        kushkiPublicKey={kushkiPublicKey}
        kushkiMode={kushkiMode}
      />
```

- [ ] **Step 3.6: Crear `src/app/operator/settings/suscripcion/CardForm.tsx`**

```typescript
"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";

// KushkiMode importado como string-type desde platformConfig rompería el
// bundle del cliente (el módulo importa Prisma). Redefinimos localmente.
type KushkiMode = "mock" | "sandbox" | "production";

type Props = {
  kushkiPublicKey: string | null;
  kushkiMode: KushkiMode;
  busy?: boolean;
  onToken: (token: string) => void;
  onCancel: () => void;
};

export function CardForm({ kushkiPublicKey, kushkiMode, busy, onToken, onCancel }: Props) {
  const t = useTranslations("opSubscription");
  const [number, setNumber] = useState("");
  const [holderName, setHolderName] = useState("");
  const [expiry, setExpiry] = useState("");
  const [cvv, setCvv] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [tokenizing, setTokenizing] = useState(false);

  // Formateo del número de tarjeta: grupos de 4 con espacios
  function handleNumber(raw: string) {
    const digits = raw.replace(/\D/g, "").slice(0, 19);
    const grouped = digits.replace(/(.{4})/g, "$1 ").trimEnd();
    setNumber(grouped);
  }

  // Formateo MM/AA
  function handleExpiry(raw: string) {
    const digits = raw.replace(/\D/g, "").slice(0, 4);
    if (digits.length >= 3) {
      setExpiry(digits.slice(0, 2) + "/" + digits.slice(2));
    } else {
      setExpiry(digits);
    }
  }

  async function submit() {
    setErr(null);
    const digits = number.replace(/\s/g, "");
    if (digits.length < 13 || digits.length > 19) {
      setErr(t("errCardNumber"));
      return;
    }
    if (!holderName.trim() || holderName.trim().length < 3) {
      setErr(t("errCardName"));
      return;
    }
    const expiryMatch = /^(\d{2})\/(\d{2})$/.exec(expiry);
    if (!expiryMatch) {
      setErr(t("errExpiry"));
      return;
    }
    const expMonth = expiryMatch[1];
    const expYear = expiryMatch[2];
    if (Number(expMonth) < 1 || Number(expMonth) > 12) {
      setErr(t("errExpiryMonth"));
      return;
    }
    if (!cvv.match(/^\d{3,4}$/)) {
      setErr(t("errCvv"));
      return;
    }

    // Mock path: no llamada a Kushki — el mock provider acepta cualquier token.
    if (kushkiMode === "mock" || !kushkiPublicKey) {
      onToken(`mock-sub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
      return;
    }

    setTokenizing(true);
    try {
      const baseUrl =
        kushkiMode === "production"
          ? "https://api.kushkipagos.com"
          : "https://api-uat.kushkipagos.com";

      const body = {
        card: {
          number: digits,
          name: holderName.trim(),
          expiryMonth: expMonth,
          expiryYear: expYear,
          cvv,
        },
      };

      console.log("[billing] CardForm: tokenize shape", {
        cardLast4: digits.slice(-4),
        expiryMonth: expMonth,
        expiryYear: expYear,
        endpoint: "subscriptions/v1/card/tokens",
      });

      // VERIFY vs sandbox: el endpoint de token para suscripciones puede ser
      // /subscriptions/v1/card/tokens o el mismo /card/v1/tokens que usan pagos.
      // Intentamos el de suscripciones primero; si da 404, cae al de pagos.
      let res = await fetch(`${baseUrl}/subscriptions/v1/card/tokens`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Public-Merchant-Id": kushkiPublicKey,
        },
        body: JSON.stringify(body),
      });

      // Si 404 → intentar el endpoint genérico de tarjetas
      if (res.status === 404) {
        console.log("[billing] CardForm: subscriptions/v1/card/tokens gave 404, falling back to card/v1/tokens");
        // VERIFY vs sandbox: fallback al endpoint de tokenización de tarjetas normal
        res = await fetch(`${baseUrl}/card/v1/tokens`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Public-Merchant-Id": kushkiPublicKey,
          },
          body: JSON.stringify({ ...body, totalAmount: 0, currency: "COP", isDeferred: false }),
        });
      }

      const json = await res.json().catch(() => ({})) as { token?: string; code?: string; message?: string };
      console.log("[billing] CardForm: token response", {
        status: res.status,
        hasToken: !!json.token,
        code: json.code,
      });

      if (!res.ok || json.code || !json.token) {
        setErr(json.message ?? t("errTokenize"));
        return;
      }

      onToken(json.token);
    } catch (e) {
      console.error("[billing] CardForm: tokenize error", e);
      setErr(t("errTokenize"));
    } finally {
      setTokenizing(false);
    }
  }

  const isBusy = busy || tokenizing;

  return (
    <div className="space-y-4">
      <div className="font-medium text-sm text-op-text">{t("cardFormTitle")}</div>

      <div className="space-y-3">
        <div>
          <label className="block text-xs text-op-muted mb-1">{t("cardNumber")}</label>
          <input
            type="text"
            inputMode="numeric"
            value={number}
            onChange={(e) => handleNumber(e.target.value)}
            placeholder="1234 5678 9012 3456"
            maxLength={23}
            disabled={isBusy}
            className="w-full border border-op-border rounded-lg px-3 py-2 text-sm font-mono bg-op-surface text-op-text placeholder:text-op-muted/50 focus:outline-none focus:ring-2 focus:ring-brand/40 disabled:opacity-50"
          />
        </div>

        <div>
          <label className="block text-xs text-op-muted mb-1">{t("cardName")}</label>
          <input
            type="text"
            value={holderName}
            onChange={(e) => setHolderName(e.target.value)}
            placeholder="JUAN PEREZ"
            maxLength={80}
            disabled={isBusy}
            className="w-full border border-op-border rounded-lg px-3 py-2 text-sm uppercase bg-op-surface text-op-text placeholder:text-op-muted/50 focus:outline-none focus:ring-2 focus:ring-brand/40 disabled:opacity-50"
          />
        </div>

        <div className="flex gap-3">
          <div className="flex-1">
            <label className="block text-xs text-op-muted mb-1">{t("cardExpiry")}</label>
            <input
              type="text"
              inputMode="numeric"
              value={expiry}
              onChange={(e) => handleExpiry(e.target.value)}
              placeholder="MM/AA"
              maxLength={5}
              disabled={isBusy}
              className="w-full border border-op-border rounded-lg px-3 py-2 text-sm font-mono bg-op-surface text-op-text placeholder:text-op-muted/50 focus:outline-none focus:ring-2 focus:ring-brand/40 disabled:opacity-50"
            />
          </div>
          <div className="w-28">
            <label className="block text-xs text-op-muted mb-1">{t("cardCvv")}</label>
            <input
              type="text"
              inputMode="numeric"
              value={cvv}
              onChange={(e) => setCvv(e.target.value.replace(/\D/g, "").slice(0, 4))}
              placeholder="123"
              maxLength={4}
              disabled={isBusy}
              className="w-full border border-op-border rounded-lg px-3 py-2 text-sm font-mono bg-op-surface text-op-text placeholder:text-op-muted/50 focus:outline-none focus:ring-2 focus:ring-brand/40 disabled:opacity-50"
            />
          </div>
        </div>
      </div>

      {err && (
        <div className="text-sm text-danger bg-danger/10 rounded-lg px-3 py-2">{err}</div>
      )}

      <div className="flex gap-2 pt-1">
        <button
          type="button"
          onClick={submit}
          disabled={isBusy}
          className="flex-1 bg-brand text-white rounded-lg px-4 py-2.5 text-sm font-medium hover:bg-brand/90 disabled:opacity-50 transition-colors"
        >
          {isBusy ? "…" : t("cardSubmit")}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={isBusy}
          className="px-4 py-2.5 text-sm font-medium text-op-muted hover:text-op-text rounded-lg border border-op-border hover:bg-op-surface transition-colors disabled:opacity-50"
        >
          {t("cardCancel")}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3.7: Reemplazar `src/app/operator/settings/suscripcion/SubscriptionClient.tsx`**

El archivo actual solo muestra datos. Necesitamos añadirle las acciones. Reemplazar el contenido completo:

```typescript
"use client";

import { useState } from "react";
import { useTranslations, useLocale } from "next-intl";
import { useRouter } from "next/navigation";
import { formatMoney, formatDate } from "@/lib/format";
import { currencyForCountry } from "@/lib/billing/subscription";
import { CardForm } from "./CardForm";
import type { Locale } from "@/i18n/config";
import type { MembershipMethod } from "@prisma/client";

// KushkiMode redefinido localmente para no importar el módulo server platformConfig
type KushkiMode = "mock" | "sandbox" | "production";

type SubscriptionInfo = {
  status: string;
  cardBrand: string | null;
  cardLast4: string | null;
  cardExpMonth: number | null;
  cardExpYear: number | null;
  nextChargeAtIso: string | null;
};

type PaymentRow = {
  id: string;
  createdAtIso: string;
  periodStartIso: string;
  periodEndIso: string;
  amountCents: number;
  method: MembershipMethod;
  kind: string;
};

type Props = {
  plan: string;
  monthlyPriceCents: number;
  periodEndsAtIso: string | null;
  statusKey: "suspended" | "canceled" | "overdue" | "active";
  country: string | null;
  subscription: SubscriptionInfo | null;
  payments: PaymentRow[];
  kushkiPublicKey: string | null;
  kushkiMode: KushkiMode;
};

type Mode = "idle" | "activating" | "changing_card";

function statusI18nKey(
  key: Props["statusKey"],
): "statusSuspended" | "statusCanceled" | "statusOverdue" | "statusActive" {
  switch (key) {
    case "suspended":
      return "statusSuspended";
    case "canceled":
      return "statusCanceled";
    case "overdue":
      return "statusOverdue";
    default:
      return "statusActive";
  }
}

function statusTint(key: string): string {
  switch (key) {
    case "statusActive":
      return "bg-ok/15 text-ok";
    case "statusOverdue":
      return "bg-[#C98A2E]/20 text-[#8F6828]";
    case "statusSuspended":
    case "statusCanceled":
      return "bg-danger/15 text-danger";
    default:
      return "bg-paper text-op-muted";
  }
}

function methodKey(method: MembershipMethod): string {
  switch (method) {
    case "kushki_card":
      return "methodKushkiCard";
    case "manual_cash":
      return "methodManualCash";
    case "manual_transfer":
      return "methodManualTransfer";
    case "wompi":
      return "methodWompi";
    default:
      return "methodManualCash";
  }
}

function kindKey(kind: string): string {
  switch (kind) {
    case "initial":
      return "kindInitial";
    case "recurring":
      return "kindRecurring";
    case "proration":
      return "kindProration";
    default:
      return "kindManual";
  }
}

export function SubscriptionClient({
  plan,
  monthlyPriceCents,
  periodEndsAtIso,
  statusKey,
  country,
  subscription,
  payments,
  kushkiPublicKey,
  kushkiMode,
}: Props) {
  const t = useTranslations("opSubscription");
  const locale = useLocale() as Locale;
  const router = useRouter();
  const currency = currencyForCountry(country);

  const [mode, setMode] = useState<Mode>("idle");
  const [busy, setBusy] = useState(false);
  const [actionErr, setActionErr] = useState<string | null>(null);
  // Para activar: el operador elige el planTier antes de abrir el form
  const [selectedPlan, setSelectedPlan] = useState<string>(plan);

  const i18nKey = statusI18nKey(statusKey);
  const hasActiveSubscription =
    subscription != null && subscription.status === "active";

  function fmtMoney(cents: number) {
    return formatMoney(cents, { currency, locale });
  }

  function fmtDate(iso: string) {
    return formatDate(iso, { locale, dateStyle: "medium" });
  }

  // Tokenización exitosa → POST al endpoint correspondiente
  async function handleToken(token: string) {
    setActionErr(null);
    setBusy(true);
    try {
      if (mode === "activating") {
        const res = await fetch("/api/operator/subscription/activate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token, planTier: selectedPlan }),
        });
        const json = await res.json().catch(() => ({})) as { error?: string; message?: string };
        if (!res.ok) {
          if (json.error === "charge_declined") {
            setActionErr(t("errDeclined"));
          } else {
            setActionErr(json.message ?? t("errActivate"));
          }
          return;
        }
        setMode("idle");
        router.refresh();
      } else if (mode === "changing_card") {
        const res = await fetch("/api/operator/subscription/card", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });
        const json = await res.json().catch(() => ({})) as { error?: string; message?: string };
        if (!res.ok) {
          setActionErr(json.message ?? t("errChangeCard"));
          return;
        }
        setMode("idle");
        router.refresh();
      }
    } catch (e) {
      console.error("[billing] action failed", e);
      setActionErr(mode === "activating" ? t("errActivate") : t("errChangeCard"));
    } finally {
      setBusy(false);
    }
  }

  async function handleCancel() {
    if (!window.confirm(t("cancelConfirm"))) return;
    setActionErr(null);
    setBusy(true);
    try {
      const res = await fetch("/api/operator/subscription/cancel", { method: "POST" });
      const json = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) {
        setActionErr(json.error ?? t("errCancel"));
        return;
      }
      router.refresh();
    } catch {
      setActionErr(t("errCancel"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Plan activo */}
      <section className="bg-op-surface border border-op-border rounded-2xl p-5">
        <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-3">
          {t("planKicker")}
        </div>
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <div className="font-display text-2xl capitalize">{plan}</div>
            <div className="text-sm text-op-muted mt-0.5">
              {t("planPrice", { amount: fmtMoney(monthlyPriceCents) })}
            </div>
          </div>
          <span
            className={
              "px-3 h-6 inline-flex items-center rounded-full text-[11px] font-medium " +
              statusTint(i18nKey)
            }
          >
            {t(i18nKey)}
          </span>
        </div>
        {subscription?.nextChargeAtIso && (
          <div className="mt-3 text-sm text-op-muted">
            {t("nextChargeLabel")}
            {": "}
            <span className="text-op-text">
              {fmtDate(subscription.nextChargeAtIso)}
            </span>
          </div>
        )}
        {!subscription?.nextChargeAtIso && periodEndsAtIso && (
          <div className="mt-3 text-sm text-op-muted">
            {t("renewsLabel")}
            {": "}
            <span className="text-op-text">{fmtDate(periodEndsAtIso)}</span>
          </div>
        )}
      </section>

      {/* Método de pago */}
      <section className="bg-op-surface border border-op-border rounded-2xl p-5">
        <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-3">
          {t("paymentMethodKicker")}
        </div>

        {actionErr && (
          <div className="mb-3 text-sm text-danger bg-danger/10 rounded-lg px-3 py-2">
            {actionErr}
          </div>
        )}

        {/* Formulario de tarjeta (activar o cambiar) */}
        {(mode === "activating" || mode === "changing_card") && (
          <div className="mb-4">
            <CardForm
              kushkiPublicKey={kushkiPublicKey}
              kushkiMode={kushkiMode}
              busy={busy}
              onToken={handleToken}
              onCancel={() => { setMode("idle"); setActionErr(null); }}
            />
          </div>
        )}

        {mode === "idle" && (
          <>
            {hasActiveSubscription && subscription?.cardLast4 ? (
              <div className="text-sm text-op-text mb-4">
                {subscription.cardBrand
                  ? subscription.cardBrand.charAt(0).toUpperCase() +
                    subscription.cardBrand.slice(1)
                  : ""}
                {" •••• "}
                {subscription.cardLast4}
                {subscription.cardExpMonth != null && subscription.cardExpYear != null ? (
                  <span className="text-op-muted ml-2">
                    {"· "}
                    {String(subscription.cardExpMonth).padStart(2, "0")}
                    {"/"}
                    {String(subscription.cardExpYear).slice(-2)}
                  </span>
                ) : null}
              </div>
            ) : (
              <div className="text-sm text-op-muted mb-4">{t("noAutoDebit")}</div>
            )}

            {/* Botones de acción */}
            {hasActiveSubscription ? (
              <div className="flex gap-2 flex-wrap">
                <button
                  type="button"
                  onClick={() => { setActionErr(null); setMode("changing_card"); }}
                  disabled={busy}
                  className="text-sm font-medium px-4 py-2 rounded-lg border border-op-border hover:bg-op-surface/80 text-op-text disabled:opacity-50 transition-colors"
                >
                  {t("changeCardBtn")}
                </button>
                <button
                  type="button"
                  onClick={handleCancel}
                  disabled={busy}
                  className="text-sm font-medium px-4 py-2 rounded-lg border border-danger/30 text-danger hover:bg-danger/5 disabled:opacity-50 transition-colors"
                >
                  {busy ? t("canceling") : t("cancelDebitBtn")}
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => { setActionErr(null); setMode("activating"); }}
                disabled={busy}
                className="text-sm font-medium px-4 py-2.5 rounded-lg bg-brand text-white hover:bg-brand/90 disabled:opacity-50 transition-colors"
              >
                {t("activateBtn")}
              </button>
            )}
          </>
        )}
      </section>

      {/* Historial de pagos */}
      <section className="bg-op-surface border border-op-border rounded-2xl p-5">
        <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-3">
          {t("historyKicker")}
        </div>
        {payments.length === 0 ? (
          <div className="text-sm text-op-muted">{t("historyEmpty")}</div>
        ) : (
          <div className="overflow-x-auto -mx-1">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-op-muted text-[11px] border-b border-op-border">
                  <th className="pb-2 pr-4 font-medium">{t("colDate")}</th>
                  <th className="pb-2 pr-4 font-medium">{t("colPeriod")}</th>
                  <th className="pb-2 pr-4 font-medium text-right">
                    {t("colAmount")}
                  </th>
                  <th className="pb-2 pr-4 font-medium">{t("colMethod")}</th>
                </tr>
              </thead>
              <tbody>
                {payments.map((p) => (
                  <tr
                    key={p.id}
                    className="border-b border-op-border/60 last:border-0"
                  >
                    <td className="py-2 pr-4 text-op-text whitespace-nowrap">
                      {fmtDate(p.createdAtIso)}
                    </td>
                    <td className="py-2 pr-4 text-op-muted whitespace-nowrap text-xs">
                      {fmtDate(p.periodStartIso)}
                      {" – "}
                      {fmtDate(p.periodEndIso)}
                    </td>
                    <td className="py-2 pr-4 text-op-text text-right tabular-nums whitespace-nowrap">
                      {fmtMoney(p.amountCents)}
                    </td>
                    <td className="py-2 pr-4 text-op-muted">
                      <div>{t(methodKey(p.method))}</div>
                      <div className="text-[10px] text-op-muted/70">
                        {t(kindKey(p.kind))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
```

- [ ] **Step 3.8: Verificar TypeScript**

```bash
cd /Users/nicolas/Documents/APPS/MESAPAY
npx tsc --noEmit 2>&1 | grep -v "\.next/" | head -30
```

Resultado esperado: sin output.

- [ ] **Step 3.9: Verificar ESLint en los archivos cambiados**

```bash
cd /Users/nicolas/Documents/APPS/MESAPAY
npx eslint \
  src/lib/env.ts \
  src/lib/payments/kushki/client.ts \
  src/lib/payments/kushki/subscriptionLive.ts \
  src/lib/payments/subscription.ts \
  src/lib/billing/subscription.ts \
  src/lib/auditLog.ts \
  src/app/api/operator/subscription/activate/route.ts \
  src/app/api/operator/subscription/cancel/route.ts \
  src/app/api/operator/subscription/card/route.ts \
  src/app/operator/settings/suscripcion/page.tsx \
  src/app/operator/settings/suscripcion/CardForm.tsx \
  src/app/operator/settings/suscripcion/SubscriptionClient.tsx \
  2>&1 | head -50
```

Resultado esperado: exit 0, sin errores de `i18next/no-literal-string`.

- [ ] **Step 3.10: Build de producción**

```bash
cd /Users/nicolas/Documents/APPS/MESAPAY
npm run build 2>&1 | tail -20
```

Resultado esperado: `Compiled successfully` o `✓ Compiled` sin errores de TypeScript/ESLint.

- [ ] **Step 3.11: Commit Task 3**

```bash
cd /Users/nicolas/Documents/APPS/MESAPAY
git add \
  src/app/operator/settings/suscripcion/page.tsx \
  src/app/operator/settings/suscripcion/CardForm.tsx \
  src/app/operator/settings/suscripcion/SubscriptionClient.tsx \
  messages/es.json \
  messages/en.json \
  messages/pt.json
git commit -m "$(cat <<'EOF'
feat(billing/ui): CardForm + activate/change-card/cancel UI + i18n

- page.tsx: pasa kushkiPublicKey + kushkiMode al cliente
- CardForm.tsx: inputs tarjeta, tokenización browser→Kushki (subscriptions/v1/card/tokens con fallback a card/v1/tokens), mock bypass
- SubscriptionClient.tsx: botones activar/cambiar-tarjeta/cancelar, estados busy/error, router.refresh() tras acción
- es/en/pt.json: keys opSubscription para form, botones, errores (paridad 3 idiomas)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Verificación final

- [ ] **tsc --noEmit limpio:**
  ```bash
  npx tsc --noEmit 2>&1 | grep -v "\.next/" | head -20
  ```
  Esperado: sin output.

- [ ] **ESLint limpio en todos los archivos modificados:**
  ```bash
  npx eslint src/lib/payments/kushki/client.ts src/lib/payments/kushki/subscriptionLive.ts src/lib/payments/subscription.ts src/lib/billing/subscription.ts src/lib/auditLog.ts src/lib/env.ts src/app/api/operator/subscription/activate/route.ts src/app/api/operator/subscription/cancel/route.ts src/app/api/operator/subscription/card/route.ts src/app/operator/settings/suscripcion/page.tsx src/app/operator/settings/suscripcion/CardForm.tsx src/app/operator/settings/suscripcion/SubscriptionClient.tsx
  ```
  Esperado: exit 0.

- [ ] **Paridad i18n:**
  ```bash
  node -e "const es=require('./messages/es.json'),en=require('./messages/en.json'),pt=require('./messages/pt.json');function keys(o,p=''){return Object.entries(o).flatMap(([k,v])=>typeof v==='object'?keys(v,p+k+'.'):[[p+k]]).flat()}const eK=keys(es).sort(),nK=keys(en).sort(),pK=keys(pt).sort();const mE=eK.filter(k=>!nK.includes(k)),mP=eK.filter(k=>!pK.includes(k));if(mE.length)console.error('en missing:',mE);if(mP.length)console.error('pt missing:',mP);if(!mE.length&&!mP.length)console.log('Parity OK es='+eK.length+' en='+nK.length+' pt='+pK.length);"
  ```
  Esperado: `Parity OK es=N en=N pt=N`.

- [ ] **Build:**
  ```bash
  npm run build 2>&1 | tail -20
  ```
  Esperado: `Compiled successfully`.

---

## Flags para verificar contra Kushki sandbox

Estos puntos necesitan confirmación con una llamada real a la sandbox. Están marcados como `// VERIFY vs sandbox` en el código:

1. **`subscriptionLive.ts` línea createCardSubscription:** El body de `POST /subscriptions/v1/card` puede requerir campos adicionales (ej: `periodType`, `metadata` shape distinto). Comparar con doc Kushki al activar.

2. **`subscriptionLive.ts` línea chargeSubscriptionNow:** El path del cobro on-demand puede ser `/subscriptions/v1/card/{id}/charge` en vez de `/subscriptions/v1/card/{id}` (POST). El campo de aprobación puede ser `approvalCode`, `ticketNumber`, o `status="APPROVED"`.

3. **`subscriptionLive.ts` línea updateSubscriptionCard:** Se usa `PUT`; puede ser `PATCH`. El body puede requerir más que solo `{ token }`.

4. **`subscriptionLive.ts` línea cardFrom:** Los nombres de campo en la respuesta de tarjeta pueden ser `brand`, `cardBrand`, `bin`, `lastFourDigits`, `maskedCardNumber`, `expiryMonth`, `expirationMonth`. La función `cardFrom` es tolerante pero necesita verificarse.

5. **`CardForm.tsx` Step 3.6:** El endpoint de token para suscripciones puede ser `/subscriptions/v1/card/tokens` o el mismo `/card/v1/tokens`. El fallback a 404 ya está implementado pero el body puede diferir (la versión de suscripción quizás no requiere `totalAmount`/`isDeferred`/`email`).

---

## Notas de adaptación vs spec original

- **`resolvePlanPrice`:** la spec dice "precio del `PlanConfig`/`monthlyPriceCents`". Implementado: si el restaurante ya tiene `monthlyPriceCents > 0`, lo usa directamente (respeta precios negociados); si es 0, cae al catálogo. Esto evita sobreescribir precios negociados manualmente.

- **`applySubscriptionWithoutCharge`:** función separada para el caso sin cobro inmediato (período vigente). El restaurante no se modifica (ya está en el plan correcto); solo se crea/actualiza el `BillingSubscription`. Si el plan elegido difiere del plan actual del restaurante, NO se cambia el plan — eso es Fase 5 (change-plan). Para Fase 3, el `planTier` del body se persiste en `BillingSubscription.plan` pero no en `Restaurant.plan` cuando no hay cobro inmediato.

- **`KushkiMode` en componentes cliente:** `platformConfig.ts` importa Prisma y no puede entrar al bundle del cliente. Tanto `CardForm.tsx` como `SubscriptionClient.tsx` definen `type KushkiMode = "mock" | "sandbox" | "production"` localmente (ya incluido en el código del plan). No importar `KushkiMode` de `@/lib/platformConfig` en archivos `"use client"`.

- **`updateSubscriptionCard` usa `PUT`:** el spec dice `PATCH /subscriptions/v1/card/{id}`. El código usa `PUT` como guess más conservador — Kushki a veces usa PUT para reemplazar un recurso completo. El flag `// VERIFY vs sandbox` está en el código; cambiar a `PATCH` si eso es lo que exige sandbox.
