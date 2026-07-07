# ERP Fase A5 · Producción de batches y traslados entre sedes

> Spec para aprobación antes de codear. Roadmap: `docs/roadmap-erp-modulos.md`.
> Módulo nuevo: `production` (slug ya en el catálogo con `shipped: false`).
> Depende de A1 (ledger), A3 (sub-recetas) y — para traslados — de Grupos F1.

## Objetivo

Cerrar los dos huecos que quedaron señalados en A3/A4: (1) **producir un
batch** de una sub-receta mueve inventario de verdad — salen los
ingredientes, entra el elaborado con su costo real — y el elaborado deja
de quedar negativo cuando las ventas lo consumen; (2) **trasladar
insumos entre sedes** del mismo grupo (la bodega central le manda lomo a
la sede norte) con el valor viajando con la mercancía.

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

### D3. Traslados: inmediatos, entre sedes del grupo, matching por nombre

- Origen y destino deben pertenecer al **mismo grupo** (validación
  server). Sin estado "en tránsito" en A5: el traslado se registra al
  despachar y escribe las DOS sedes en una tx (misma DB) —
  `transfer_out` en origen al promedio actual y `transfer_in` en destino
  con `totalCostCents` = |valor de salida| (el valor viaja con la
  mercancía, como una recepción).
- **Matching de insumos** (los catálogos son por sede): por nombre
  normalizado (fold accent-insensitive, mismo helper de búsqueda) +
  `measureKind` igual. Si el destino no tiene el insumo, se CREA
  (nombre/categoría/measureKind copiados, activo). Nombre igual con
  dimensión distinta ⇒ error por línea (`measure_kind_mismatch`) — nunca
  mezclar gramos con mililitros.
- Gate: módulo `production` activo en la sede ORIGEN (quien despacha).
  El destino recibe movimientos sin exigir módulo (como una recepción de
  OC — la mercancía llega igual); su operador los ve en el historial de
  inventario si tiene `inventory`.

### D4. Modelo de datos (Prisma)

```prisma
model ProductionBatch {
  id           String     @id @default(cuid())
  restaurantId String
  restaurant   Restaurant @relation(fields: [restaurantId], references: [id], onDelete: Cascade)
  // Sub-receta producida (snapshot vía outputIngredientId — la receta
  // puede cambiar después; el ledger conserva lo que realmente salió).
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

model Transfer {
  id               String     @id @default(cuid())
  groupId          String
  fromRestaurantId String
  from             Restaurant @relation("TransfersOut", fields: [fromRestaurantId], references: [id], onDelete: Cascade)
  toRestaurantId   String
  to               Restaurant @relation("TransfersIn", fields: [toRestaurantId], references: [id], onDelete: Cascade)
  note             String?
  createdById      String?
  createdBy        User?      @relation("TransferCreator", fields: [createdById], references: [id], onDelete: SetNull)
  createdAt        DateTime   @default(now())

  items     TransferItem[]
  movements StockMovement[]

  @@index([fromRestaurantId, createdAt])
  @@index([toRestaurantId, createdAt])
}

model TransferItem {
  id         String   @id @default(cuid())
  transferId String
  transfer   Transfer @relation(fields: [transferId], references: [id], onDelete: Cascade)
  // Insumo en ORIGEN y su gemelo en DESTINO (resuelto/creado al despachar).
  fromIngredientId String
  toIngredientId   String
  qtyBase          Int
  valueCents       Int // |transfer_out| = totalCost del transfer_in

  @@index([transferId])
}
```

`StockMovement` gana `productionBatchId` y `transferId` (FKs opcionales
SetNull + índices), mismo patrón que `purchaseOrderId`/`orderId`.

### D5. Superficie: `/operator/produccion` (módulo `production`)

Página propia (patrón contabilidad): gate + nav "Producción". Dos tabs:

1. **Batches** — historial (fecha, elaborado, cantidad, costo, quién,
   badge costo parcial) + botón "Producir": sheet con picker de
   sub-receta (las de A3), cantidad producida en unidades display
   (default = rendimiento), **preview en vivo** de consumos por línea
   (escalados, con costo al promedio actual y hint en líneas sin costo)
   y costo total del batch. Registrar → POST.
