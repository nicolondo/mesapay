# ERP Fase A4 · Consumo automático, reorden y alertas de margen

> Spec para aprobación antes de codear. Roadmap: `docs/roadmap-erp-modulos.md`.
> Depende de A1 (inventario), A2 (compras/precios) y A3 (recetas), todas en
> producción.

## Objetivo

Cerrar el ciclo del inventario: cada venta pagada **descuenta sola** los
insumos de sus recetas (`sale_consumption`), el comercio define **puntos de
reorden** y ve avisos de "bajo mínimo" con **OC sugerida en un clic**, y
recetas avisa cuando un plato quedó con **food cost en rojo** o un insumo
**subió de precio**. Con esto el conteo físico (A1) pasa de "poner el
inventario al día" a medir desviación real (teórico vs. contado).

## Decisiones de diseño

### D1. Disparo: al pagar la orden — evento en proceso + cron de respaldo

El consumo corre cuando la orden queda `paid` (el punto único donde eso
pasa es `recomputeOrderTotalsInTx` + el flujo pickup). Mecánica:

1. **Best-effort inmediato**: un listener del bus en proceso
   (`src/lib/events.ts`, evento `order.paid`) dispara
   `consumeOrderStock(orderId)` fuera de la transacción de pago — el
   pago NUNCA espera ni falla por inventario.
2. **Respaldo**: cron `GET /api/cron/stock-consumption` (auth `CRON_SECRET`,
   patrón de membership-reminders) barre órdenes `status=paid` con
   `stockConsumedAt IS NULL` y `paidAt` en las últimas 48 h. Cubre caídas
   del proceso, deploys a mitad de pago y cualquier path que no publique
   el evento.

**Idempotencia race-safe**: `Order.stockConsumedAt` se reclama con
`updateMany({ where: { id, stockConsumedAt: null }, data: { … } })` —
count 0 ⇒ otro worker ya lo tomó. Los movimientos llevan
`StockMovement.orderId` para trazabilidad (el ledger ES el registro del
consumo, como en recepciones A2).

### D2. Qué consume una orden pagada

- Items con `cancelledAt == null`, **más los comp**
  (`cancelledAt != null && cancellationKind == "comp"`): un comp se
  preparó y consumió ingredientes aunque no se cobre. Los `cancel`
  (incl. `cancellationKind null` viejo) y los items de rounds cancelados
  no consumen.
- Por item: receta del plato (si existe) × `qty`, cada línea en **BRUTO**
  — `neto / (1 − merma%)`, redondeado a entero en unidad base. Plato sin
  receta ⇒ no genera movimientos (sin ruido).
- **Sub-recetas NO se explotan recursivamente**: el insumo elaborado se
  descuenta a sí mismo (stock negativo permitido, regla A1). Explotar al
  crudo contaría doble cuando A5 registre la producción de batches; hoy
  el elaborado sin stock queda negativo — señal honesta de que falta
  registrar producción/entrada.
- Modificadores: fuera (D5 de A3). Costo del movimiento: promedio actual
  (`computeMovement` kind out ya lo hace). Insumos inactivos se
  descuentan igual (`allowInactive`, como conteos).
- **Gate**: requiere módulos `inventory` **y** `recipes` activos. Si
  alguno está apagado, la orden se marca `stockConsumedAt` sin
  movimientos — activar módulos después NO retro-descuenta ventas viejas
  (el arranque limpio es: activar módulos → conteo inicial → desde ahí
  consume).

### D3. Puntos de reorden por insumo

`Ingredient.reorderPointBase Int?` (null = sin aviso) y
`Ingredient.reorderQtyBase Int?` (cuánto pedir; null = hasta cubrir el
punto). Se editan en el sheet de insumos (settings/insumos) en unidades
display (`toBaseQty`). "Bajo mínimo" = `qtyBase ≤ reorderPointBase`
(existencia actual, negativos incluidos).

Superficies (módulo `inventory`):
- **/operator/inventario · Existencias**: banner contador cuando hay
  insumos bajo mínimo + chip de filtro "Bajo mínimo"; la fila muestra
  el punto de reorden como referencia.
- Push/email quedan FUERA de A4 (explícito) — el aviso es visual al
  entrar; la notificación activa llega cuando haya un centro de
  notificaciones del operador.

### D4. OC sugerida en un clic (módulo `purchasing` + `inventory`)

En /operator/compras, botón "Sugerir por reorden":

- `GET /api/operator/purchase-orders/suggested` agrupa los insumos bajo
  mínimo por **proveedor preferido** (A0). Cantidad sugerida =
  `max(reorderQtyBase, punto − existencia)` redondeada **hacia arriba** a
  múltiplos de la presentación del proveedor (contentQty). Insumos sin
  proveedor preferido o sin presentación van en una lista aparte
  "sin proveedor" (informativa).
