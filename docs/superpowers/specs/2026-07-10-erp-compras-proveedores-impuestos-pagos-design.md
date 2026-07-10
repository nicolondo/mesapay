# ERP Compras · Proveedores/insumos inline, impuestos y pagos parciales

> Spec para aprobación antes de codear. Extiende el módulo `purchasing`
> (A2/A2.5, en producción) y toca el form de gastos (B2, Contabilidad).
> Decisiones del dueño (2026-07-10): IVA de compras **configurable por
> comercio** (default: entra al costo); pagos parciales con **historial
> de abonos**.

## Objetivo

Cinco mejoras pedidas, agrupadas por afinidad:

1. **Crear proveedor inline** desde el form de gastos y desde crear OC.
2. **Crear insumo inline** desde crear OC.
3. **Pagos parciales (abonos)** de OC con saldo e historial.
4. **Claridad emparejado/nuevo** al leer una factura con IA.
5. **Impuestos (IVA)** en las facturas/OC de compra + validación de que
   lo calculado concuerda con lo que leyó la IA.

## Estado actual (verificado en código)

- `Expense.supplierId` ya existe (opcional). `POST /api/operator/suppliers`
  y `POST /api/operator/ingredients` ya existen. Falta el **UI inline**.
- `NewOrderSheet` (crear OC) solo elige proveedor/insumos **existentes**.
- CxP hoy es binaria: `PurchaseOrder.paidAt` + `paymentNote` (pagada o no).
- El review de factura-IA ya distingue `matched`/`suggest_create` por
  proveedor y línea — falta **mostrarlo claro**.
- `PurchaseOrderItem` **no guarda IVA**; `expectedCostCents`/
  `receivedCostCents` son el costo total de la línea, sin desglose.

---

## F1+F2 · Crear proveedor e insumo inline

Backend ya soporta ambos (POST /suppliers, POST /ingredients). Solo UI +
wiring. **Creación eager** (son entradas legítimas del catálogo).

- **Proveedor inline** (mini-form: nombre req., NIT opc., plazo de pago
  opc.) en: (a) el form de gasto de `ContabilidadClient`, junto al
  selector de proveedor; (b) el selector de proveedor de `NewOrderSheet`.
  Al crear ⇒ POST /suppliers ⇒ queda seleccionado. En `NewOrderSheet` un
  proveedor nuevo arranca sin lista de precios (se agregan líneas normal).
- **Insumo inline** (mini-form: nombre, tipo de medida mass/volume/count,
  categoría opc.) en el editor de líneas de `NewOrderSheet`. Al crear ⇒
  POST /ingredients ⇒ se agrega como línea. Reusa el patrón del review de
  factura-IA (que ya crea insumos).

Sin cambios de schema ni de contratos API.

---

## F4 · Claridad emparejado/nuevo en factura-IA

Solo UI en `InvoiceReviewSheet` (el dato ya existe: `kind: "matched" |
"suggest_create"`).

- Chip por **proveedor** y por **cada línea**: verde **"Ya existe"** (con
  el nombre del match) vs ámbar **"Se creará"**.
- Resumen arriba del sheet: "N insumos ya existen · M se crearán · P
  proveedor nuevo". Que el operador vea de un vistazo qué va a crear.

---

## F5 · Impuestos (IVA) de compras

### Modelo

- **Ajuste por comercio**: `Restaurant.purchaseIvaDeductible Boolean
  @default(false)`. `false` (default) ⇒ el IVA **entra al costo de
  inventario** (lo que pagás). `true` ⇒ el costo de inventario es el
  **neto**; el IVA se registra aparte (descontable). En ambos casos se
  desglosa subtotal + IVA + total.
- **Por línea**: `PurchaseOrderItem.taxPct Int @default(0)` — IVA % de la
  línea. Tarifas válidas por país (CO: 0/5/19; MX: 0/8/16) — helper
  `purchaseTaxRates(country)`; el picker de la UI las ofrece.
- **Semántica de costos** (retrocompatible): `expectedCostCents` y
  `receivedCostCents` pasan a ser el **NETO** (sin IVA) de la línea. Las
  filas viejas tienen `taxPct = 0` ⇒ neto = bruto (nada cambia).

### Lógica pura — `src/lib/erp/purchaseTax.ts`

```ts
lineTaxCents(netCents, taxPct)   // round(net * pct / 100)
lineGrossCents(netCents, taxPct) // net + IVA
poTotals(items) → { subtotalCents, taxCents, totalCents } // Σ neto / IVA / bruto
inventoryCostCents(netCents, taxPct, deductible) // deductible ? net : gross
purchaseTaxRates(country) → number[]             // CO 0/5/19, MX 0/8/16
```

### Recepción e inventario

Al recibir, el valor que entra al ledger =
`inventoryCostCents(netRecibido, item.taxPct, restaurant.purchaseIvaDeductible)`.
`receivedCostCents` guarda el **neto**; el IVA/bruto se derivan. La CxP y
los pagos usan el **bruto** (Σ line gross). `taxPct` se fija al crear/
editar la OC (no cambia en la recepción; el neto sí puede cambiar si el
precio varió).

### Factura-IA: cálculo + concordancia

- Extender `extractPurchaseInvoice` para leer también los totales
  **impresos** de la factura: `invoiceSubtotalCents`, `invoiceTaxCents`,
  `invoiceTotalCents` (nullable). El `taxPct` por línea ya se lee.