2. **Traslados** — solo tiene sentido con grupo: sin `groupId` o con una
   sola sede, empty-state explicativo. Historial enviados/recibidos
   (dirección, sede, items, valor) + botón "Trasladar": sheet con
   destino (sedes hermanas), líneas insumo + cantidad display, preview
   de valor al promedio actual y aviso por línea cuando el insumo se
   creará en destino o cuando hay `measure_kind_mismatch`.

### D6. API (gate `production` vía getErpContext)

```
GET  /api/operator/production            → batches (paginado 20)
POST /api/operator/production            → { outputIngredientId, outputQtyBase, note? }
                                           (400 no_subrecipe si el insumo no tiene receta,
                                            400 qty inválida; respuesta incluye partialCost)
GET  /api/operator/transfers             → enviados + recibidos (paginado)
GET  /api/operator/transfers/context     → sedes hermanas + matching preview por insumo
POST /api/operator/transfers             → { toRestaurantId, items: [{ingredientId, qtyBase}], note? }
                                           (400 not_same_group | measure_kind_mismatch (por línea)
                                            | qty inválida; máx. 100 líneas)
```

El preview de consumos del batch se calcula EN EL CLIENTE con datos que
ya expone `GET /api/operator/recipes` (líneas + rendimiento) y
`GET /api/operator/stock` (promedios) — sin endpoint nuevo; el server
recalcula al registrar (la verdad es del server).

## Lógica central: `src/lib/erp/production.ts` (pura, testeable)

- `scaleBatchLines(recipeItems, outputQtyBase, producedQtyBase)` →
  `[{ingredientId, qtyBase}]` (bruto por merma, escalado, redondeado,
  filtra qty 0).
- `runProduction(tx, args)`: valida sub-receta, aplica los
  `production_out` (capturando valores) + `production_in` con el costo
  acumulado, crea el `ProductionBatch`. Reusa `applyStockMovement`.
- `resolveTransferTargets(fromItems, toIngredients)` (pura): matching
  fold+measureKind → `{matched, toCreate, mismatched}`.
- `runTransfer(tx, args)`: resuelve/crea gemelos en destino, aplica
  `transfer_out`/`transfer_in` por línea con el valor viajando, crea
  `Transfer` + items.
- Sanity con tsx contra los criterios de aceptación.

## i18n

Extensión de `opErp`: nav "Producción", tabs, sheets, badges, errores.
`navProduction` en el namespace `operator`. Glob a MIGRATED. Paridad.

## Fuera de alcance (explícito)

Planeación de producción (batch sugerido por demanda), estados en
tránsito / confirmación en destino, traslados de dinero, edición o
anulación de batches/traslados (movimientos contrarios manuales),
traslados entre grupos distintos, costos de transporte.

## Entrega (4 PRs)

1. Schema + `src/lib/erp/production.ts` + sanity tsx.
2. API: production + transfers + context.
3. UI `/operator/produccion` (2 tabs) + nav — subagente.
4. Flip `production.shipped = true` + verificación integral.

## Criterios de aceptación

1. Sub-receta "Salsa" (rinde 2000 ml: 1000 g tomate merma 0%, 500 ml
   aceite merma 20%): producir 3000 ml ⇒ sale 1500 g de tomate y 938 ml
   de aceite (625 × 1,5 / 0,8 redondeado), entra 3000 ml de salsa con
   costo = Σ exacto de las dos salidas; el promedio del elaborado queda
   consistente (valor/cantidad).
2. Producir con una línea sin costo en stock ⇒ batch registrado con
   `partialCost: true` y badge en UI — nunca bloquea.
3. Traslado de 2 kg de lomo (promedio $16.000/kg) a una sede hermana ⇒
   `transfer_out` −2000 g / −$32.000 en origen y `transfer_in` +2000 g /
   +$32.000 en destino en la MISMA tx; si el destino no tenía "Lomo", se
   crea con la misma dimensión.
4. Traslado a una sede de otro grupo ⇒ 400; insumo homónimo con otra
   dimensión ⇒ 400 `measure_kind_mismatch` señalando la línea.
5. Módulo apagado ⇒ sin nav, página 404, API 403. Comercio sin grupo ⇒
   tab Traslados con empty-state, API `transfers` 400 `no_group`.
   Trilingüe en paridad.
