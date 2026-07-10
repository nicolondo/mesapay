# ERP Staff · Corrección del modelo de pago: salario mensual (no tarifa por hora)

> Spec para aprobación antes de codear. Corrige un error de dominio del
> módulo `staff` (C1/C2, ya en producción). Decisiones del dueño
> (2026-07-09): el personal se paga con **salario básico mensual**; el
> valor de la hora se **deriva** (salario / **240**) solo para recargos y
> horas extra. Divisor 240 editable por comercio.

## Problema (por qué esto está mal hoy)

C1 modeló al empleado con `Employee.hourlyRateCents` (tarifa por hora) y
el costo de un turno como `minutos × tarifa / 60`. Para un restaurante en
Colombia eso es **incorrecto**: al personal asalariado se le paga un
**salario básico mensual fijo** — cueste 176 u 208 horas ese mes — y de
ese salario se **deriva** el valor de la hora ordinaria únicamente para
liquidar recargos (dominical/festivo) y horas extra. Con el modelo actual
el costo laboral del mes "fluctúa" con las horas punchadas, que no es lo
que el comercio paga.

## Modelo correcto (Colombia; MX análogo)

- **Input primario**: salario básico mensual (`monthlySalaryCents`).
- **Valor hora ordinaria** = `salario mensual / divisor`, divisor **240**
  por defecto (jornada tradicional 30×8), **editable por comercio** (el
  contador puede usar otro). MX usa el mismo 240 (sueldo mensual / 30 /
  8) — el default sirve a ambos países.
- **Costo laboral del mes (P&L)** =
  `Σ salarios mensuales de empleados activos`  (base fija, **una vez** al
  mes, independiente de los turnos)
  `+ Σ recargos festivo/dominical de los turnos` (horas trabajadas ×
  valor-hora × %, con los % ya configurables de C2 — festivo manda sobre
  domingo).
- Los turnos/punches siguen sirviendo para **asistencia** (faltas) y como
  base de las **horas** sobre las que se calcula el recargo; ya **no** son
  la base del costo.

## Decisiones de diseño

### D1. Un solo modelo: salario mensual (no discriminador por-horas)

El dueño eligió "solo salario mensual", así que **no** hay `payType`. Todo
empleado tiene `monthlySalaryCents Int?`. `null` = sin salario: aporta 0 a
la base y se marca "sin salario" (nunca se inventa — misma semántica que
el `missingRate` actual).

### D2. Schema — aditivo y sin pérdida de datos (push-based)

El repo sincroniza con `prisma db push` en el deploy (no hay migraciones
SQL). Para no perder datos ni tocar la DB prod local:

```prisma
model Employee {
  // ...
  // Salario básico mensual en centavos. null = sin salario (turnos no
  // aportan costo, se marca "sin salario"). Valor hora ordinaria = este
  // salario / Restaurant.staffHoursDivisor.
  monthlySalaryCents Int?
  // DEPRECADO (C1). Sin uso desde el modelo de salario mensual; se deja
  // un release para no perder datos en `db push`. Backfill opcional abajo.
  hourlyRateCents    Int?
  // ...
}

model Restaurant {
  // ...
  // Divisor mensual para derivar el valor de la hora ordinaria a partir
  // del salario (Colombia tradicional 240 = 30×8). Editable en
  // /operator/settings/staff-policies.
  staffHoursDivisor  Int @default(240)
}
```

`db push` **agrega** `monthlySalaryCents` y `staffHoursDivisor` y **deja
intacta** `hourlyRateCents` (no-op) — cero pérdida. Una PR de limpieza
posterior podrá dropear la columna muerta cuando se confirme que no hay
dato que preservar.

**Backfill opcional** (solo si el comercio ya cargó tarifas por hora antes
de este cambio). El dueño lo corre una vez en la VPS tras el primer deploy:

```sql
UPDATE "Employee"
SET "monthlySalaryCents" = "hourlyRateCents" * 240
WHERE "monthlySalaryCents" IS NULL AND "hourlyRateCents" IS NOT NULL;
```

En etapa de prueba (sin datos reales) no hace falta — se ingresan los
salarios en la UI.

### D3. `staff.ts` — el costo del turno pasa a ser SOLO recargo

`shiftCost(...)` deja de sumar `minutos × tarifa`. Se reemplaza por:

- `derivedHourlyCents(monthlySalaryCents, divisor)` →
  `Math.round(monthlySalary / divisor)`; `null`/0 si sin salario.
- `shiftSurcharge(shift, derivedHourlyCents, ctx)` → devuelve
  `{ minutes, source, surchargeCents, missingSalary }`:
  - `minutes`/`source` ("actual"|"planned"|"absent"): igual que hoy
    (punch real si existe, plan si no; falta en modo estricto).
  - `surchargeCents = round(minutes × derivedHourly / 60 × pct / 100)`
    con `pct` = festivo (`holidayPct`) o domingo (`sundayPct`), festivo
    manda; 0 si día normal o sin salario.
  - falta (estricto, sin check-in, turno ya vencido) ⇒ recargo 0, source
    "absent", flag; el salario base **no** se descuenta (v1 — la falta se
    marca, el operador decide el descuento).

La plantilla semanal, `hasOverlap`, `copyWeekPlan`, `weekRange`, etc. no
cambian.

