# Comisiones recurrentes para comerciales (diseño)

**Fecha:** 2026-06-10 · **Estado:** aprobado (concepto validado por Nicolás en chat)
**Objetivo:** que un comercial que trae un restaurante cobre su % de cada mensualidad de ese
restaurante **automáticamente**, mientras siga activo — sin Excel.

## Concepto

- Nuevo rol **`comercial`** (vendedor independiente o interno).
- Cada `Restaurant` puede tener un **comercial asignado** (`salesRepUserId`) — lo asigna el
  platform_admin desde el detalle del restaurante.
- **% de comisión** con cascada de resolución:
  `Restaurant.salesRepCommissionBps` (override por comercio) → `User.commissionBps`
  (default del comercial) → `PlatformConfig.salesCommissionBps` (default global, 1000 bps = 10%).
  Se usa **basis points** (Int) para evitar flotantes.
- **Automatización (núcleo):** cuando el admin registra un pago de membresía
  (`record_payment` en `/api/admin/membership/[id]`), si el restaurante tiene comercial
  asignado se crea un **`CommissionEntry`** en la misma transacción:
  `amountCents = round(amountCents * bps / 10000)`, estado `pending`.
  Idempotente: `membershipPaymentId @unique`.
- **Portal `/comercial`** (rol comercial): sus restaurantes (plan, mensualidad, estado,
  % aplicado), su libro de comisiones por mes y totales (pendiente / pagado). Solo lectura.
- **Admin:** card "Comercial asignado" en `/admin/restaurants/[id]` + página
  `/admin/comisiones` con el libro global, filtros y acción **marcar pagadas** (con auditoría).
  Las comisiones se pagan por fuera (transferencia); MESAPAY lleva el registro.
- `reversed` existe como estado para clawback manual (churn temprano), v1 sin automatismo.

## Schema (Prisma)

```prisma
enum Role { ... comercial }  // nuevo valor

enum CommissionStatus { pending paid reversed }

model PlatformConfig {
  ...
  salesCommissionBps Int @default(1000) // 10% default global
}

model User {
  ...
  commissionBps        Int?
  referredRestaurants  Restaurant[]      @relation("RestaurantSalesRep")
  commissionEntries    CommissionEntry[]
}

model Restaurant {
  ...
  salesRepUserId        String?
  salesRep              User?   @relation("RestaurantSalesRep", fields: [salesRepUserId], references: [id], onDelete: SetNull)
  salesRepCommissionBps Int?
  commissionEntries     CommissionEntry[]
  @@index([salesRepUserId])
}

model CommissionEntry {
  id                  String            @id @default(cuid())
  salesRepUserId      String
  salesRep            User              @relation(fields: [salesRepUserId], references: [id], onDelete: Cascade)
  restaurantId        String
  restaurant          Restaurant        @relation(fields: [restaurantId], references: [id], onDelete: Cascade)
  membershipPaymentId String            @unique
  membershipPayment   MembershipPayment @relation(fields: [membershipPaymentId], references: [id], onDelete: Cascade)
  baseAmountCents     Int
  bps                 Int
  amountCents         Int
  status              CommissionStatus  @default(pending)
  createdAt           DateTime          @default(now())
  paidAt              DateTime?
  paidNote            String?
  @@index([salesRepUserId, createdAt])
  @@index([restaurantId])
  @@index([status])
}
// MembershipPayment gana: commissionEntry CommissionEntry?
```

## Componentes

| Unidad | Qué hace |
|---|---|
| `src/lib/commissions.ts` | puro: `resolveCommissionBps`, `commissionAmountCents`, `summarizeCommissions` (tests vitest) |
| hook en `/api/admin/membership/[id]` | crea CommissionEntry en la transacción de `record_payment` + audit |
| `POST /api/admin/restaurants/[id]/salesrep` | asignar/quitar comercial + override bps (platform_admin, audit) |
| `GET/POST /api/admin/commissions` | libro global + acciones `mark_paid` / `reverse` (platform_admin, audit) |
| `/comercial` (layout+page) | portal del comercial (server components, lectura directa db, scope: SOLO sus entries) |
| `/admin/comisiones` | libro global + marcar pagadas |
| card en `/admin/restaurants/[id]` | asignación de comercial + % |
| login redirect | role `comercial` → `/comercial` (mismo patrón que mesero/kitchen) |
| alta de usuarios | rol `comercial` disponible al crear usuarios desde admin |

## Seguridad
- Portal: gate server-side `role === "comercial"` (platform_admin también puede entrar para soporte).
  El comercial SOLO ve entries con su `salesRepUserId` (where en server component — nunca input del cliente).
- Asignación/pagos/reversa: solo `platform_admin`. Todo con `recordAuditEvent`.

## i18n
Trilingüe obligatorio: namespaces `comercialPortal` y `opAdminCommissions` en es/en/pt con paridad;
archivos nuevos al MIGRATED del eslint.

## Fuera de alcance v1 (YAGNI)
Auto-clawback por churn, pagos automáticos de comisiones (payout), multi-nivel (gerente sobre equipo),
self-signup de comerciales, vista de leads (eso vive en Kommo).
