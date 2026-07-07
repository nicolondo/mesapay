# ERP Fase C1 · Horarios, asistencia y costo laboral

> Spec para aprobación antes de codear. Roadmap: `docs/roadmap-erp-modulos.md`.
> Módulo nuevo: `staff` (slug ya en el catálogo con `shipped: false`).
> Cierra la promesa de B2: costo laboral → **prime cost** en el P&L.

## Objetivo

Que el comercio planee la **semana de su equipo** (quién trabaja qué día
y a qué hora), registre la **asistencia real** (entró/salió) y vea el
**costo laboral** por turno, semana y mes — con la línea de nómina
entrando sola al P&L de contabilidad (prime cost = CMV + laboral).

## Decisiones de diseño

### D1. Catálogo de empleados propio (no los usuarios del app)

`Employee` por comercio: nombre, **cargo libre con datalist** (criterio
categorías de insumos/gastos — "Mesero", "Cocinero", "Lavaplatos"…),
**tarifa por hora en centavos** (nullable — sin tarifa el turno cuesta 0
y se marca "sin tarifa", nunca se inventa), activo, y `userId` opcional
hacia una cuenta del app (el lavaplatos no tiene cuenta; el mesero sí —
el link habilita self check-in a futuro, hoy es informativo).

No se reusa `User` como empleado: la mayoría del personal operativo no
tiene cuenta y los roles del app (mesero/kitchen/bar) son de ACCESO, no
de nómina. Tarifa mensual: se ingresa el equivalente por hora (hint en
la UI); cálculo de nómina legal (prestaciones, horas extra, recargos
nocturnos/dominicales) queda FUERA — esto es costo operativo gerencial,
no liquidación.

### D2. Turnos planeados: `StaffShift` (distinto del `Shift` de caja)

Un turno = empleado + fecha + rango horario en **minutos desde
medianoche**: `startMinutes` 0-1439, `endMinutes` > start y ≤ start+960
(máx. 16 h — cubre nocturnos que cruzan medianoche: 18:00→02:00 es
1080→1560; el turno pertenece al DÍA en que empieza). Duración mínima
15 min. Nota opcional. Se valida **solape por empleado** en el mismo día
(409 `shift_overlap`) — dos turnos el mismo día sí (partido).

### D3. Asistencia sobre el turno planeado

Check-in/out viven EN el turno (`checkInAt`/`checkOutAt`): el board del
día marca "Entró"/"Salió" con timestamps del server; el operador puede
**ajustar los tiempos reales a mano** (llegó 7:12 y nadie marcó) y
limpiar un punch errado. Turnos no planeados: se crea el turno del día y
se puncha — sin flujo aparte. Self check-in del empleado: fuera de C1
(el link `userId` deja la puerta abierta).

### D4. Costo del turno: real si está punchado, planeado si no

- `costCents(turno)` = `round(minutos × tarifa / 60)`:
  - **real** con `checkInAt`+`checkOutAt` (minutos reales),
  - **planeado** en cualquier otro caso (turnos futuros, o pasados sin
    punch — mejor estimar que reportar $0 de nómina; el desglose marca
    cuánto es real vs. estimado).
- Semana: total + por día + por empleado. Sin tarifa ⇒ cuesta 0 con flag
  `missingRate` (badge).

### D5. Prime cost en el P&L (B2)

`PnlInputs` gana `laborCents` (+ desglose real/estimado): Σ costo D4 de
los turnos con `date` en el mes. El P&L muestra la línea **"− Costo
laboral"** después del margen bruto (antes de gastos, con nota de
real/estimado) y el caption **prime cost** = (CMV + mermas + laboral) /
ingresos %. Solo si el módulo `staff` está activo; apagado, el P&L queda
como hoy. Los gastos de categoría "Nómina" que el comercio ya registre a
mano en B2 NO se descuentan automáticamente — hint en la UI de que al
activar Horarios conviene no duplicar la nómina como gasto.

### D6. Superficie: `/operator/horarios` (módulo `staff`)

Página propia (patrón contabilidad/producción): gate + nav "Horarios".
Tres tabs:

1. **Semana** — selector de semana (◀ "1 – 7 jul" ▶, lunes a domingo),
   grid mobile-first agrupado por día: turnos con empleado, rango
   horario, costo y badges (punchado ✓ / sin tarifa). Crear/editar/
   borrar turno (sheet: empleado, día, desde/hasta con inputs time,
   nota). Totales de la semana (horas + costo, real vs. estimado) y por
   día. Botón **"Copiar semana anterior"** (crea los turnos que no
   choquen; reporta cuántos copió/saltó).
2. **Hoy** — board de asistencia: los turnos de hoy con botones grandes
   Entró / Salió, hora real al lado, y editar tiempos/limpiar punch en
   el sheet del turno. Turno extra → botón crear (mismo sheet con fecha
   fija hoy).
