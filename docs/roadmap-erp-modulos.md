# Roadmap ERP MESAPAY — de POS a gestión completa del negocio

> Aprobado el 2026-07-03. Este documento es el mapa maestro; cada fase se
> ejecuta con su propio spec (aprobado antes de codear) → plan → PRs.

## Requisito transversal: módulos activables por comercio

**Toda funcionalidad ERP nueva se activa/desactiva POR COMERCIO desde el
admin de plataforma** (patrón `enabledPaymentMethods` → `enabledModules`).
Razón de negocio: algunos comercios usarán su propio ERP (y solo necesitan
el POS + integración/exports), otros contratarán el módulo administrativo
completo de MESAPAY. Consecuencias:

- Cada módulo nace detrás de su toggle (default: apagado). Un comercio con
  el módulo apagado no ve ni una pantalla, ni un item de menú, ni un campo.
- El gateo por plan (Pro/Premium) se apoya en el mismo mecanismo: el admin
  decide qué módulos van con qué plan.
- Para los comercios con ERP propio: a futuro, API pública / webhooks /
  exports (ventas, cierres) para integrarse — fase aparte del track B.

Catálogo de módulos (slugs estables):
`inventory` · `purchasing` · `recipes` · `einvoicing` · `accounting` ·
`production` · `staff`.

## 1. Base existente sobre la que se construye

| Ya existe | Sirve para |
|---|---|
| `Group` + `LegalEntity` + multi-sucursal | Inventario/compras/contabilidad por sede y consolidado por grupo |
| `MenuItem` + modificadores | Punto de anclaje de las recetas |
| `Order`/`OrderItem`/`Payment` | Consumo automático de inventario y libro de ventas |
| `Shift` + `CashMovement` (cierre/arqueo) | Corte contable diario |
| `SimpleInvoice` + `InvoiceRequest` (DIAN settings, consecutivo) | Facturación electrónica: falta solo la emisión real |
| `PlanConfig` (tiers) | Gatear ERP por plan → argumento del tier Premium |
| Roles + `AuditEvent` | Permisos y trazabilidad |

## 2. Funcionalidades adicionales (no estaban en la lista original)

Imprescindibles:
1. **Gestión de proveedores** — prerequisito de órdenes de compra.
2. **Catálogo de insumos + unidades con conversiones** (compra en kg/caja,
   consumo en g/ml). La fundación de todo.
3. **Conteos físicos e inventario cíclico** — sin conteos + ajustes, el
   inventario teórico deja de ser confiable en semanas.
4. **Mermas y desperdicio** con motivo (vencido, dañado, error, cortesía).
5. **Costeo de recetas / food cost % / ingeniería de menú** (matriz
   popularidad × margen). El módulo que más plata le hace ganar al comercio.
6. **Gastos generales y CxP** con vencimientos → flujo de caja proyectado.
7. **P&L por sede** (ventas − CMV − gastos) + prime cost como KPI.
8. **Conciliación de pagos** — ventas Kushki vs. dispersiones al banco.

Segunda ola:
9. Producción / sub-recetas (batches, semi-elaborados).
10. Traslados entre sedes (bodega central de grupos).
11. Horarios de empleados + asistencia (costo laboral → prime cost).
12. Analytics comparativo entre sedes.

Deliberadamente FUERA (integrar, no construir):
- **Nómina** (liquidación, prestaciones, nómina electrónica DIAN).
- **Contabilidad de partida doble completa / NIIF** (ver decisión A).

## 3. Decisiones estratégicas

**A. Contabilidad: operativa adentro, fiscal afuera.** MESAPAY genera los
libros operativos (ventas, compras, gastos, P&L, CMV) y EXPORTA al software
del contador (Siigo/Alegra/World Office en CO; Contpaqi en MX) vía archivo o
API. No construimos libro mayor NIIF.

**B. Facturación electrónica vía proveedor tecnológico.** CO: PT autorizado
con API (Factus, Alegra API, Matías APIs…) que devuelve CUFE + XML + PDF.
MX: PAC (Facturama, SW Sapien) para CFDI 4.0. Abstracción `InvoiceProvider`
con mock/sandbox/producción (mismo patrón que Kushki).

