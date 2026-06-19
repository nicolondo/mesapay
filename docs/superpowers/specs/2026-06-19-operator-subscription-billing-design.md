# Suscripción del operador con débito automático (Kushki) — Diseño

**Fecha:** 2026-06-19
**Estado:** aprobado para escribir plan de implementación

## Contexto

Hoy la facturación de la mensualidad de MESAPAY a sus restaurantes es **100% manual**: el admin registra cada `MembershipPayment` (efectivo / transferencia / wompi) desde el panel de admin. El `Restaurant` ya tiene `plan` (`trial`/`basic`/`pro`), `monthlyPriceCents`, `periodEndsAt` y `suspended`, y existe un cron de recordatorios + auto-suspend al vencer. La integración Kushki actual es para que **los comensales** paguen en el restaurante (sub-merchant por comercio), **no** para que MESAPAY le cobre al restaurante.

Queremos una **página de suscripción para el operador** donde pueda: ver el plan activo, ver el historial de pagos, administrar la tarjeta guardada para **débito automático**, y **cambiar de plan** él mismo — con cobro recurrente real.

## Decisiones (confirmadas con el usuario)

1. **Construir el débito automático real** (no solo lectura/solicitudes).
2. **Procesador:** Kushki, modalidad **One-click & scheduled payments**, con la **cuenta de plataforma de MESAPAY** (no la sub-merchant del restaurante). Se construye sobre la abstracción de pagos existente, **mock-first** (igual que el resto de Kushki), y se pasa a producción con un env var.
3. **Primer cobro instantáneo (one-click)**; los cobros agendados (scheduled) arrancan el **mes siguiente** (regla Kushki: el agendado no puede ser el mismo día).
4. **Cambio de plan: inmediato con prorrateo.** Upgrade cobra ahora la diferencia prorrateada y cambia features al instante; downgrade aplica features al instante, sin reembolso, y el monto recurrente baja desde el próximo ciclo.

## Referencia Kushki (One-click & scheduled payments)

Docs: https://docs.kushki.com/co/en/recurring-payments/scheduled-payments/

- **Tokenización (frontend):** SDK JS `kushki.requestSubscriptionToken()` con la **clave pública** de plataforma. Devuelve `token` + metadata de tarjeta (marca, últimos 4, vencimiento). La tarjeta nunca toca el servidor de MESAPAY.
- **Crear suscripción:** `POST /subscriptions/v1/card` con header `Private-Merchant-Id`. Body: `token`, `planName`, `periodicity` (`monthly`), `startDate` (`YYYY-MM-DD`, futuro, **no mismo día**), `amount` (`{ currency, subtotalIva0, subtotalIva, iva, ice }`), `contactDetails` (`{ firstName, lastName, email, ... }`), `metadata`. Respuesta: `subscriptionId`.
- **Cobro one-click / on-demand** (primer cobro y prorrateos): cargo inmediato usando el `subscriptionId` (endpoint de charge de subscriptions).
- **Cambiar tarjeta:** `PATCH /subscriptions/v1/card/{subscriptionId}` con nuevo `token`.
- **Cancelar:** `DELETE /subscriptions/v1/card/{subscriptionId}` (inmediato).
- **Consultar:** `GET /subscriptions/v1/card/search/{subscriptionId}` (sin datos sensibles de tarjeta).
- **Webhooks:** sección "Recurring Payments Webhooks" notifica resultados de los cobros agendados (éxito/fallo). El payload exacto se confirma al integrar producción; el handler valida firma e idempotencia igual que el webhook Kushki actual.

> Los paths exactos se confirman contra la doc/partner al cablear producción. Toda la lógica vive detrás de la abstracción `SubscriptionProvider`, con `mock` funcional desde el día uno.

## Arquitectura

### Credenciales (env, en el VPS, nunca en repo)
- `KUSHKI_BILLING_PUBLIC_KEY` — clave pública de plataforma para tokenizar (frontend).
- `KUSHKI_BILLING_PRIVATE_KEY` — clave privada de plataforma para crear/cobrar/cancelar (backend).
- El modo (`mock` | `sandbox` | `production`) se resuelve con `PlatformConfig.kushkiMode` / `KUSHKI_MODE` (mismo helper existente). En `mock` no se requieren las claves.

### Provider abstraction
Nueva interface `SubscriptionProvider` en `src/lib/payments/` (paralela a la de pagos de comensales), implementada en `live.ts` (Kushki real) y `mock.ts` (simulado, persiste estado en memoria/DB local con delays). Métodos:
- `createCardSubscription({ token, planName, amountCents, currency, contactDetails, startDateIso, metadata }) → { subscriptionId, card: { brand, last4, expMonth, expYear } }`
- `chargeSubscriptionNow({ subscriptionId, amountCents, currency, metadata }) → { status: "approved" | "declined", transactionId, message? }`
- `updateSubscriptionCard({ subscriptionId, token }) → { card: { brand, last4, expMonth, expYear } }`
- `cancelSubscription({ subscriptionId }) → { ok: boolean }`
- `getSubscription({ subscriptionId }) → { status, card }` (para reconciliación)

