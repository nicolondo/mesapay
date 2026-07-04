# ERP Fase A0 · Fundaciones — insumos, unidades y proveedores

> Spec para aprobación antes de codear. Contexto general en
> `docs/roadmap-erp-modulos.md`. Fase 0 (framework `enabledModules`) ya
> está en producción (PR #205).

## Objetivo

Los catálogos base sobre los que se construye todo el track A: **insumos**
(materias primas), **unidades de medida con conversiones** y **proveedores**
con su lista de precios por insumo. **Sin stock todavía** — existencias y
movimientos son A1; órdenes de compra son A2.

Al cerrar A0, un comercio con el módulo activado puede dejar cargado su
catálogo completo (semanas de data-entry que conviene desbloquear temprano),
y las fases A1-A3 solo agregan comportamiento encima.

## Decisiones de diseño

### D1. Unidades: 3 dimensiones fijas + presentaciones (sin tabla Unit)

Cada insumo declara su **dimensión de medida** (`measureKind`):

| Dimensión | Unidad base (canónica) | Unidades de display |
|---|---|---|
| `mass` | gramo (g) | g, kg (×1000) |
| `volume` | mililitro (ml) | ml, l (×1000) |
| `count` | unidad (un) | un |

- **Todas las cantidades se guardan en `Int` en la unidad base** (g / ml /
  un). Sin decimales en DB, sin tabla `Unit`: las conversiones métricas son
  constantes universales y viven en `src/lib/erp/units.ts` (formateo
  incluido: 2500 g → "2,5 kg").
- Los **empaques de compra** ("caja × 24", "bulto 50 kg") NO son unidades:
  son **presentaciones** del proveedor — un label + contenido en unidad base
  (`SupplierIngredient.contentQty`). Así "compro cajas, consumo unidades"
  funciona sin un sistema de unidades configurable que nadie mantiene.
- Ejemplos: `Lomo de res` → mass (base g), bulto 5 kg = contentQty 5000.
  `Cerveza Corona 355ml` → count (base un), caja = contentQty 24. `Aceite`
  → volume (base ml), garrafa = contentQty 20000.
- Riesgo que esto elimina: el clásico "receta en oz, compra en lb, inventario
  en kg" — acá todo converge a la base y el display es cosmético.

### D2. Catálogos por comercio (no por grupo, todavía)

`Ingredient` y `Supplier` cuelgan de `restaurantId`, igual que menús. Los
grupos multi-sede que quieran catálogo compartido / bodega central se
resuelven en A5 (traslados) — hoy la inmensa mayoría de clientes son
comercios de 1-3 sedes con catálogos propios. Se evita sobre-diseñar.

### D3. Gateo por módulos

- Catálogo de **insumos**: visible si el comercio tiene `inventory` **o**
  `purchasing` **o** `recipes` (es la base de los tres).
- **Proveedores** (+ lista de precios): visible solo con `purchasing`.
- Enforcement **server-side en cada ruta API** (`isModuleEnabled`) + las
  cards de `/operator/settings` se ocultan cuando el módulo está apagado.
- Al cerrar A0 se flipa `purchasing.shipped = true` en `MODULE_CATALOG`:
  el admin puede activarlo y los comercios empiezan a cargar catálogo
  mientras se construyen A1/A2. (`inventory` y `recipes` siguen
  "próximamente".)

### D4. Sin borrado físico

`active: false` (soft-delete) en insumos y proveedores. A1-A4 van a
referenciarlos desde movimientos/recetas/OCs históricas; borrar filas
rompería trazabilidad. El delete de UI = desactivar (con undo barato:
reactivar). Filas sin referencias futuras podrán purgarse más adelante.

### D5. Precios en la lista del proveedor: manual en A0

`SupplierIngredient.lastPriceCents` lo digita el operador (precio por
presentación). En A2, la recepción de OCs lo actualiza automáticamente y ahí
nace el historial de precios (modelo `PriceHistory` llega en A2, no ahora).

## Modelo de datos (Prisma)

```prisma
enum MeasureKind {
  mass   // base: gramo
  volume // base: mililitro
  count  // base: unidad
}

/// Insumo / materia prima del comercio. Base de inventario (A1),
/// compras (A2) y recetas (A3). Cantidades SIEMPRE en unidad base
/// (g / ml / un) — ver src/lib/erp/units.ts.
model Ingredient {
  id           String      @id @default(cuid())
  restaurantId String
  restaurant   Restaurant  @relation(fields: [restaurantId], references: [id], onDelete: Cascade)
  name         String
  // Categoría libre ("Proteínas", "Lácteos", "Empaques"…). Datalist con
  // las existentes del comercio — sin taxonomía impuesta.
  category     String?
  measureKind  MeasureKind
  sku          String? // código interno opcional
  notes        String?
  active       Boolean     @default(true)
  createdAt    DateTime    @default(now())
  updatedAt    DateTime    @updatedAt

  supplierItems SupplierIngredient[]

  @@unique([restaurantId, name])
  @@index([restaurantId, active])
}

/// Proveedor del comercio.
model Supplier {
  id               String     @id @default(cuid())
  restaurantId     String
  restaurant       Restaurant @relation(fields: [restaurantId], references: [id], onDelete: Cascade)
  name             String
  taxId            String? // NIT / RFC
  contactName      String?
  phone            String? // E.164 — reusar normalizePhone del CRM
  email            String?
  address          String?
  paymentTermsDays Int?    // condiciones de pago (días); null = contado
  notes            String?
  active           Boolean    @default(true)
  createdAt        DateTime   @default(now())
  updatedAt        DateTime   @updatedAt

  items SupplierIngredient[]

  @@unique([restaurantId, name])
  @@index([restaurantId, active])
}

/// Lista de precios: qué insumos vende cada proveedor, en qué
/// presentación y a qué precio.
model SupplierIngredient {
  id           String     @id @default(cuid())
  supplierId   String
  supplier     Supplier   @relation(fields: [supplierId], references: [id], onDelete: Cascade)
  ingredientId String
  ingredient   Ingredient @relation(fields: [ingredientId], references: [id], onDelete: Cascade)

  // Presentación de compra: "Caja × 24", "Bulto 50 kg", "Garrafa 20 L".
  presentationLabel String
  // Contenido de UNA presentación en unidad base del insumo (g/ml/un).
  contentQty        Int
  // Último precio por presentación, en centavos. Manual en A0; la
  // recepción de OCs (A2) lo actualiza automáticamente.
  lastPriceCents    Int?
  supplierSku       String? // código del insumo en el catálogo del proveedor
  // Proveedor habitual de este insumo — lo usa la OC sugerida (A4).
  preferred         Boolean @default(false)

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([supplierId, ingredientId])
  @@index([ingredientId])
}
```

Derivado útil ya en A0: **costo por unidad base** = `lastPriceCents /
contentQty` (ej. bulto 5000 g a $80.000 → $16/g) — se muestra en la lista de
precios y es el insumo del costeo de recetas (A3).

## Superficies (operator)

Dos páginas nuevas + sus cards en `/operator/settings` (patrón `SettingCard`
existente, con contador como badge). Solo roles `operator` /
`platform_admin` (mesero/cocina/bar no ven nada).

### `/operator/settings/insumos`
- Lista con búsqueda (fuzzy sin acentos — helper existente), filtro por
  categoría y por activo/inactivo. Columnas: nombre, categoría, dimensión,
  # proveedores.
- Crear/editar en sheet (patrón usuarios/etiquetas): nombre, categoría
  (input + datalist), dimensión (3 opciones con ejemplo de unidad), SKU,
  notas. La dimensión queda **bloqueada** cuando el insumo ya tiene
  referencias (lista de precios hoy; movimientos/recetas mañana) — cambiarla
  corrompería cantidades históricas.
- Desactivar/reactivar inline.

### `/operator/settings/proveedores`
- Lista con búsqueda. Columnas: nombre, contacto, teléfono (con botón
  WhatsApp — patrón CRM), condiciones, # insumos.
- Crear/editar en sheet: datos básicos + condiciones de pago.
- Detalle del proveedor → **lista de precios**: filas SupplierIngredient
  (insumo, presentación, contenido, precio, costo/unidad base derivado,
  preferido ★). Agregar fila = combobox de insumos activos + presentación +
  contenido + precio. Marcar ★ preferido desmarca el ★ anterior del mismo
  insumo (máx. 1 por insumo).

## API

Todas con guard de rol + `isModuleEnabled` server-side (403 `module_disabled`
si el módulo está apagado — la UI no debería llegar ahí, defensa en
profundidad):

```
GET/POST   /api/operator/ingredients          (gate: inventory|purchasing|recipes)
PATCH/DELETE /api/operator/ingredients/[id]   (DELETE = active:false)
GET/POST   /api/operator/suppliers            (gate: purchasing)
PATCH/DELETE /api/operator/suppliers/[id]     (DELETE = active:false)
POST       /api/operator/suppliers/[id]/items (gate: purchasing)
PATCH/DELETE /api/operator/supplier-items/[id]
```

Validación zod: nombres 1-120 trim, `contentQty ≥ 1`, `lastPriceCents ≥ 0`,
`paymentTermsDays 0-365`, unicidad por comercio con error legible
(`name_taken`). Teléfono normalizado con el helper del CRM.

## i18n

Namespace nuevo **`opErp`** (compartido por todas las fases ERP) en
es/en/pt: labels de páginas, formularios, dimensiones ("Peso (g/kg)",
"Volumen (ml/L)", "Unidades"), errores. Paridad obligatoria + glob a
MIGRATED cuando las páginas queden completas.

## Fuera de alcance de A0 (explícito)

- Stock/existencias, movimientos, conteos (A1). Órdenes de compra, CxP,
  historial de precios (A2). Recetas (A3). Import CSV/AI de catálogos
  (follow-up si el data-entry duele). Catálogo compartido por grupo (A5).
- Auditoría por fila de catálogo: NO (ruido); igual que menú/platos.

## Entrega (PRs)

1. Schema (3 modelos + enum) + `src/lib/erp/units.ts` + `prisma generate`.
2. API insumos + API proveedores/lista de precios (con gates).
3. Página insumos + card en settings + i18n.
4. Página proveedores (+ lista de precios) + card + i18n.
5. Flip `purchasing.shipped = true` + verificación integral
   (tsc/eslint/paridad/build) + smoke con módulo on/off.

Cada PR verificado y mergeado por separado (workflow habitual).

## Criterios de aceptación

1. Comercio con módulos apagados: no ve cards ni páginas; API responde 403.
2. Con `purchasing` activado: carga insumos y proveedores, arma lista de
   precios con presentaciones, ve costo/unidad base derivado.
3. Dimensión bloqueada al existir referencias; desactivar nunca borra filas.
4. Trilingüe completo; paridad de catálogos intacta.
5. Nada del flujo actual (carta, pedidos, pagos) cambia para comercios con
   módulos apagados.
