# ERP Fase A5 · Producción de batches

> Spec para aprobación antes de codear. Roadmap: `docs/roadmap-erp-modulos.md`.
> Módulo nuevo: `production` (slug ya en el catálogo con `shipped: false`).
> Depende de A1 (ledger) y A3 (sub-recetas).
>
> **Cambio de alcance (2026-07-06, decisión de producto):** los traslados
> entre sedes se DESCARTARON — no se van a desarrollar. Esta fase queda
> solo con producción de batches.

## Objetivo

Cerrar el hueco señalado en A3/A4: **producir un batch** de una
sub-receta mueve inventario de verdad — salen los ingredientes, entra el
elaborado con su costo real — y el elaborado deja de quedar negativo
cuando las ventas lo consumen (A4).

## Decisiones de diseño

### D1. Batch anclado a la sub-receta, cantidad libre, costo real

"Producir" toma una sub-receta (A3: `Recipe` con `outputIngredientId` +
`outputQtyBase` de rendimiento) y una **cantidad producida** en unidad
base (libre — no tiene que ser el rendimiento exacto; la cocina hace
batch y medio). Movimientos en UNA transacción:

- Por cada línea: `production_out` del ingrediente por
  `round(bruto_por_rendimiento × producido / rendimiento)` (la merma de
  la línea aplica — mismo `grossQty` de A3), valorado al **promedio
  actual** (regla A1). Stock negativo permitido — producir nunca se
  bloquea.
- Un `production_in` del elaborado por la cantidad producida, con
  `totalCostCents` = Σ |valueCents| de los `production_out` — el costo
  ENTRA exactamente igual a lo que salió (enteros exactos, el promedio
  del elaborado queda real).
- Si alguna línea sale valorada en 0 (ingrediente sin costo en stock),
  el batch entra con costo parcial — flag derivado `partialCost` en la
  respuesta/UI (badge "costo parcial"), nunca se bloquea ni se inventa.

### D2. Registro humano: modelo `ProductionBatch`

El ledger sigue siendo la verdad (movimientos con `productionBatchId`),
pero un batch es un evento operativo que se lista: quién produjo qué,
cuánto y a qué costo. Sin estados — el batch se registra ya hecho
(planear producción es otra fase). Sin edición: un error se corrige con
movimientos contrarios (regla A1); borrar batches no existe.

### D3. Modelo de datos (Prisma)

```prisma
model ProductionBatch {
  id           String     @id @default(cuid())
  restaurantId String
  restaurant   Restaurant @relation(fields: [restaurantId], references: [id], onDelete: Cascade)
  // Elaborado producido (la receta puede cambiar después; el ledger
  // conserva lo que realmente salió).
  outputIngredientId String
  outputIngredient   Ingredient @relation("BatchOutput", fields: [outputIngredientId], references: [id], onDelete: Restrict)
  outputQtyBase Int // cantidad producida (unidad base del elaborado)
  costCents     Int // Σ consumos — lo que entró el production_in
  note          String?
  createdById   String?
  createdBy     User?    @relation("ProductionBatchCreator", fields: [createdById], references: [id], onDelete: SetNull)
  createdAt     DateTime @default(now())

  movements StockMovement[]

  @@index([restaurantId, createdAt])
}
```

`StockMovement` gana `productionBatchId` (FK opcional SetNull + índice),
mismo patrón que `purchaseOrderId`/`orderId`.

### D4. Superficie: `/operator/produccion` (módulo `production`)

Página propia (patrón contabilidad): gate + nav "Producción". Una sola
vista: **historial de batches** (fecha, elaborado, cantidad, costo,
quién, badge costo parcial; paginado) + botón "Producir": sheet con
picker de sub-receta (las de A3), cantidad producida en unidades display
(default = rendimiento), **preview en vivo** de consumos por línea
(escalados, con costo al promedio actual y hint en líneas sin costo) y
costo total del batch. Registrar → POST.

El preview se calcula EN EL CLIENTE con datos que ya exponen
`GET /api/operator/recipes` (líneas + rendimiento) y
`GET /api/operator/stock` (promedios) — sin endpoint nuevo; el server
recalcula al registrar (la verdad es del server).

### D5. API (gate `production` vía getErpContext)

```
GET  /api/operator/production   → batches (paginado 20, cursor)
POST /api/operator/production   → { outputIngredientId, outputQtyBase, note? }
                                  (400 no_subrecipe si el insumo no tiene
                                   receta, 400 qty inválida; respuesta
                                   incluye batch + partialCost)
```

## Lógica central: `src/lib/erp/production.ts` (pura + tx)

- `scaleBatchLines(recipeItems, outputQtyBase, producedQtyBase)` (pura) →
  `[{ingredientId, qtyBase}]` (bruto por merma, escalado, redondeado,
  filtra qty 0).
- `runProduction(tx, args)`: valida sub-receta y cantidades, aplica los
  `production_out` (capturando valores) + `production_in` con el costo
  acumulado, crea el `ProductionBatch`. Reusa `applyStockMovement`.
- Sanity con tsx contra los criterios de aceptación.

## i18n

Extensión de `opErp`: tabs/sheet/badges/errores + `navProduction` en el
namespace `operator`. Glob a MIGRATED. Paridad estricta.

## Fuera de alcance (explícito)

**Traslados entre sedes — descartados por decisión de producto (no se
desarrollan).** Planeación de producción (batch sugerido por demanda),
edición/anulación de batches (movimientos contrarios manuales), costos
de mano de obra en el batch.

## Entrega (4 PRs)

1. Schema `ProductionBatch` + FK en StockMovement + `production.ts` + sanity tsx.
2. API: GET/POST /api/operator/production.
3. UI `/operator/produccion` + nav — subagente.
4. Flip `production.shipped = true` + verificación integral.

## Criterios de aceptación

1. Sub-receta "Salsa" (rinde 2000 ml: 1000 g tomate merma 0%, 500 ml
   aceite merma 20%): producir 3000 ml ⇒ sale 1500 g de tomate y 938 ml
   de aceite (625 × 1,5 / 0,8 redondeado), entra 3000 ml de salsa con
   costo = Σ exacto de las dos salidas; el promedio del elaborado queda
   consistente (valor/cantidad).
2. Producir con una línea sin costo en stock ⇒ batch registrado con
   `partialCost: true` y badge en UI — nunca bloquea.
3. Insumo sin sub-receta ⇒ 400 `no_subrecipe`. Cantidad 0/negativa ⇒ 400.
4. El movimiento del ledger enlaza el batch (kind `production_in/out`
   con `productionBatchId`) y se lee en el tab Movimientos de inventario
   con su label.
5. Módulo apagado ⇒ sin nav, página 404, API 403. Trilingüe en paridad.