`mock` simula: creación devuelve un `subscriptionId` ficticio; cobros aprueban (con un caso declinado determinístico para probar dunning, ej. monto terminado en `13` → declined); update/cancel ok.

### Helper de billing
`src/lib/billing/subscription.ts` — lógica de negocio pura/orquestación (no I/O de Kushki directo, usa el provider): resolver precio+moneda por plan/país, calcular prorrateo, aplicar resultado de un cobro (crear `MembershipPayment`, avanzar `periodEndsAt`, set `plan`, `suspended`), transicionar estado de la suscripción.

## Modelo de datos (Prisma)

### Nuevo `BillingSubscription` (1 por restaurante)
```
model BillingSubscription {
  id                   String   @id @default(cuid())
  restaurantId         String   @unique
  restaurant           Restaurant @relation(fields: [restaurantId], references: [id], onDelete: Cascade)
  provider             String   @default("kushki")
  kushkiSubscriptionId String?            // null mientras se crea / en mock
  plan                 Plan
  amountCents          Int
  currency             String             // "COP" | "MXN"
  status               String   @default("active") // "active" | "past_due" | "canceled"
  // Metadata de la tarjeta — SOLO display. NUNCA el PAN.
  cardBrand            String?
  cardLast4            String?
  cardExpMonth         Int?
  cardExpYear          Int?
  startedAt            DateTime @default(now())
  currentPeriodEnd     DateTime?          // espejo de Restaurant.periodEndsAt para el motor recurrente
  nextChargeAt         DateTime?          // cuándo Kushki cobrará el próximo agendado
  failedAttempts       Int      @default(0)
  canceledAt           DateTime?
  createdAt            DateTime @default(now())
  updatedAt            DateTime @updatedAt

  @@index([status, nextChargeAt])
}
```
`Restaurant` gana la relación `billingSubscription BillingSubscription?`.

`Restaurant.plan` / `monthlyPriceCents` / `periodEndsAt` / `suspended` siguen siendo la **fuente de verdad del plan** (los usan gating, recordatorios y auto-suspend). `BillingSubscription` agrega el vínculo Kushki + estado de cobro.

### `MembershipMethod` enum += `kushki_card`
### `MembershipPayment` += campos
```
providerRef String?   // id de transacción Kushki
kind        String @default("manual") // "initial" | "recurring" | "proration" | "manual"
```
El historial de pagos (operator + admin) sale de `MembershipPayment` — sin duplicar modelos. El `BillingPanel` del admin sigue funcionando.

## Flujos

### A. Activar débito automático (elige plan + tarjeta)
1. Operator → "Activar débito automático" → elige plan (tier visible de `PlanConfig`) → formulario de tarjeta (SDK Kushki, clave pública) → `token`.
2. `POST /api/operator/subscription/activate { token, planTier }`:
   - Resuelve `amountCents` (del `PlanConfig`/`monthlyPriceCents`) y `currency` (por país del restaurante; default `COP`).
   - **Regla de primer cobro / fecha de inicio:**
     - Si `periodEndsAt` es null o ya pasó (sin período pago vigente): `startDate = hoy + 1 mes`; **cobro one-click inmediato** del primer mes.
     - Si `periodEndsAt` está en el futuro (trial vigente o ya pagó): **sin cobro inmediato**; `startDate = periodEndsAt` (próxima renovación). No se cobra dos veces.
   - `createCardSubscription(...)` → guarda `BillingSubscription` (status `active`, metadata de tarjeta, `nextChargeAt = startDate`).
   - Si hubo cobro inmediato y fue **approved**: crea `MembershipPayment(kind="initial")`, set `plan`, `monthlyPriceCents`, `periodEndsAt = hoy + 1 mes`, `suspended = false`.
   - Si el cobro inmediato fue **declined**: `cancelSubscription` (evita huérfana) y devuelve error claro (no activa).
   - Audit: `subscription.activate`.

### B. Cobro mensual recurrente (Kushki agenda)
- Kushki cobra solo en `nextChargeAt`. El resultado llega por **webhook** `POST /api/webhooks/kushki/billing` (firma + idempotencia por id de evento):
  - **approved:** `MembershipPayment(kind="recurring")`, `periodEndsAt += 1 mes`, `nextChargeAt += 1 mes`, `failedAttempts = 0`, `status = active`, `suspended = false`.
  - **declined:** `failedAttempts++`, `status = past_due`. El cron de recordatorios/auto-suspend **existente** maneja el vencimiento (recordatorio → suspensión). No reintentamos manualmente en v1 (Kushki reintenta según su config; lo afinamos en producción).
- **Cron de reconciliación** diario `GET /api/cron/billing-sync` (protegido por `x-cron-secret`): para suscripciones con `nextChargeAt` pasado y sin `MembershipPayment` del período, consulta `getSubscription`/charges y sincroniza (cubre webhooks perdidos).

### C. Cambiar tarjeta
- `PATCH /api/operator/subscription/card { token }` → `updateSubscriptionCard` → actualiza metadata de tarjeta. Audit `subscription.card.update`.

