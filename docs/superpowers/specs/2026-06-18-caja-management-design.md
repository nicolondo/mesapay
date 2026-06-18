# Manejo de caja: egresos, base de meseros y arqueo consolidado en tiempo real

**Estado:** aprobado (diseño) — 2026-06-18
**Objetivo:** que el comercio mantenga la caja "bien ajustada" — ver el efectivo en caja en tiempo real, registrar egresos con concepto, y (en modo `by_waiter`) ver la base que cada mesero tomó del local y cuánto debe devolver, con un consolidado en vivo. Aclarar la sección de Cierre, hoy confusa.

## Decisiones (confirmadas con el usuario)

- **Modelo de datos:** reusar `Shift` (la base del mesero ya vive en `Shift.openingCashCents`) y agregar **solo** un modelo `CashMovement` para egresos/ingresos con concepto. El saldo de la caja general se **calcula en vivo** con una fórmula (no se persiste un saldo).
- **Quién opera:** **ambos** — operator (cajero) y platform_admin pueden registrar egresos y operar la caja. El admin además tiene visualización en tiempo real (read-first).
- **Base del mesero (`by_waiter`):** el mesero la declara al abrir su turno (flujo actual #156); ese monto se trata como **salida de la caja general** hacia la caja personal. Al cerrar, devuelve base + lo recaudado.
- **Refresco:** **instantáneo vía SSE** (bus `subscribeTenant` existente), no polling.

## Modelo de datos

### Nuevo: `CashMovement`
```
model CashMovement {
  id              String           @id @default(cuid())
  restaurantId    String
  restaurant      Restaurant       @relation(fields: [restaurantId], references: [id], onDelete: Cascade)
  // Turno global vigente al registrar (para acotar el movimiento al
  // arqueo de ese cierre). Null si no había turno global abierto.
  shiftId         String?
  shift           Shift?           @relation(fields: [shiftId], references: [id], onDelete: SetNull)
  kind            CashMovementKind // egreso | ingreso
  amountCents     Int              // siempre > 0; el signo lo da el kind
  concept         String           // motivo del retiro/ingreso
  createdByUserId String
  createdBy       User             @relation(fields: [createdByUserId], references: [id])
  occurredAt      DateTime         @default(now())

  @@index([restaurantId, occurredAt])
  @@index([shiftId])
}

enum CashMovementKind { egreso ingreso }
```
- **egreso**: sale efectivo del cajón del local (retiro con concepto: proveedor, retiro de dueño, etc.).
- **ingreso**: entra efectivo (ajuste/depósito) — para cuadrar.

No se requiere otro modelo: las bases de meseros se derivan de `Shift.openingCashCents`.

### Reuso
- `Shift` global (`userId = null`): turno de la caja general del local. `openingCashCents` = base inicial.
- `Shift` personal (`userId = mesero`): base + arqueo del mesero (ya existe, #156).
- `Payment` (`demo_cash`, `collectedByUserId`): efectivo cobrado; distingue cobro en caja general vs por un mesero.

## Lógica de saldos (helper puro, sin estado persistido)

`src/lib/cashBox.ts` — funciones puras que reciben los datos ya consultados.

**Caja general (efectivo esperado en el cajón del local)** durante el turno global abierto:
```
cajaGeneral = globalShift.openingCashCents
            + efectivoCobradoEnGeneral   // demo_cash approved, collectedByUserId ∈ {operator/admin} o sin mesero, settledAt ≥ openedAt
            − Σ egresos + Σ ingresos      // CashMovement del período/turno
            − Σ basesDeMeserosAbiertos    // Σ openingCashCents de Shifts personales status=open   (solo by_waiter)
            + Σ devolucionesDeCerrados     // por cada Shift personal cerrado en el período: base + efectivo que cobró  (solo by_waiter)
```

**Caja de un mesero (turno abierto)** = `openingCashCents` + efectivo que cobró (demo_cash, collectedByUserId = él, en su ventana). **Debe devolver al cerrar** = base + efectivo cobrado.

**Consolidado** = cajaGeneral + Σ cajas de meseros abiertos = efectivo total físico del local.

En modo `global`: no hay meseros; `cajaGeneral` omite las dos últimas líneas y el consolidado = cajaGeneral.

## Superficies

### Operator › Cierre (`/operator/reports`) — rediseño
- Sección **"Caja"** arriba: saldo en vivo de la caja general con su desglose (base · +cobrado · −egresos +ingresos · −bases entregadas · = en caja). Botón **"Registrar egreso"** (monto + concepto; opción ingreso). Lista de egresos/ingresos del turno.
- En `by_waiter`, debajo: tarjetas de **cajas de meseros** abiertos (base / cobrado / debe devolver) + **consolidado**.
- El **cierre general** (arqueo) muestra ese desglose: caja general esperada vs declarada, y por mesero cuánto debe devolver.
- Objetivo UX: que el bloque de arqueo deje de ser confuso — separar claramente "Caja del local" de "Cajas de meseros" y mostrar el consolidado.

### Admin › detalle del comercio (`/admin/restaurants/[id]`) — nueva tarjeta
- **Caja en tiempo real.** `global`: solo caja general. `by_waiter`: caja general + un panel **por cada mesero con turno abierto** (base/cobrado/en mano/debe devolver) + **consolidado**.
- Permite **registrar egreso** desde admin (ambos operan).

### API
- `POST /api/operator/cash/movement` — registra egreso/ingreso en el restaurante activo (rol operator/admin). zod `{ kind, amountCents>0, concept }`. Liga al turno global abierto si existe. Audit log (`cash.movement`). Publica `cash.updated` al bus SSE.
- `POST /api/admin/restaurants/[id]/cash/movement` — variante admin (platform_admin), misma lógica vía helper compartido.
- `GET /api/operator/cash/snapshot` y `GET /api/admin/restaurants/[id]/cash/snapshot` — devuelven el snapshot calculado (caja general + meseros + consolidado) para render inicial y refetch on-event.

### Tiempo real (SSE)
- Reusar el bus `subscribeTenant(restaurantId)` de `src/lib/events.ts`.
- Nuevo tipo de evento `cash.updated` publicado en: registrar egreso/ingreso, abrir/cerrar turno (mesero o global). Los cobros ya emiten `order.paid`/`order.updated`.
- Cliente (admin card + operator "Caja"): se suscribe al canal del comercio; ante `cash.updated` | `order.paid` | `order.updated` re-fetchea el snapshot. (Bus in-memory single-instance — suficiente para MVP, mismo que el resto de la app.)

## Fases (cada una deployable)

- **Fase 1 — Caja general + egresos** (sirve a `global` y `by_waiter`): modelo `CashMovement` + enum, helper `cashBox` (saldo general, contemplando bases), API movement + snapshot (operator + admin), sección "Caja" en operator/Cierre, tarjeta de caja en admin, evento `cash.updated` + SSE wiring.
- **Fase 2 — `by_waiter` consolidado**: paneles por mesero en tiempo real (admin) + consolidado, arqueo de meseros en el cierre general del operador, y el desglose "debe devolver" por mesero.

## Riesgos / notas

- **Doble conteo:** la fórmula resta bases de meseros abiertos de la caja general y las suma de vuelta al cerrar — verificar con tests del helper que `consolidado` = efectivo total sin duplicar.
- **Ventana temporal:** los movimientos y cobros se acotan por `settledAt/occurredAt ≥ openedAt` del turno global; si no hay turno global abierto, el snapshot lo indica (caja "sin abrir").
- **i18n:** superficies operator/reports y admin/restaurants están migradas → claves en es/en/pt + globs en `MIGRATED`.
- **SSE single-instance:** si el VPS escala a múltiples procesos Node habría que migrar a Postgres LISTEN/NOTIFY (ya anotado en `src/lib/events.ts`). No bloqueante.
- **Borrado de datos admin (#157):** `CashMovement` debe sumarse al reset selectivo (categoría "cobros" o nueva), para no dejar huérfanos. A confirmar en implementación.
