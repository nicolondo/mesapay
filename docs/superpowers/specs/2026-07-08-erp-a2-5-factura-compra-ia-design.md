# ERP Fase A2.5 · Órdenes de compra desde factura (lectura con IA)

> Spec para aprobación antes de codear. Extensión del módulo `purchasing`
> (A2, ya en producción). Decisiones del dueño (2026-07-08): al confirmar,
> un switch elige "solo borrador" vs "crear y recibir"; la IA detecta el
> proveedor y sugiere crear proveedor/insumos faltantes (nada se crea sin
> confirmación).

## Objetivo

Que el comercio suba el **PDF o la foto** de una factura de proveedor,
la **IA de Anthropic la lea** (visión, la infraestructura de
`src/lib/anthropic.ts` que ya lee cartas y RUT), MESAPAY **arme la orden
de compra en borrador para revisar**, el operador **ajuste lo que haga
falta** y **confirme** — creando la OC (y opcionalmente registrando la
recepción). La IA acelera el data-entry; no lo reemplaza a ciegas.

## Decisiones de diseño

### D1. La IA solo LEE — toda escritura pasa por confirmación

La extracción produce datos estructurados; NADA se persiste en el
catálogo (proveedor, insumos, OC, recepción) hasta que el operador
confirma en la pantalla de revisión. El total de la factura NO se
confía: los totales se **recomputan en el server** desde las líneas
confirmadas (enteros exactos, igual que A2).

### D2. Extracción: schema estricto + confianza por campo

Nuevo `PurchaseInvoiceExtraction` (zod, en anthropic.ts). Modelo:
`extractPurchaseInvoice(source)` (PDF `type:"document"` / imagen
`type:"image"`, mismo patrón que `extractMenuFromDocument`). Devuelve:

- **Proveedor**: `nit` (solo dígitos, null si no se ve), `name`.
- **Factura**: `supplierInvoiceNumber`, `issueDate` (YYYY-MM-DD | null).
- **Líneas**: `[{ description, quantity, unit (texto libre: "caja",
  "bulto 50kg", "und"), unitPriceCents, taxPct ("0"|"5"|"19"…),
  lineTotalCents, confidence 0-1 }]`.
- `currency` ("COP"|"MXN"), `notes`.

Todo en **centavos**. Campos con `confidence < 0.7` se resaltan en la UI.

### D3. Emparejamiento determinista (server, sin IA)

`matchInvoice(extraction, restaurantId)` (puro sobre datos precargados):

- **Proveedor**: por `nit` exacto, si no por nombre `fold`
  (accent-insensitive) contra `Supplier`. Resultado: `matched | suggest_create`.
- **Cada línea** contra los insumos del comercio (`Ingredient`) por
  nombre `fold` con similitud (incluye/igualdad de tokens): `matched` (con
  el `SupplierIngredient`/presentación si existe para ese proveedor) o
  `suggest_create` (marca "insumo nuevo").
- Presentación/`contentQty`: si el insumo emparejado tiene lista de
  precios para ese proveedor, se sugiere; si no, el operador la define en
  la revisión (misma UI que crear OC en A2).

### D4. Pantalla de revisión (patrón ComprasClient)

Sheet a pantalla completa: la **imagen/PDF original a un lado** y la
extracción editable al otro. Encabezado: proveedor (match / crear /
cambiar), número y fecha de factura. Cada línea: insumo (selector con
búsqueda + "crear insumo"), cantidad, presentación, precio unitario,
impuesto — precargados de la IA, con badge ámbar en los de baja
confianza. El operador edita/borra/agrega líneas. Total recomputado en
vivo (no el de la factura). Botón **descartar** (marca la carga
`discarded`).

### D5. Confirmación: switch borrador vs recibir

Al confirmar, un switch (default recordado por comercio):

- **Solo crear borrador**: `createPurchaseOrder` de A2 (draft).
- **Crear y recibir**: `createPurchaseOrder` + `receivePurchaseOrder`
  en una tx — suma inventario (`purchase_in`), actualiza
  `lastPriceCents`/historial de la lista del proveedor y genera la CxP
  (`invoiceDueAt = receivedAt + paymentTermsDays`).