- Sheet de revisión (cantidades editables en presentaciones) → "Crear
  borradores": un draft de OC por proveedor vía `createPurchaseOrder`
  existente (precio esperado = lastPriceCents). Después siguen el flujo
  normal de A2 (editar/enviar/recibir).

### D5. Alertas de margen (módulo `recipes`)

Todo derivado en vivo, nada persistido (regla A3):

- **Food cost en rojo**: en el tab Platos, banner contador + chip de
  filtro "Food cost alto" (los > 40%, el rojo del semáforo existente).
- **Insumos al alza**: sección colapsable en Platos con los insumos cuyo
  último precio (`SupplierPriceHistory`, cualquier proveedor) subió
  ≥ 10% vs. el registro anterior dentro de los últimos 30 días, con
  % de alza y cuántos platos los usan. La "línea de tiempo de costos"
  ya existe desde A2 — acá solo se lee.

### D6. Teórico vs. conteo (sin trabajo nuevo)

Con `sale_consumption` en el ledger, el `count_adjust` de los conteos
físicos (A1) pasa a medir desviación real (merma no registrada, robo,
porciones infladas). El tab Movimientos ya lista todos los kinds; solo se
verifica que el label i18n de `sale_consumption` exista y que el detalle
del movimiento enlace la orden (shortCode).

## Modelo de datos (Prisma)

```prisma
model Order {
  // … existente …
  /// A4 — marca idempotente del consumo automático de inventario.
  stockConsumedAt DateTime?
  stockMovements  StockMovement[]
}

model Ingredient {
  // … existente …
  /// A4 — punto de reorden en unidad base (null = sin aviso).
  reorderPointBase Int?
  /// A4 — cantidad sugerida de compra en unidad base (null = cubrir punto).
  reorderQtyBase   Int?
}

model StockMovement {
  // … existente …
  /// A4 — orden que originó un sale_consumption.
  orderId String?
  order   Order?  @relation(fields: [orderId], references: [id], onDelete: SetNull)
  @@index([orderId])
}
```

## Lógica central: `src/lib/erp/consumption.ts`

- `explodeOrderConsumption(items, recipesByMenuItem)` (pura, testeable):
  agrega por insumo el bruto total de los items consumibles (D2) —
  devuelve `Map<ingredientId, qtyBase>`.
- `consumeOrderStock(orderId)`: claim idempotente → carga items + recetas
  → explode → un `applyStockMovement(kind: "sale_consumption", orderId)`
  por insumo dentro de UNA transacción. Gate de módulos (D2). Nunca
  lanza hacia el caller del pago (log + el cron reintenta si el claim
  falló antes de commitear — el claim vive en la misma tx que los
  movimientos).
- Listener de `order.paid` en el bus + cron sweep 48 h.

## API

```
GET  /api/cron/stock-consumption            → sweep (CRON_SECRET)
GET  /api/operator/purchase-orders/suggested → grupos por proveedor (D4)
     (gate purchasing+inventory)
PATCH ingredients/[id] (existente)          → acepta reorderPointBase/QtyBase
GET  /api/operator/stock (existente)        → incluye reorderPointBase
GET  /api/operator/recipes (existente)      → + sección priceAlerts (D5)
```

## i18n

Extensión de `opErp` (es/en/pt): banner/chip de reorden, sheet OC
sugerida, alertas de margen, label `sale_consumption`. Paridad estricta.

## Fuera de alcance (explícito)

Push/email de reorden. Explosión recursiva de sub-recetas y producción de
batches (A5). Retro-consumo de ventas previas a activar módulos.
Modificadores. Par levels por día de semana / estacionalidad.

## Entrega (4 PRs)

1. Schema + `consumption.ts` + listener + cron + sanity tsx.
2. Reorden: campos en insumos settings + banner/chip en inventario — subagente.
3. OC sugerida: endpoint + sheet en compras — subagente.
4. Alertas de margen en recetas + label movimientos + verificación integral.

## Criterios de aceptación

1. Orden con 2× plato (receta 180 g lomo, merma 20%) pagada ⇒ movimiento
   `sale_consumption` de 450 g de lomo (2 × 225 g brutos) ligado a la
   orden; pagar de nuevo / re-correr el cron NO duplica.
2. Item comp consume; item cancel no. Plato sin receta no genera ruido.
3. Insumo con punto de reorden 2000 g y existencia 1500 g ⇒ banner + chip
   en inventario lo muestran; sin punto configurado, nunca alerta.
4. "Sugerir por reorden" arma borradores por proveedor preferido con
   cantidades redondeadas a presentaciones; sin preferido ⇒ lista aparte.
5. Plato con food cost 45% aparece en el filtro rojo; insumo con alza
   ≥ 10% en 30 días aparece en "insumos al alza" con sus platos.
6. Módulo apagado ⇒ ni consume ni alerta; API 403 donde aplica. Trilingüe
   en paridad.
