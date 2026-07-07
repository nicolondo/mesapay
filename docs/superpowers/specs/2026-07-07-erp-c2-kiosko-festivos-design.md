# ERP Fase C2 · Kiosko de asistencia con foto, plantillas y festivos

> Spec para aprobación antes de codear. Extiende la Fase C1 (horarios,
> asistencia, costo laboral — módulo `staff`). Arranca cuando C1 cierre.
> Decisiones del dueño (2026-07-07): reconocimiento **facial en el
> navegador** (sin servicios externos) y **recargo configurable** por
> festivos/domingos.

## Objetivo

Que el equipo marque entrada y salida **solo con la cara** en una tablet
del local (foto de evidencia incluida), que cada empleado tenga su
**horario configurado** (si olvida marcar la salida se cierra con su hora
configurada; si nunca marcó entrada cuenta como **falta**), y que todo lo
que toque nómina — costo de turnos, P&L, prime cost — **respete los
festivos del país** con recargo configurable.

## Decisiones de diseño

### D1. Kiosko: reconocimiento facial EN el navegador

Página `/operator/horarios/kiosko` (gate `staff`, bajo la sesión del
operador — la tablet del local ya está logueada; pantalla completa,
botones grandes **Entrada** / **Salida**):

1. Tap → cámara frontal (`getUserMedia`) → foto.
2. `@vladmandic/face-api` (modelos ~6 MB servidos desde `/public/models`,
   cargados solo en esta página) calcula el descriptor **localmente** y
   lo compara contra los descriptores registrados de los empleados
   activos (distancia euclidiana, umbral 0.5).
3. Match → "Hola, {nombre}" con botón confirmar (3 s de auto-confirm);
   sin match o confianza baja → selector manual de nombre (la foto igual
   queda de evidencia).
4. POST del punch con la foto: el server puncha el turno de HOY del
   empleado; si no hay turno planeado, lo crea desde su plantilla (D3) o,
   sin plantilla, con inicio = ahora y fin = inicio + 8 h (editable).

Nada biométrico sale del dispositivo/servidor propio: descriptores y
fotos viven en la DB/disco de MESAPAY (mismo mecanismo de subida de
fotos del menú, `/api/operator/uploads`).

### D2. Enrolamiento facial + consentimiento (datos sensibles)

En el tab Equipo: "Registrar rostro" → captura 1-3 fotos de referencia →
descriptores calculados en el cliente y guardados en el empleado. El
rostro es **dato sensible** (CO Ley 1581/2012; MX LFPDPPP): el flujo
exige marcar el consentimiento informado (texto i18n) y guarda
`faceConsentAt`; "Eliminar registro facial" borra descriptores, fotos de
referencia y el consentimiento. Empleado sin rostro registrado usa el
selector manual del kiosko — nunca es obligatorio.

### D3. Plantilla de horario por empleado

`Employee.weeklyTemplate Json`: por día de la semana (lun-dom), 0-2
rangos `{startMinutes, endMinutes}` (mismas reglas C1: 15 min-16 h,
nocturnos cruzan medianoche). Usos:

- **"Aplicar plantilla"** en el planner: llena la semana visible con los
  turnos de plantilla de todos los activos (salta choques, reporta
  creados/saltados — complementa "Copiar semana").
- **Turno implícito del kiosko** (D1.4).
- La hora de salida configurada para el auto-cierre es la del TURNO del
  día (que nace de la plantilla o de planeación manual) — una sola
  fuente de verdad.

### D4. Auto-cierre y faltas

- **Cron diario** `POST /api/cron/staff-attendance` (~05:00, x-cron-secret):
  turnos de AYER con entrada y sin salida → `checkOutAt` = fin planeado
  del turno, marcado `autoClosed` (badge "cierre automático", ajustable a
  mano después). Corre para todos los comercios con `staff` activo.
- **Faltas**: turno pasado SIN check-in = falta — derivada al leer, con
  el comercio en **modo asistencia estricta** (`staffStrictAttendance`,
  default OFF): cuesta $0 y sale con badge "Falta" en Semana/Hoy y en el
  desglose laboral del P&L (conteo de faltas). Con el modo apagado se
  mantiene el comportamiento C1 (costo planeado como estimado) — así los
  comercios que planean sin kiosko no ven $0 de nómina. El toggle vive
  en los ajustes de Horarios; al adoptar el kiosko se enciende.

### D5. Festivos del país + recargos configurables

- `src/lib/erp/holidays.ts` (pura): `holidaysForYear(country, year)` —
  **CO**: Ley 51/1983 (fijos + trasladables a lunes Emiliani + los
  dependientes de Pascua); **MX**: feriados obligatorios LFT (fijos +
  lunes móviles de febrero/marzo/noviembre). Otros países: sin festivos
  (lista vacía) hasta habilitarlos.