La creación de proveedor/insumos nuevos (los marcados en la revisión)
ocurre en la MISMA transacción de la confirmación, antes de la OC.
Reusa toda la lógica de A2 — cero costeo/inventario nuevo.

### D6. Trazabilidad: `PurchaseInvoiceUpload`

```prisma
model PurchaseInvoiceUpload {
  id            String   @id @default(cuid())
  restaurantId  String
  restaurant    Restaurant @relation(fields: [restaurantId], references: [id], onDelete: Cascade)
  fileUrl       String   // imagen/PDF subido (evidencia)
  status        String   @default("pending") // pending | confirmed | discarded
  extraction    Json     // salida cruda de la IA (para reintentar/editar)
  purchaseOrderId String? // la OC creada al confirmar
  purchaseOrder   PurchaseOrder? @relation(fields: [purchaseOrderId], references: [id], onDelete: SetNull)
  createdById   String?
  createdBy     User?    @relation(fields: [createdById], references: [id], onDelete: SetNull)
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  @@index([restaurantId, status])
}
```

La imagen queda ligada a la OC (auditoría). Reintento: si la IA leyó
mal, la carga `pending` se re-abre y se edita sin re-subir.

## API (gate `purchasing`)

```
POST /api/operator/purchase-invoices          → multipart: file (PDF/imagen);
     sube + extrae + matchea → { uploadId, extraction, matches }
GET  /api/operator/purchase-invoices/[id]      → carga (para re-abrir)
POST /api/operator/purchase-invoices/[id]/confirm → { supplier (match|new),
     lines: [{ ingredient (match|new), qtyBase, presentation, expectedCostCents,... }],
     mode: "draft"|"receive", supplierInvoiceNumber, invoiceDueAt? }
     → crea proveedor/insumos nuevos + OC (+recepción) en tx; 201 { order }
DELETE /api/operator/purchase-invoices/[id]    → descartar
```

Límite de tamaño (mismo que uploads), timeout de la IA generoso,
validaciones de A2 (insumos del comercio, qty ≥ 1, líneas ≤ 200).

## Lógica central (pura, testeable)

- `matchInvoice(extraction, {suppliers, ingredients, priceList})` →
  proveedor + líneas emparejadas/sugeridas.
- `normalizeExtraction` — sanea la salida de la IA (centavos, recorta
  espacios, filtra líneas sin descripción/cantidad/precio).
- Sanity tsx: matching por NIT/nombre, líneas match/crear, totales
  recomputados exactos, líneas basura filtradas.

## i18n

Extensión de `opErp` (o `opCompras`): botón, pantalla de revisión,
badges de confianza, switch, errores de extracción. Trilingüe en paridad.

## Fuera de alcance (explícito)

Conciliación con la factura electrónica DIAN del proveedor. Varias
facturas en un archivo. Monedas fuera de COP/MXN. Aprendizaje de
correcciones (feedback loop). OCR de remisiones sin precio.

## Entrega (3 PRs)

1. Schema `PurchaseInvoiceUpload` + `extractPurchaseInvoice` (schema IA) +
   `matchInvoice`/`normalizeExtraction` + sanity tsx.
2. API (subir/extraer/confirmar/descartar) + pantalla de revisión — subagente.
3. Botón e integración en `/operator/compras` + verificación integral.

## Criterios de aceptación

1. Subir un PDF/foto de factura → la IA extrae proveedor y líneas; la
   pantalla de revisión los muestra con la imagen original al lado y los
   campos de baja confianza en ámbar.
2. Proveedor por NIT existente ⇒ emparejado; NIT nuevo ⇒ "crear
   proveedor". Línea con nombre parecido a un insumo ⇒ emparejada; sin
   match ⇒ "crear insumo".
3. Confirmar en modo "borrador" ⇒ OC draft con las líneas confirmadas;
   modo "recibir" ⇒ además inventario sumado, precios actualizados y CxP
   creada — consistente con el flujo manual de A2.
4. El total de la OC lo recomputa el server (no el de la factura); un
   número mal leído se corrige en la revisión antes de confirmar.
5. Descartar marca la carga `discarded`; reintentar re-abre la `pending`.
   Módulo apagado ⇒ sin botón, API 403. Trilingüe en paridad.