3. **Equipo** — CRUD de empleados: nombre, cargo (datalist), tarifa por
   hora (en pesos, hint de equivalente mensual ≈ tarifa × 230 h), activo
   (soft-delete como insumos), link opcional a usuario del app (select
   de usuarios del comercio). Inactivos no aparecen en el planner pero
   sus turnos históricos quedan.

### D7. Modelo de datos (Prisma)

```prisma
model Employee {
  id           String     @id @default(cuid())
  restaurantId String
  restaurant   Restaurant @relation(fields: [restaurantId], references: [id], onDelete: Cascade)
  name         String
  position     String // cargo libre con datalist
  hourlyRateCents Int? // null = sin tarifa (turnos cuestan 0 + flag)
  active       Boolean  @default(true)
  userId       String?  @unique // cuenta del app (opcional, informativo)
  user         User?    @relation(fields: [userId], references: [id], onDelete: SetNull)
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  shifts StaffShift[]

  @@unique([restaurantId, name])
  @@index([restaurantId, active])
}

model StaffShift {
  id           String     @id @default(cuid())
  restaurantId String
  restaurant   Restaurant @relation(fields: [restaurantId], references: [id], onDelete: Cascade)
  employeeId   String
  employee     Employee   @relation(fields: [employeeId], references: [id], onDelete: Cascade)

  // Día al que pertenece el turno (fecha UTC truncada a medianoche).
  date         DateTime
  // Rango en minutos desde medianoche del `date`. end > start, ≤ start+960
  // (16 h máx.) — nocturnos cruzan medianoche (18:00→02:00 = 1080→1560).
  startMinutes Int
  endMinutes   Int
  note         String?

  // Asistencia (D3) — timestamps reales; ajustables a mano.
  checkInAt  DateTime?
  checkOutAt DateTime?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([restaurantId, date])
  @@index([employeeId, date])
}
```

### D8. API (gate `staff` vía getErpContext)

```
GET/POST      /api/operator/employees            · PATCH/DELETE /[id] (delete = active:false)
GET           /api/operator/staff-shifts?week=YYYY-MM-DD   → lunes de la semana; turnos + totales
POST          /api/operator/staff-shifts                   → crear (409 shift_overlap)
PATCH/DELETE  /api/operator/staff-shifts/[id]              → editar rango/nota/tiempos reales
                (acciones: check_in / check_out / clear_punch / edit)
POST          /api/operator/staff-shifts/copy-week         → { fromWeek, toWeek } → {copied, skipped}
GET           /api/operator/accounting/pnl (existente)     → + laborCents/laborActualCents/
                laborEstimatedCents y primeCostPct cuando staff activo
```

Validaciones: empleado del comercio y activo (crear), rangos D2, fechas
2020-2100, semana = lunes, máx. 200 turnos por copia.

## Lógica central: `src/lib/erp/staff.ts` (pura, testeable)

- `shiftCost({startMinutes, endMinutes, checkInAt, checkOutAt, hourlyRateCents})`
  → `{costCents, minutes, source: "actual"|"planned", missingRate}` (D4).
- `hasOverlap(existing, candidate)` — solape por empleado/día.
- `weekRange(mondayIso)` / `isMonday` — límites UTC de la semana.
- `copyWeekPlan(fromShifts, toWeekMonday, existingToShifts)` (pura) →
  turnos a crear (misma posición relativa lunes→domingo, salta solapes).
- Sanity con tsx contra los criterios de aceptación.

## i18n

Extensión de `opErp` (prefijos `staff*`, `shift*`) + `navStaff` en
`operator`. Labels del P&L nuevos en `opErp`. Glob a MIGRATED. Paridad.

## Fuera de alcance (explícito)

Liquidación legal de nómina (prestaciones, extras, recargos), self
check-in del empleado, geofencing/kiosko con PIN, intercambio de turnos,
disponibilidad/vacaciones, export de nómina, multi-sede (cada sede
planea su equipo).

## Entrega (4 PRs)

1. Schema Employee/StaffShift + `staff.ts` + sanity tsx.
2. API completa + extensión del P&L (laborCents + prime cost).
3. UI `/operator/horarios` (3 tabs) + nav + línea laboral en el P&L de contabilidad — subagente.
4. Flip `staff.shipped = true` + verificación integral.

## Criterios de aceptación

1. Turno planeado 18:00→02:00 con tarifa $10.000/h ⇒ 8 h = $80.000
   planeado; punchado 18:07→01:45 ⇒ cobra las 7 h 38 min reales
   ($76.333 con redondeo entero). Sin tarifa ⇒ $0 + badge.
2. Solape del mismo empleado en el día ⇒ 409 `shift_overlap`; turno
   partido (2 rangos sin cruce) ⇒ OK.
3. "Copiar semana anterior" replica los turnos a la misma posición
   relativa y salta los que chocan, reportando copiados/saltados.
4. P&L del mes con módulo staff activo muestra "− Costo laboral" (real
   vs. estimado) y prime cost %; apagado, el P&L no cambia.
5. Módulo apagado ⇒ sin nav, página 404, API 403. Trilingüe en paridad.