- El review muestra por línea: neto, IVA % (editable), IVA $, bruto; y
  al pie el **subtotal + IVA + total calculados** desde las líneas.
- **Concordancia**: compara el total calculado vs el total impreso que
  leyó la IA. Si difieren más que la tolerancia (redondeo: > $100 o > 1%),
  aviso ámbar "El total calculado ($X) no coincide con el de la factura
  ($Y) — revisá las líneas". **No bloquea** — el operador confirma.
- Al confirmar, `taxPct` viaja por línea y se persiste en el
  `PurchaseOrderItem`.

### UI

`taxPct` (picker por país) + desglose subtotal/IVA/total en:
`NewOrderSheet`, `InvoiceReviewSheet`, detalle de OC y la fila de CxP.
Ajuste `purchaseIvaDeductible` en los settings de Compras.

---

## F3 · Pagos parciales (abonos con historial)

### Schema

```prisma
model PurchasePayment {
  id              String   @id @default(cuid())
  restaurantId    String
  restaurant      Restaurant    @relation(...)
  purchaseOrderId String
  purchaseOrder   PurchaseOrder @relation(...)
  amountCents     Int
  paidAt          DateTime      // fecha del abono (editable)
  method          String?       // efectivo / transferencia / … (libre)
  note            String?
  createdById     String?
  createdBy       User?         @relation(...)
  createdAt       DateTime @default(now())
  @@index([purchaseOrderId])
  @@index([restaurantId, paidAt])
}
```

En `PurchaseOrder`: `paidCents Int @default(0)` (cache mantenido en la tx).
Se conserva `paidAt` (se setea cuando el saldo llega a 0) y `paymentNote`
(compat).

### API (gate `purchasing`)

```
POST   /api/operator/purchase-orders/[id]/payments
       { amountCents (>0, ≤ saldo), paidAt?, method?, note? }
       → tx: crea PurchasePayment; paidCents += amount; si
         paidCents ≥ totalBruto ⇒ paidAt = fecha del abono. 201
DELETE /api/operator/purchase-orders/[id]/payments/[paymentId]
       → reversa: paidCents -= amount; si < total ⇒ paidAt = null
GET    /api/operator/purchase-orders/[id]  → incluye payments[] + saldo
```

Total bruto de la OC = Σ `lineGross(receivedCostCents, taxPct)` de los
ítems recibidos. Rechaza abono > saldo (400); la UI prellena el saldo.

### UI (tab "Por pagar")

Cada OC muestra **total · pagado · saldo** y badge de estado
(pendiente / parcial / pagada / vencida). "Registrar pago" (prellena el
saldo, permite parcial) + historial de abonos (fecha, monto, método,
borrar). "Pagar saldo" es el atajo a un abono por el total pendiente.

---

## Entrega (4 PRs, en orden)

1. **Crear proveedor + insumo inline** (F1+F2): `ContabilidadClient`
   (gasto) + `NewOrderSheet` (proveedor e insumo). Reusa APIs. Sin schema.
2. **Claridad emparejado/nuevo** (F4): chips + resumen en
   `InvoiceReviewSheet`. UI-only.
3. **Impuestos de compras** (F5): schema (`taxPct`,
   `purchaseIvaDeductible`) + `purchaseTax.ts` + recepción/confirm/
   extracción + validación de concordancia + UI. Sanity tsx.
4. **Pagos parciales** (F3): schema (`PurchasePayment`, `paidCents`) +
   API de abonos + UI de CxP. Usa el total bruto de la PR 3.

Orden: F5 antes que F3 (el saldo usa el total con IVA). F1/F2/F4 son
independientes y rápidas (primero, valor inmediato). Migración por `db
push`: todo aditivo (columnas nuevas nullable/@default y tabla nueva),
sin pérdida de datos.

## i18n

Todo texto nuevo trilingüe (es fuente, paridad es/en/pt): mini-forms de
crear proveedor/insumo, chips emparejado/nuevo, columna IVA + desglose,
aviso de concordancia, abonos/saldo/estado. Money con `formatMoney`.

## Fuera de alcance (explícito)

Retención en la fuente / ReteIVA / ReteICA (retenciones); cuentas
contables formales del IVA descontable (solo se separa el monto, no hay
plan de cuentas); conciliación con la factura electrónica DIAN del
proveedor; múltiples monedas por factura; pagos que cruzan varias OC en
una sola transacción.

## Criterios de aceptación

1. Desde el form de gasto y desde crear OC se puede crear un proveedor sin
   salir del flujo; desde crear OC, también un insumo.
2. En el review de factura-IA se ve, por proveedor y por línea, si "ya
   existe" (con nombre) o "se creará".
3. Una OC calcula subtotal + IVA + total según el `taxPct` de sus líneas;
   con `purchaseIvaDeductible=false` el inventario se valora al bruto, con
   `true` al neto. Filas viejas (taxPct 0) no cambian.
4. Al importar una factura, si el total calculado no concuerda con el
   impreso que leyó la IA, sale un aviso (no bloquea).
5. Una OC recibida acepta abonos parciales; muestra saldo y se marca
   "pagada" sola cuando el saldo llega a 0; el historial de abonos queda.
6. Trilingüe en paridad; tsc/eslint/build verdes.