### D4. `LaborSummary` (accounting) — base + recargo, no real/estimado

El desglose "real vs estimado" era artefacto del modelo por horas y deja
de aplicar a un salario fijo. Nuevo tipo:

```ts
export type LaborSummary = {
  totalCents: number;            // base + recargos
  baseSalaryCents: number;       // Σ salarios mensuales (activos con salario)
  surchargeCents: number;        // Σ recargos festivo/dominical
  salariedEmployees: number;     // contados en la base
  missingSalaryEmployees: number;// activos sin salario (flag)
  shifts: number;
  absentShifts: number;          // faltas marcadas (no descontadas)
};
```

`buildPnl` toma `labor.totalCents` para la línea de nómina; su desglose
muestra "Base salarial + Recargos".

### D5. `accountingData.ts` — cómputo del mes

- Base: `db.employee.findMany({ active, monthlySalaryCents != null })` →
  Σ `monthlySalaryCents` (salario completo del mes; **sin prorrateo** por
  altas/bajas a mitad de mes — fuera de alcance, no modelamos fechas de
  ingreso/retiro).
- Recargos: por cada turno del mes, `shiftSurcharge(sh, derivedHourly(sh.
  employee), ctx)` con los mismos `holidayPct`/`sundayPct`/estricto/
  festivos de C2, sumando `surchargeCents` y contando faltas.
- `missingSalaryEmployees` = activos con `monthlySalaryCents == null`.

### D6. APIs (gate `staff`)

- `POST/PATCH /api/operator/employees[/id]`: `hourlyRateCents` →
  `monthlySalaryCents` (int ≥ 0, ≤ 2e9, nullable).
- `GET /api/operator/staff-shifts` (semana): el resumen laboral y el costo
  por turno usan salario/valor-hora derivado; los campos de respuesta
  pasan a base/recargo. Devuelve también `hoursDivisor` para que la UI
  muestre el valor-hora.
- `staff-shifts/[id]`, `attendance/punch`: donde seleccionaban
  `employee.hourlyRateCents` ahora leen `monthlySalaryCents` + el divisor.
- `GET/PATCH /api/operator/settings/staff-policies` (o `staff-settings`):
  agregar `staffHoursDivisor` (int 1–1000, default 240) a la política
  editable.

### D7. UI (`HorariosClient` + staff-policies)

- **Modal Nuevo/Editar empleado**: campo **"Salario básico mensual"** (en
  pesos) en lugar de "Tarifa por hora"; hint en vivo **"Valor hora
  ordinaria: $X"** = salario / divisor.
- **Resumen laboral** (Horarios): "Base salarial $X + Recargos $Y = Total
  $Z", contador de "sin salario" y de faltas — reemplaza real/estimado.
- **Costo por turno** (tooltips/badges del planner): mostrar el recargo
  cuando aplique (festivo/domingo) y el flag "sin salario"; los turnos
  normales ya no muestran un costo de horas (la base es el salario).
- **staff-policies**: input de **divisor** (default 240) con ayuda ("valor
  hora = salario / divisor; 240 = jornada tradicional").
- i18n: renombrar `tarifaPorHora`→`salarioMensual`, agregar `valorHora`,
  `divisorHoras`, `baseSalarial`, `recargos`, `sinSalario`; paridad
  es/en/pt.

## Fuera de alcance (explícito)

- **Horas extra automáticas** (diurna 25% / nocturna 75%, recargo nocturno
  35%): requieren jornada configurable, agregación diaria/semanal y split
  día/noche — módulo aparte. v1 **entrega la base**: salario mensual +
  divisor + valor-hora derivado visible, listo para calcularlas encima.
- **Prestaciones sociales** (cesantías, prima, salud, pensión, ARL,
  parafiscales): liquidación de nómina completa, no este módulo.
- **Prorrateo** por altas/bajas a mitad de mes (no modelamos fechas de
  ingreso/retiro).
- **Descuento de faltas** al salario (se marcan; el operador decide).

## Entrega (2 PRs)

1. **Backend**: schema (`monthlySalaryCents`, `staffHoursDivisor`,
   `hourlyRateCents` deprecado) + `staff.ts` (`derivedHourlyCents`,
   `shiftSurcharge`, retiro de `shiftCost` por-horas) + `accounting.ts`
   (`LaborSummary`) + `accountingData.ts` + todas las rutas API + sanity
   tsx. Compila verde en un solo PR (schema y consumidores juntos).
2. **UI** (subagente): modal de empleado (salario + valor-hora), resumen
   laboral base/recargo, divisor en staff-policies, i18n trilingüe +
   verificación integral.

## Criterios de aceptación

1. El modal de empleado pide **salario mensual** (no tarifa por hora) y
   muestra el valor-hora derivado en vivo.
2. El costo laboral del mes en el P&L = Σ salarios de activos + recargos
   festivo/dominical; **no** cambia si el mismo empleado punchó 176 o 208
   horas (salvo por recargos de días especiales).
3. Un empleado sin salario se marca "sin salario" y aporta 0 (nunca se
   inventa).
4. El divisor es editable en staff-policies (default 240) y afecta el
   valor-hora y los recargos.
5. `db push` en el deploy agrega los campos nuevos sin perder datos; el
   backfill SQL es opcional. Trilingüe en paridad; tsc/eslint/build verdes.