**C. El inventario nunca bloquea la venta.** Consumo asíncrono al facturar.
Un error de inventario jamás tumba un pedido de comensal.

## 4. Fases

### Track A — Operación (secuencial)

- **A0 · Fundaciones** (~1 spec + 4-6 PRs): `Ingredient`, `Unit` +
  conversiones, `Supplier` + `SupplierIngredient`. Catálogos en
  `/operator/settings`. Sin stock todavía. La fase más crítica: acá se
  define el modelo de unidades.
- **A1 · Inventario core** (~5-7 PRs): `StockLevel` + `StockMovement`
  (libro inmutable: entrada, salida, ajuste, merma, traslado). Conteo físico
  con ajuste automático. Valorización a costo promedio ponderado.
- **A2 · Compras** (~5-7 PRs): `PurchaseOrder` → envío al proveedor
  (PDF/email) → recepción total/parcial (actualiza stock y costo) → factura
  del proveedor → CxP con vencimientos. Historial de precios.
- **A3 · Recetas + costeo** (~5-7 PRs): `Recipe`/`RecipeItem` ancladas a
  `MenuItem` (y modificadores), sub-recetas, % merma de preparación. Food
  cost en vivo, margen, ingeniería de menú. Alerta de margen por alza de
  insumo.
- **A4 · Consumo automático + reorden** (~4-6 PRs): job asíncrono descuenta
  al pagar la orden (`sale_consumption`). Par levels → avisos de reorden
  (push/email/banner) → OC sugerida en un clic. Teórico vs. conteo =
  desviación.
- **A5 · Producción de batches** (segunda ola, ~4 PRs chicos). Traslados
  entre sedes: DESCARTADOS por decisión de producto (2026-07-06).

### Track B — Fiscal/Financiero (paralelo, no depende de inventario)

- **B1 · Facturación electrónica real** (~5-8 PRs): `InvoiceProvider`
  (mock/PT), CO primero: numeración DIAN, CUFE/XML/PDF, nota crédito,
  contingencia. Conecta `InvoiceRequest`/`SimpleInvoice` existentes.
  MX/CFDI como segundo provider. Mayor valor comercial inmediato.
- **B2 · Libro operativo + P&L + export contable** (~4-6 PRs): `Expense`
  (categoría/centro de costo/sede, recurrentes), libro de ventas y compras,
  P&L mensual por sede y consolidado. Export CSV/Excel mapeable a
  Siigo/Alegra/Contpaqi. CMV real cuando A1-A4 estén vivos.
- **B3 · Conciliación de pagos** (~2-3 PRs): ventas vs. dispersiones
  (`WalletMovement`/`KushkiTransaction`) + comisiones.

### Track C — Personas (independiente)

- **C1 · Horarios + asistencia**: planificador semanal por rol/sede,
  check-in, costo laboral por turno → prime cost en B2.

## 5. Orden de ejecución

```
Fase 0 (prerequisito): framework de módulos activables (enabledModules)
Arranque:      B1 Facturación electrónica  +  A0 Fundaciones   (paralelo)
Luego:         A1 Inventario → A2 Compras → A3 Recetas/costeo
Luego:         A4 Consumo + reorden   +   B2 P&L/export        (paralelo)
Segunda ola:   B3 Conciliación · A5 Producción de batches · C1 Horarios
```

Por qué: B1 desbloquea ventas ya y no depende de nada. A0→A4 es cadena
estricta de dependencias. B2 da P&L apenas hay gastos+ventas y mejora solo
cuando el track A madura. Cada fase entrega valor usable por sí sola.

## 6. Ejecución

- Una fase = spec aprobado → plan → implementación con subagentes → PRs
  chicos con verificación (tsc/eslint/paridad i18n/build). Feature flag =
  el toggle del módulo.
- i18n trilingüe (es/en/pt) obligatorio en todas las superficies.
- Ritmo estimado: A0+B1 ≈ 3-4 semanas; A1→A4 ≈ 6-8 semanas más; B2/B3
  intercaladas. ERP core completo ≈ un trimestre.

## Pendientes de decisión (usuario)

- **Proveedor tecnológico DIAN para B1** (Factus / Alegra API / Matías /
  otro): define el contrato de la API y las credenciales sandbox.
- Mapeo módulos ↔ planes (qué módulo entra en qué tier).
