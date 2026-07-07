# ERP Fase B2 · Libro operativo, gastos, P&L y export contable

> Spec para aprobación antes de codear. Roadmap: `docs/roadmap-erp-modulos.md`.
> Usa las ventas (Orders/Payments), las compras (A2) y el CMV real del
> ledger de inventario (A4). Módulo nuevo: `accounting` (ya existe el slug
> con `shipped: false`).

## Objetivo

Que el comercio sepa **cuánto ganó de verdad cada mes** sin salir de
MESAPAY: registro de **gastos** (con recurrentes tipo arriendo/nómina),
**P&L mensual** por sede y consolidado de grupo (ingresos − CMV real −
mermas − gastos), y **libros de ventas y compras** exportables a CSV para
entregarle al contador (mapeable a Siigo/Alegra/Contpaqi).

## Decisiones de diseño

### D1. Superficie: `/operator/contabilidad` (módulo `accounting`)

Página propia (patrón inventario/compras/recetas): gate estricto del
módulo + item de nav "Contabilidad". Tres tabs: **Gastos** / **P&L** /
**Libros**. Flip de `accounting.shipped = true` al cierre (último PR).
Consolidado de grupo: página `/group/pnl` para `group_admin` (D4).

### D2. Gastos: modelo simple, categoría libre, recurrentes por cron

`Expense`: categoría **libre con datalist** (mismo criterio que
`Ingredient.category` — sin plan de cuentas impuesto; el comercio escribe
"Arriendo", "Nómina", "Servicios públicos" y la UI sugiere las
existentes), monto en centavos, **fecha del gasto** (editable, no
`createdAt`), descripción y proveedor (opcional, del catálogo A0).

**Recurrentes**: un gasto puede marcarse plantilla (`recurring: true` +
`recurringDay` 1-28). El cron diario `POST /api/cron/recurring-expenses`
(patrón x-cron-secret) materializa cada plantilla como gasto normal del
mes cuando llega su día — idempotente: la copia lleva `templateId` y no
se re-crea si ya existe una del mismo mes. Editar/borrar la plantilla no
toca las copias ya materializadas.

```prisma
model Expense {
  id           String     @id @default(cuid())
  restaurantId String
  restaurant   Restaurant @relation(fields: [restaurantId], references: [id], onDelete: Cascade)

  category    String
  description String?
  amountCents Int
  date        DateTime // fecha contable del gasto
  supplierId  String?
  supplier    Supplier? @relation(fields: [supplierId], references: [id], onDelete: SetNull)

  // Plantilla mensual: el cron la materializa como copia con templateId.
  recurring    Boolean @default(false)
  recurringDay Int?

  templateId String?
  template   Expense?  @relation("ExpenseTemplate", fields: [templateId], references: [id], onDelete: SetNull)
  copies     Expense[] @relation("ExpenseTemplate")

  createdById String?
  createdBy   User?   @relation("ExpenseCreator", fields: [createdById], references: [id], onDelete: SetNull)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@index([restaurantId, date])
  @@index([restaurantId, recurring])
}
```

### D3. P&L mensual: derivado en vivo, enteros exactos

Selector de mes (default actual). Todo se calcula al leer — nada
persistido (regla A3/A4). Estructura:

| Línea | Fuente |
|---|---|
| **Ingresos por ventas** | Σ `subtotalCents` de órdenes con `paidAt` en el mes |
| Propinas (informativo, no ingreso) | Σ `tipCents` — pasan al equipo |
| Impuestos recaudados (informativo) | Σ `taxCents` (hoy casi siempre 0; el IVA formal llega con B1) |
| **− CMV (consumo real)** | Σ \|`valueCents`\| de `sale_consumption` del mes (ledger A4) |
| **− Mermas** | Σ \|`valueCents`\| de `waste` del mes |
| **= Margen bruto** | ingresos − CMV − mermas (+ %) |
| **− Gastos** | Σ `Expense` del mes, desglosado por categoría |
| **= Utilidad operativa** | margen bruto − gastos (+ % sobre ingresos) |
| Compras recibidas (informativo) | Σ recibido de OCs con `receivedAt` en el mes — contexto de caja, NO entra al resultado (el costo entra vía CMV) |

Sin datos de consumo en el mes pero con compras > 0 → hint "activa
inventario + recetas para CMV real" (nunca usar compras como CMV
disfrazado). El costo laboral se suma cuando exista C1 (prime cost) —
fuera de B2.

### D4. Consolidado de grupo: `/group/pnl`

Para `group_admin` (layout /group existente): mismo P&L sumando las sedes
del grupo **con módulo `accounting` activo** + tabla por sede (ingresos,
CMV, gastos, utilidad); las sedes con el módulo apagado se listan como
"módulo apagado" sin números. Selector de mes. Multi-moneda: si el grupo
mezcla países, se agrupa por moneda (sin conversión — honesto y simple);
el caso normal es un solo país.