- **Recargos** por comercio: `staffHolidayPct` y `staffSundayPct`
  (enteros %, default 75 y 75 — el estándar CO; editables en los ajustes
  de Horarios, 0 = sin recargo). `shiftCost` gana el recargo: horas de un
  turno cuyo DÍA (el día en que empieza) es festivo pagan
  `tarifa × (1 + pct/100)`; domingo no festivo usa el pct dominical.
  Desglose `surchargeCents` visible en turno/semana; el P&L y el prime
  cost lo heredan solos (usan el mismo `shiftCost`).
- El planner marca los días festivos (badge en el encabezado del día).
- Simplificación documentada: el recargo se decide por el día en que
  EMPIEZA el turno (un nocturno de sábado que termina el domingo no
  parte horas). Liquidación legal completa (horas extra, recargo
  nocturno, prestaciones) sigue FUERA — esto es costo gerencial.

### D6. Modelo de datos (Prisma)

```prisma
// Employee +
weeklyTemplate Json?     // [{weekday: 0-6, ranges: [{startMinutes, endMinutes}]}]
faceDescriptors Json?    // number[128][] (1-3) — dato sensible
facePhotoUrls  Json?     // fotos de referencia
faceConsentAt  DateTime? // consentimiento informado

// StaffShift +
checkInPhotoUrl  String?
checkOutPhotoUrl String?
checkInMethod  String?   // "face" | "manual" | "operator"
checkOutMethod String?
autoClosed     Boolean @default(false)

// Restaurant +
staffStrictAttendance Boolean @default(false)
staffHolidayPct       Int     @default(75)
staffSundayPct        Int     @default(75)
```

### D7. API

```
POST  /api/operator/attendance/punch     → { employeeId, kind: in|out,
        photoUrl, method: face|manual, confidence? } — puncha el turno de
        hoy (crea el implícito D1.4); 409 already_punched, 404 employee
PATCH /api/operator/employees/[id]       → + weeklyTemplate, faceDescriptors,
        facePhotoUrls, faceConsentAt (validaciones de rangos y tamaños)
GET   /api/operator/attendance/roster    → empleados activos con
        descriptores (para el match del kiosko) — gate staff
POST  /api/operator/staff-shifts/apply-template → { week } → {created, skipped}
PATCH /api/operator/staff-settings       → strict/holidayPct/sundayPct
POST  /api/cron/staff-attendance         → auto-cierre (CRON_SECRET)
GET   /api/operator/staff-shifts (existente) → + isHoliday por turno,
        surchargeCents en cost, faltas (modo estricto), festivos de la semana
```

## Lógica central (pura, testeable)

- `holidaysForYear` / `isHoliday` (Emiliani CO con Pascua computada; MX).
- `shiftCost` extendido: `{..., surchargeCents, absent}` — recargo por
  festivo/domingo del día de inicio; falta = pasado sin check-in en modo
  estricto ⇒ costo 0.
- `templateShiftsForWeek(template, monday)` → turnos candidatos.
- Sanity tsx: Emiliani (p. ej. Reyes 2026 → lunes 12 ene), Pascua (Viernes
  Santo 2026 = 3 abr), recargo 75% en festivo, falta $0 estricto vs.
  estimado no estricto, auto-cierre a la hora planeada.

## i18n

Extensión de `opErp` (kiosko, enrolamiento + texto de consentimiento,
plantilla, ajustes, badges falta/festivo/auto-cierre/recargo). Paridad.

## Fuera de alcance (explícito)

Liquidación legal completa (horas extra, recargo nocturno,
prestaciones), servicios externos de reconocimiento, geofencing/kiosko
sin sesión, notificaciones de falta, retención/depuración automática de
fotos de punch (manual por ahora), festivos de países distintos a CO/MX.

## Entrega (5 PRs)

1. Schema + `holidays.ts` + `shiftCost` con recargos/faltas + sanity.
2. API: punch + roster + template + settings + cron auto-cierre +
   extensión del GET semanal.
3. UI kiosko (cámara + face-api + confirmación + selector manual) —
   subagente.
4. UI: plantilla en Equipo, enrolamiento facial + consentimiento,
   ajustes (estricto/recargos), festivos/faltas/auto-cierre en
   Semana/Hoy y desglose laboral del P&L — subagente.
5. Verificación integral (`staff` ya embarcado desde C1).

## Criterios de aceptación

1. Kiosko: empleado enrolado marca entrada con la cara en <5 s, la foto
   queda en el turno; sin match cae a selector manual y también puncha.
2. Olvidó salida: el cron cierra el turno a la hora planeada con badge
   "cierre automático"; el costo usa ese rango.
3. Modo estricto: turno de ayer sin check-in aparece como "Falta" y
   cuesta $0; sin modo estricto se mantiene el estimado C1.
4. Turno en festivo CO (p. ej. 20 jul) con tarifa $10.000/h y recargo
   75% cuesta $17.500/h; el P&L y el prime cost lo reflejan sin cambios
   adicionales. Reyes 2026 cae lunes 12 de enero (Emiliani).
5. "Aplicar plantilla" llena la semana y salta choques. Eliminar el
   registro facial borra descriptores/fotos/consentimiento.
6. Módulo apagado ⇒ nada visible; API 403. Trilingüe en paridad.
