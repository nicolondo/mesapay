# ERP Fase A2 · Compras — órdenes de compra, recepción, precios y CxP

> Spec para aprobación antes de codear. Roadmap: `docs/roadmap-erp-modulos.md`.
> Depende de A0 (proveedores + lista de precios) y A1 (inventario), ambas en
> producción (PRs #207-#211 y #213-#217).

## Objetivo

Cerrar el ciclo de abastecimiento: **armar la orden de compra → enviarla al
proveedor → recibir la mercancía (total o parcial) → el stock y el costo
promedio se actualizan solos → la factura del proveedor queda en cuentas por
pagar con su vencimiento**. Además nace el **historial de precios** por
proveedor (la base de "te subieron el aceite 12%" en A3/A4).

## Decisiones de diseño

### D1. Estados de la OC (máquina simple, sin cadena de aprobación)

`draft` → `sent` → `partially_received` → `received`, más `canceled`
(solo desde draft/sent sin recepciones). Sin flujo de aprobación
multi-nivel: en un restaurante la arma quien compra y listo (YAGNI).
Práctica real: se puede **recibir directo desde draft** (muchos no marcan
"enviada") — recibir mueve el estado solo.

### D2. Se pide en presentaciones del proveedor; se guarda en unidad base

Nadie pide "150.000 g" — pide "3 bultos de 50 kg". La línea de OC referencia
la **presentación de la lista de precios** (`SupplierIngredient`) cuando
existe: el operador digita `# presentaciones` y el costo esperado se
precarga del último precio. También se puede pedir un insumo **sin**
presentación (cantidad directa en unidad de display + costo esperado
manual). Internamente TODO queda en unidad base (`qtyOrderedBase Int`),
consistente con A0/A1.

### D3. La recepción ES movimientos de inventario (sin modelo aparte)

Recibir genera movimientos `purchase_in` vía **`applyStockMovement`** (el
único camino de escritura de A1) con el costo REAL digitado — eso actualiza
existencias y costo promedio en la misma transacción. `StockMovement` gana
una FK opcional `purchaseOrderId`: el libro ya registra cada recepción
(cantidad, valor, quién, cuándo) — no se necesita un modelo
`PurchaseReception`. La línea acumula `receivedQtyBase` /
`receivedCostCents`; recepciones parciales hasta completar (se permite
sobre-recepción — pasa en la vida real). Estado recalculado al final de
cada recepción; al completarse → `receivedAt`.

### D4. Historial de precios (nace acá)

Modelo `SupplierPriceHistory` (por presentación de la lista de precios):

- **Al recibir**: si la línea tiene presentación, el precio real por
  presentación (`receivedCost / #presentaciones`) actualiza
  `SupplierIngredient.lastPriceCents` y appendea historia
  (`source: "reception"`, con la OC).
- **Edición manual** del precio en la lista de precios (ruta A0 existente,
  se extiende): appendea historia (`source: "manual"`).

Así A3 podrá alertar "el margen del plato X cayó porque subió el insumo Y".

### D5. CxP acotada a compras (la CxP general de gastos es B2)

En la propia OC: `supplierInvoiceNumber`, `invoiceDueAt` (default al
completar la recepción: `receivedAt + paymentTermsDays` del proveedor),
`paidAt` + `paymentNote`. Vista **"Por pagar"**: OCs recibidas no pagadas
ordenadas por vencimiento, vencidas resaltadas, total adeudado por
proveedor, y "marcar pagada". Sin asientos contables — eso llega con B2.

### D6. Envío al proveedor: WhatsApp + vista imprimible (sin PDF propio)

Los proveedores de los clientes viven en WhatsApp. "Enviar" ofrece:
**WhatsApp** (deep-link `wa.me` al teléfono del proveedor con el texto de
la orden: número, líneas con presentación y cantidad, notas — patrón de
links wa.me ya usado en CRM/proveedores) y **imprimir** (vista print-
friendly, infra de impresión existente). Cualquiera de las dos marca
`sent`. Email/PDF: si algún cliente lo pide (el mailer existe), no ahora.

### D7. Numeración por comercio

`number Int` consecutivo por restaurante (`@@unique([restaurantId,
number])`), asignado con max+1 dentro de la transacción de creación —
"OC-0007" legible para el proveedor.

### D8. Superficie: `/operator/compras`

Página propia (patrón de `/operator/inventario`), gate módulo `purchasing`
(que ya está activable — el item de nav "Compras" aparece junto a
Inventario). Dos tabs: **Órdenes** (lista con filtro por estado + crear +
detalle con recepción) y **Por pagar** (CxP).

## Modelo de datos (Prisma)

```prisma
enum PurchaseOrderStatus {
  draft
  sent
  partially_received
  received
  canceled
}

model PurchaseOrder {
  id           String              @id @default(cuid())
  restaurantId String
  restaurant   Restaurant          @relation(fields: [restaurantId], references: [id], onDelete: Cascade)
  supplierId   String
  supplier     Supplier            @relation(fields: [supplierId], references: [id], onDelete: Restrict)
  number       Int
  status       PurchaseOrderStatus @default(draft)
  notes        String?
  expectedAt   DateTime? // entrega esperada
  sentAt       DateTime?
  receivedAt   DateTime? // recepción COMPLETA
  canceledAt   DateTime?

  // CxP (D5)
  supplierInvoiceNumber String?
  invoiceDueAt          DateTime?
  paidAt                DateTime?
  paymentNote           String?

  createdById String?
  createdBy   User?    @relation("PurchaseOrderCreator", fields: [createdById], references: [id], onDelete: SetNull)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  items        PurchaseOrderItem[]
  movements    StockMovement[]
  priceHistory SupplierPriceHistory[]

  @@unique([restaurantId, number])
  @@index([restaurantId, status])
  @@index([restaurantId, invoiceDueAt])
}

model PurchaseOrderItem {
  id              String             @id @default(cuid())
  purchaseOrderId String
  purchaseOrder   PurchaseOrder      @relation(fields: [purchaseOrderId], references: [id], onDelete: Cascade)
  ingredientId    String
  ingredient      Ingredient         @relation(fields: [ingredientId], references: [id], onDelete: Restrict)
  supplierItemId  String?
  supplierItem    SupplierIngredient? @relation(fields: [supplierItemId], references: [id], onDelete: SetNull)

  // Pedido (D2): siempre en base; presentations solo si hay presentación.
  qtyOrderedBase    Int
  presentations     Int?
  expectedCostCents Int // costo total esperado de la línea

  // Acumulado por recepciones (D3).
  receivedQtyBase   Int @default(0)
  receivedCostCents Int @default(0)

  @@index([purchaseOrderId])
}

/// Historial de precios por presentación (D4).
model SupplierPriceHistory {
  id              String             @id @default(cuid())
  supplierItemId  String
  supplierItem    SupplierIngredient @relation(fields: [supplierItemId], references: [id], onDelete: Cascade)
  priceCents      Int // por presentación
  source          String // "reception" | "manual"
  purchaseOrderId String?
  purchaseOrder   PurchaseOrder?     @relation(fields: [purchaseOrderId], references: [id], onDelete: SetNull)
  createdAt       DateTime           @default(now())

  @@index([supplierItemId, createdAt])
}
```

Cambios a modelos existentes: `StockMovement.purchaseOrderId String?` (+
relación, SetNull) y back-relations en Restaurant / Supplier / Ingredient /
SupplierIngredient / User.

## Lógica central: `src/lib/erp/purchasing.ts`

- `createPurchaseOrder(tx, {...})`: consecutivo max+1, valida proveedor e
  insumos del comercio, líneas ≥1; si hay `supplierItemId` valida que la
  presentación sea del proveedor y deriva `qtyOrderedBase = presentations ×
  contentQty`.
- `receivePurchaseOrder(tx, { poId, lines: [{itemId, qtyBase, costCents}],
  createdById })`: estado válido (draft/sent/partially_received), por línea
  `applyStockMovement(purchase_in, costo real, purchaseOrderId)` + acumula
  en la línea; actualiza `lastPriceCents` + `SupplierPriceHistory` cuando
  aplica (D4); recalcula estado (todo recibido → `received` + `receivedAt`
  + `invoiceDueAt` default por condiciones del proveedor). Reclamo
  race-safe del estado (patrón del cierre de conteos).
- Sanity con tsx: derivación de qty por presentaciones, acumulados
  parciales, precio por presentación al recibir, transición de estados.

## API (gate `purchasing`, guard `getErpContext`)

```
GET  /api/operator/purchase-orders?status=&cursor=   → lista (20/pág)
POST /api/operator/purchase-orders                   → crear draft con líneas
GET  /api/operator/purchase-orders/[id]              → detalle (líneas + recepciones del libro)
PATCH /api/operator/purchase-orders/[id]             → editar draft (líneas/notas/expectedAt),
                                                       marcar sent, cancelar (sin recepciones),
                                                       CxP: invoice number / dueAt / marcar pagada
POST /api/operator/purchase-orders/[id]/receive      → recepción { lines: [...] }
```

La ruta A0 `PATCH /api/operator/supplier-items/[id]` se extiende: cambio de
`lastPriceCents` → appendea `SupplierPriceHistory(source:"manual")`.

## i18n

Extensión de `opErp` (es/en/pt, paridad): nav "Compras", estados, tabs,
formularios de OC y recepción, texto de la orden para WhatsApp, CxP
(vencimientos, pagada), errores. Glob nuevo a MIGRATED.

## Fuera de alcance (explícito)

OC sugerida automática por par levels (A4). Gastos generales / asientos
(B2). Devoluciones al proveedor (movimiento de ajuste manual cubre el caso
raro por ahora). Email/PDF de la orden. Multi-moneda por proveedor (usa la
del comercio).

## Entrega (5 PRs)

1. Schema (+ `StockMovement.purchaseOrderId`) + `src/lib/erp/purchasing.ts`
   + sanity tsx.
2. API completa (lista/crear/detalle/editar/recibir + hook de historial en
   supplier-items).
3. UI `/operator/compras`: tab Órdenes (lista + crear con líneas desde la
   lista de precios + detalle) + item de nav.
4. UI recepción (sheet por línea con cantidades/costos reales) + tab Por
   pagar (CxP) + envío WhatsApp/imprimir.
5. Verificación integral + smoke módulo on/off. (Sin flip: `purchasing` ya
   está shipped desde A0.5 — la página aparece sola para quien lo tenga.)

## Criterios de aceptación

1. OC-0001 a un proveedor con "3 × Bulto 50 kg" de la lista de precios →
   costo esperado precargado del último precio; WhatsApp abre con el texto
   de la orden; imprimir muestra la vista limpia.
2. Recepción parcial (1 bulto, costo real distinto) → stock +50.000 g al
   costo real, promedio recalculado, estado `partially_received`, precio
   del proveedor actualizado + historia `reception`.
3. Completar recepción → `received`, `invoiceDueAt` = recepción +
   condiciones del proveedor; aparece en "Por pagar"; vencida se resalta;
   "marcar pagada" la saca.
4. Cancelar solo sin recepciones; editar líneas solo en draft.
5. Módulo apagado → sin nav/página/API. Trilingüe en paridad.