### D5. Libros de ventas y compras + export CSV

Tab **Libros** con sub-vista Ventas / Compras y selector de mes:

- **Ventas**: filas = órdenes pagadas (fecha, código, mesa/pickup,
  subtotal, propina, impuesto, total, métodos de pago de sus payments
  aprobados, # de factura simple si existe). Totales del mes + desglose
  por método de pago (efectivo/tarjeta/PSE/wallet — labels i18n por
  `PaymentMethod`).
- **Compras**: filas = OCs con `receivedAt` en el mes (fecha, número,
  proveedor, # factura del proveedor, total recibido, vencimiento CxP,
  estado de pago). Totales + saldo por pagar del mes.
- **Export CSV**: `GET /api/operator/accounting/export?book=sales|purchases|expenses&month=YYYY-MM`
  → `text/csv` descargable, UTF-8 **con BOM** (Excel muestra bien los
  acentos), separador coma, montos en unidades de moneda con punto
  decimal (no centavos), encabezados en el idioma del usuario. Columnas
  genéricas mapeables a Siigo/Alegra/Contpaqi — formatos propietarios de
  importación quedan fuera de B2 (documentado).

### D6. API (gate `accounting` vía getErpContext, salvo donde se indica)

```
GET    /api/operator/expenses?month=YYYY-MM     → gastos del mes + plantillas
POST   /api/operator/expenses                   → crear (gasto o plantilla)
PATCH  /api/operator/expenses/[id]              → editar
DELETE /api/operator/expenses/[id]              → borrar (plantilla: no toca copias)
GET    /api/operator/accounting/pnl?month=      → P&L D3 (JSON)
GET    /api/operator/accounting/books?book=sales|purchases&month=
GET    /api/operator/accounting/export?book=&month=   → CSV
POST   /api/cron/recurring-expenses             → materializa plantillas (CRON_SECRET)
GET    /api/group/pnl?month=                    → consolidado (auth group_admin)
```

Validaciones: amountCents ≥ 1, category 1-60 chars, date válida (rango
2020-2100), recurringDay 1-28 solo con recurring, supplier del comercio.

## Lógica central: `src/lib/erp/accounting.ts` (pura, testeable)

- `monthRange(month)` → [desde, hasta) en UTC.
- `buildPnl(inputs)`: recibe agregados ya consultados (ventas, consumo,
  mermas, gastos por categoría, compras) y arma la estructura D3 con
  márgenes — enteros exactos, % con 1 decimal.
- `toCsv(rows, headers)`: escaping RFC 4180 + BOM.
- `materializeRecurring(templates, existingCopies, today)`: decide qué
  plantillas tocan hoy y no tienen copia del mes (pura; el cron solo
  consulta y escribe).
- Sanity con tsx contra los criterios de aceptación.

## i18n

Extensión de `opErp` (es/en/pt): nav "Contabilidad", tabs, formulario de
gastos, líneas del P&L, libros, labels de métodos de pago, encabezados
CSV. Glob a MIGRATED. Paridad estricta.

## Fuera de alcance (explícito)

Plan de cuentas / PUC y formatos de importación propietarios
(Siigo/Alegra/Contpaqi) — el CSV genérico los cubre por ahora. IVA /
impoconsumo formal (B1). Costo laboral (C1). Conversión de moneda en el
consolidado. Adjuntos/fotos de facturas de gasto. Flujo de caja
proyectado.

## Entrega (5 PRs)

1. Schema `Expense` + `src/lib/erp/accounting.ts` + cron recurrentes + sanity tsx.
2. API: expenses CRUD + pnl + books + export CSV + group pnl.
3. UI `/operator/contabilidad` tab Gastos + nav — subagente.
4. UI tabs P&L + Libros (con export) + `/group/pnl` — subagente.
5. Flip `accounting.shipped = true` + verificación integral.

## Criterios de aceptación

1. Gasto normal aparece en su mes; plantilla (arriendo, día 1) se
   materializa UNA vez por mes aunque el cron corra N veces; editar la
   plantilla no altera copias pasadas.
2. P&L de un mes con: ventas $10.000.000 (subtotales), consumo $3.200.000,
   mermas $150.000, gastos $4.000.000 → margen bruto $6.650.000 (66,5%) y
   utilidad $2.650.000 (26,5%) — enteros exactos, propinas aparte.
3. Libro de ventas cuadra: Σ filas = totales del mes; desglose por método
   suma lo mismo; export CSV abre en Excel con acentos correctos (BOM) y
   los montos suman igual que la vista.
4. Libro de compras muestra recibido/por pagar del mes consistente con
   la vista "Por pagar" de A2.
5. `/group/pnl` suma solo sedes con el módulo activo; sedes apagadas
   listadas sin números; grupos multi-moneda agrupan por moneda.
6. Módulo apagado → sin nav, página 404, API 403. Trilingüe en paridad.
