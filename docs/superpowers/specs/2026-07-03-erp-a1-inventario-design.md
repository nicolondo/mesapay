# ERP Fase A1 · Inventario core — existencias, movimientos, conteos y mermas

> Spec para aprobación antes de codear. Roadmap: `docs/roadmap-erp-modulos.md`.
> Depende de A0 (catálogo de insumos, en producción — PRs #207-#211).

## Objetivo

Que el comercio sepa **cuánto tiene y cuánto vale** cada insumo, con
trazabilidad total: entradas, ajustes, mermas con motivo y conteos físicos
con desviación. Sin órdenes de compra (A2) ni consumo automático por venta
(A4) — pero el modelo de movimientos nace listo para recibirlos.

## Decisiones de diseño

### D1. Libro inmutable + saldo materializado

- **`StockMovement` es append-only** — la fuente de verdad. Nunca se edita
  ni se borra un movimiento; una equivocación se corrige con un movimiento
  de ajuste en sentido contrario. Esto da auditoría contable real.
- **`StockLevel`** materializa el saldo actual por insumo (cantidad +
  valor) para lecturas rápidas. Se actualiza **en la misma transacción**
  que inserta el movimiento. Si algún día se desalinea, se puede
  reconstruir sumando el libro.

### D2. Tipos de movimiento (enum con espacio para las fases siguientes)

| Kind (A1) | Dirección | Uso |
|---|---|---|
| `purchase_in` | + | Entrada de mercancía (manual en A1; la recepción de OC en A2 creará estos mismos) |
| `adjust_in` / `adjust_out` | ± | Ajuste manual con nota |
| `count_adjust` | ± | Generado al cerrar un conteo físico (diferencia teórico vs. contado) |
| `waste` | − | Merma con motivo |

Reservados para fases siguientes (el enum ya los define, la API A1 no los
acepta): `sale_consumption` (A4), `transfer_in`/`transfer_out` (A5),
`production_in`/`production_out` (A5).

Motivos de merma (`WasteReason`): `expired`, `damaged`, `kitchen_error`,
`spill`, `other` (+ nota libre).

### D3. Valorización: costo promedio ponderado con enteros exactos

Nada de floats persistidos. `StockLevel` guarda **`qtyBase Int`** (unidad
base de A0: g/ml/un) y **`totalValueCents Int`**; el costo promedio es
**derivado** (`totalValueCents / qtyBase`) — así el promedio móvil es
exacto en centavos:

- **Entrada con costo** (qty, costo total): `qty += q; value += costo`.
- **Entrada sin costo**: se valora al promedio actual (`value +=
  round(q × avg)`) — el promedio no cambia.
- **Salida** (merma/ajuste−/conteo−): `value -= round(q × avg)`; el
  movimiento registra el valor descontado (eso es el **costo de la merma**
  que verá el P&L en B2).
- Cada `StockMovement` persiste `qtyBase` (con signo) y `valueCents` (con
  signo) → el libro re-suma al saldo exacto.

### D4. El stock PUEDE quedar negativo

Regla del roadmap: el inventario **nunca** bloquea la operación. Un saldo
negativo no rechaza movimientos (la UI lo pinta en rojo como señal de
"toca contar"). Crítico para A4: el consumo automático por venta jamás debe
fallar por un descuadre de inventario.

### D5. Conteo físico como sesión (borrador → cierre)

Contar una bodega toma horas y se interrumpe. `StockCount` es una sesión:

- **Crear** → snapshot del teórico (`expectedQty`) por insumo incluido
  (todos los activos o un subconjunto filtrado por categoría).
- **Borrador**: se van digitando cantidades contadas (en unidad de display,
  convertidas con `toBaseQty`); se puede guardar y seguir después. El
  teórico queda CONGELADO al snapshot para que las ventas/movimientos del
  día no muevan el piso mientras contás.
- **Cerrar** → genera un `count_adjust` por cada diferencia ≠ 0 (en una
  transacción) y deja el reporte de **desviación** (teórico vs. contado,
  unidades y $) permanente.
- Un solo conteo abierto por comercio a la vez (evita ajustes cruzados).

### D6. Superficie propia: `/operator/inventario` (no en settings)

El inventario es operación diaria, no configuración. Página nueva en la nav
del operador (el layout ya arma la nav condicional — se agrega el item solo
con el módulo `inventory` activo), con 3 vistas en tabs/segmentos:

1. **Existencias** — lista: insumo, cantidad (formatBaseQty), valor,
   costo promedio, negativo en rojo. Búsqueda + filtro por categoría.
   Acciones: **Entrada**, **Ajuste**, **Merma** (sheets).
2. **Movimientos** — historial global (y filtrable por insumo): fecha,
   tipo, cantidad ±, valor ±, quién, nota/motivo. Paginado por cursor.
3. **Conteos** — lista de sesiones (abierta/cerradas con su desviación) +
   flujo de conteo (crear → digitar → cerrar).

Gate: módulo `inventory` (página `notFound()`, API 403, item de nav
oculto). Roles: operator / platform_admin.

## Modelo de datos (Prisma)

```prisma
enum StockMovementKind {
  purchase_in
  adjust_in
  adjust_out
  count_adjust
  waste
  sale_consumption // A4
  transfer_in      // A5
  transfer_out     // A5
  production_in    // A5
  production_out   // A5
}

enum WasteReason {
  expired
  damaged
  kitchen_error
  spill
  other
}

/// Saldo materializado por insumo. Costo promedio = totalValueCents/qtyBase
/// (derivado, nunca persistido). Actualizado en la misma tx que el movimiento.
model StockLevel {
  id              String     @id @default(cuid())
  restaurantId    String
  restaurant      Restaurant @relation(fields: [restaurantId], references: [id], onDelete: Cascade)
  ingredientId    String     @unique
  ingredient      Ingredient @relation(fields: [ingredientId], references: [id], onDelete: Cascade)
  qtyBase         Int        @default(0) // puede ser negativo (D4)
  totalValueCents Int        @default(0)
  updatedAt       DateTime   @updatedAt

  @@index([restaurantId])
}

/// Libro de movimientos — APPEND-ONLY. qtyBase y valueCents con signo.
model StockMovement {
  id           String            @id @default(cuid())
  restaurantId String
  restaurant   Restaurant        @relation(fields: [restaurantId], references: [id], onDelete: Cascade)
  ingredientId String
  ingredient   Ingredient        @relation(fields: [ingredientId], references: [id], onDelete: Cascade)
  kind         StockMovementKind
  qtyBase      Int    // + entra, − sale
  valueCents   Int    // valor del movimiento con signo (costo en salidas)
  wasteReason  WasteReason?
  note         String?
  // Referencias futuras: OC (A2), orden de venta (A4), conteo (D5).
  stockCountId String?
  stockCount   StockCount? @relation(fields: [stockCountId], references: [id], onDelete: SetNull)
  createdById  String?
  createdBy    User?   @relation(fields: [createdById], references: [id], onDelete: SetNull)
  createdAt    DateTime @default(now())

  @@index([restaurantId, createdAt])
  @@index([ingredientId, createdAt])
}

enum StockCountStatus {
  draft
  closed
}

/// Sesión de conteo físico (D5). Teórico congelado al crear.
model StockCount {
  id           String           @id @default(cuid())
  restaurantId String
  restaurant   Restaurant       @relation(fields: [restaurantId], references: [id], onDelete: Cascade)
  status       StockCountStatus @default(draft)
  notes        String?
  createdById  String?
  createdBy    User?            @relation(fields: [createdById], references: [id], onDelete: SetNull)
  createdAt    DateTime         @default(now())
  closedAt     DateTime?

  items     StockCountItem[]
  movements StockMovement[]

  @@index([restaurantId, status])
}

model StockCountItem {
  id           String     @id @default(cuid())
  countId      String
  count        StockCount @relation(fields: [countId], references: [id], onDelete: Cascade)
  ingredientId String
  ingredient   Ingredient @relation(fields: [ingredientId], references: [id], onDelete: Cascade)
  expectedQty  Int  // snapshot del teórico al crear la sesión
  countedQty   Int? // null = todavía no contado

  @@unique([countId, ingredientId])
}
```

(Back-relations en `Restaurant`, `Ingredient` y `User`.)

## Lógica central: `src/lib/erp/stock.ts`

`applyStockMovement(tx, {...})` — ÚNICO camino para tocar inventario
(A2/A4/A5 lo reutilizan). Dentro de una transacción: upsert de StockLevel,
cálculo de valueCents según D3, insert del movimiento. Validaciones: insumo
del comercio y activo, qty ≠ 0, kind permitido por la fase. Sanity-check con
tsx contra ejemplos (entrada con/sin costo, salida a promedio, negativo).

## API (gate `inventory`, guard `getErpContext`)

```
GET  /api/operator/stock                     → niveles + insumo (join)
POST /api/operator/stock/movements           → entrada/ajuste/merma
     { ingredientId, kind: purchase_in|adjust_in|adjust_out|waste,
       qtyBase>0, totalCostCents? (solo purchase_in), wasteReason? (waste),
       note? }
GET  /api/operator/stock/movements?ingredientId=&cursor=  → historial (30/pág)
GET  /api/operator/stock/counts              → sesiones
POST /api/operator/stock/counts              → crear draft { categoryFilter?, notes? } (409 si hay una abierta)
GET  /api/operator/stock/counts/[id]         → sesión + items
PATCH /api/operator/stock/counts/[id]        → guardar countedQty parciales
POST /api/operator/stock/counts/[id]/close   → genera count_adjust + cierra
```

## i18n

Extensión del namespace `opErp` (es/en/pt, paridad): nav "Inventario",
tabs, labels de tipos de movimiento y motivos de merma, formularios,
estados de conteo, errores (`count_open_exists`, `qty_invalid`, etc.).
Globs nuevos a MIGRATED.

## Fuera de alcance (explícito)

Alertas de reorden / par levels (A4). Consumo por venta (A4). OCs (A2).
Multi-bodega/traslados (A5). Valor FIFO/lotes/vencimientos (promedio
ponderado alcanza para food cost; lotes es sobre-ingeniería acá).

## Entrega (5 PRs)

1. Schema + `src/lib/erp/stock.ts` (applyStockMovement) + sanity tsx.
2. API stock + movimientos (con historial paginado).
3. UI `/operator/inventario`: existencias + sheets entrada/ajuste/merma +
   historial. Item de nav gateado.
4. Conteos: API sesiones + UI (crear/digitar/cerrar/desviación).
5. Flip `inventory.shipped = true` + verificación integral + smoke on/off.

## Criterios de aceptación

1. Entrada de 5 kg de lomo a $80.000 → existencia 5 kg, valor $80.000,
   promedio $16/g visible; merma de 500 g motivo "dañado" → existencia
   4,5 kg, movimiento con costo −$8.000.
2. El libro nunca se edita: correcciones = ajustes; historial completo con
   quién y cuándo.
3. Conteo: teórico congelado, borrador reanudable, cierre genera ajustes y
   reporte de desviación en unidades y pesos.
4. Stock negativo permitido y señalizado; nada de la operación se bloquea.
5. Módulo apagado → sin nav, sin página (404), API 403. Trilingüe en paridad.