### D. Cambiar plan (inmediato + prorrateo)
- `POST /api/operator/subscription/change-plan { planTier }`:
  - `oldMonthly`, `newMonthly` (de `PlanConfig`). `daysLeft` = días entre hoy y `periodEndsAt`; `daysInPeriod` = días del ciclo (≈30, calculado de `currentPeriodEnd − período anterior`, fallback 30).
  - **Upgrade** (`newMonthly > oldMonthly`): `proratedDiff = round((newMonthly − oldMonthly) × daysLeft / daysInPeriod)`. Cobro one-click de `proratedDiff` ahora; si approved → `MembershipPayment(kind="proration")`, cambia features (`plan`, `monthlyPriceCents`) **al instante**, `periodEndsAt` sin cambios. Recrea la suscripción Kushki al nuevo monto con `startDate = periodEndsAt` (cancel + create). Si el cobro del prorrateo es declined → no cambia, error claro.
  - **Downgrade** (`newMonthly < oldMonthly`): cambia features al instante, **sin cobro ni reembolso**; `periodEndsAt` sin cambios; recrea la suscripción Kushki al nuevo monto con `startDate = periodEndsAt` (cobra menos desde el próximo ciclo).
  - Audit `subscription.change_plan` (diff old→new + prorrateo).

### E. Cancelar débito automático
- `POST /api/operator/subscription/cancel` → `cancelSubscription` (Kushki `DELETE`) → `status = canceled`, `canceledAt`. El plan sigue activo hasta `periodEndsAt`; después entra a vencido por el flujo existente (sin más cobros). Audit `subscription.cancel`.

## Página del operador

Ruta `/operator/settings/suscripcion` + `SettingCard` en el landing de Configuración. Secciones:
- **Plan activo:** nombre del plan, precio mensual, estado (activo / vencido / suspendido / cancelado), próximo cobro (`nextChargeAt`) o vencimiento (`periodEndsAt`).
- **Método de pago:** si hay suscripción activa → tarjeta `marca •••• 1234 · vence MM/AA` + "Cambiar tarjeta" + "Cancelar débito automático". Si no hay → "Activar débito automático".
- **Cambiar plan:** tiers visibles de `PlanConfig` (nombre, precio, features). Al elegir un upgrade muestra el prorrateo a cobrar antes de confirmar.
- **Historial de pagos:** tabla de `MembershipPayment` del restaurante (fecha, período, monto, método, tipo/ref), más reciente primero.
- **Trilingüe (es/en/pt)** vía `next-intl` con `npm run i18n:sync`/paridad; dinero con `@/lib/format`. Glob agregado a `MIGRATED` en eslint.

Solo rol `operator` / `platform_admin`, scoped al restaurante activo (`getActiveRestaurantId`).

## Fases entregables (cada una = un PR)

1. **Schema + provider + mock + env.** `BillingSubscription`, `MembershipMethod.kushki_card`, `MembershipPayment` campos, `SubscriptionProvider` interface + `mock` + esqueleto `live`, helper `src/lib/billing/subscription.ts`, env de billing. Sin UI.
2. **Página solo-lectura.** `/operator/settings/suscripcion` con plan activo + historial (datos ya existen) + `SettingCard` + i18n. Entrega valor sin tocar Kushki.
3. **Bóveda de tarjeta + activar.** SDK Kushki en la página, endpoint `activate` (crear suscripción + primer cobro one-click condicional), `card` (cambiar tarjeta), `cancel` (cancelar). Metadata de tarjeta en la UI.
4. **Motor recurrente.** Webhook `/api/webhooks/kushki/billing` + cron `/api/cron/billing-sync` + dunning (`past_due`/`failedAttempts`) enganchado al auto-suspend existente.
5. **Cambio de plan self-service.** Endpoint `change-plan` (cancel+recreate + prorrateo one-click) + selector en la UI con preview de prorrateo.

## Seguridad / PCI / bordes

- **PCI SAQ-A:** nunca se recibe/almacena el PAN; solo el `token` de Kushki y metadata de display (marca/últimos 4/vencimiento). El form usa el SDK de Kushki.
- **Auth:** endpoints `operator`/`platform_admin`, scoped al restaurante activo.
- **Idempotencia:** webhook deduplica por id de evento (patrón del webhook Kushki actual). El cron de reconciliación no duplica `MembershipPayment` (chequea período).
- **Suscripción huérfana:** si el primer cobro one-click es declinado, se cancela la suscripción recién creada.
- **Moneda:** `COP` (Colombia) / `MXN` (México) según el país del restaurante; el `amount` Kushki por defecto pone el total en `subtotalIva0` (IVA 0) — el desglose de IVA se refina si se conecta facturación de la mensualidad.
- **Audit log:** `subscription.activate` / `subscription.change_plan` / `subscription.card.update` / `subscription.cancel`.

## Supuestos a confirmar en revisión
- El restaurante tiene un campo de país utilizable para derivar la moneda (de la feature de location). Si no, default `COP` y se hace configurable.
- En v1 no reintentamos cobros declinados desde MESAPAY (dejamos que Kushki reintente y caemos al flujo de vencido/suspensión existente).
- Downgrade no genera reembolso (cambia features al instante, baja el recurrente el próximo ciclo).
