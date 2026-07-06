# ERP Fase A3 · Recetas y costeo — food cost, márgenes e ingeniería de menú

> Spec para aprobación antes de codear. Roadmap: `docs/roadmap-erp-modulos.md`.
> Depende de A0 (insumos/proveedores), A1 (inventario con costo promedio) y
> A2 (compras/precios), todas en producción.

## Objetivo

Que cada plato sepa **cuánto cuesta hacerlo y cuánto deja**: receta por
plato (insumos + cantidades + merma de preparación), **food cost en vivo**
calculado con los costos reales del inventario, margen contra el precio de
carta, y la **matriz de ingeniería de menú** (popularidad × margen) para
decidir precios y carta. Es también el prerequisito del consumo automático
por venta (A4): sin receta no hay descuento de inventario.

## Decisiones de diseño

### D1. Una receta por plato; sub-recetas ancladas a un insumo

`Recipe` tiene DOS anclas posibles (exactamente una):

- **Plato** (`menuItemId`, 1:1): la receta del plato de la carta.
- **Sub-receta** (`outputIngredientId`, 1:1 + `outputQtyBase`): la receta de
  un **insumo elaborado** (salsa de la casa, masa madre) con su rendimiento
  ("esta preparación rinde 2000 ml"). El semi-elaborado ES un insumo normal
  de A0 — puede estar en recetas de platos, tener stock, contarse, etc.
  El costo derivado por unidad base = costo de la receta / rendimiento.

Producir batches de sub-recetas (mover inventario) es A5; en A3 la
sub-receta existe para COSTEO y para que A4 pueda explotar el consumo.

### D2. Merma de preparación por línea (rendimiento del insumo)

`RecipeItem.wastePct` (0-90%): la cantidad de la línea es lo NETO que llega
al plato; el costo usa lo BRUTO — `bruto = neto / (1 − merma%)`. Ejemplo:
180 g netos de lomo con 20% de merma de limpieza cuestan como 225 g. Es la
diferencia entre un food cost de juguete y uno real.

### D3. Costo del insumo: cascada de fuentes, todo derivado en vivo

Para cada insumo, el costo por unidad base se resuelve en este orden:

1. **Costo promedio del inventario** (`StockLevel` con qty > 0) — el real.
2. **Sub-receta** (si el insumo tiene receta): costo recursivo / rendimiento.
3. **Precio del proveedor preferido** (lista de precios A0):
   `lastPriceCents / contentQty` — para comercios que aún no mueven stock.
4. **Sin costo** → la línea (y el plato) se marca "costo incompleto" en vez
   de mentir con $0.

NADA se persiste: el food cost se calcula al leer (cartas de decenas de
platos — barato). Recursión de sub-recetas con tope de profundidad 3 y
detección de ciclos (una sub-receta no puede contenerse a sí misma).

### D4. Ingeniería de menú (matriz popularidad × margen)

Sobre los últimos N días (default 30, seleccionable 7/30/90): popularidad =
unidades vendidas por plato (`OrderItem.qty` de órdenes pagadas), margen $ =
`MenuItem.priceCents − costo de receta` actual. Umbrales estándar:
popularidad ≥ 70% del promedio de unidades por plato; margen ≥ promedio.
Cuatro cuadrantes con acciones sugeridas (texto estático i18n):

| | Margen alto | Margen bajo |
|---|---|---|
| **Popular** | ⭐ Estrella — protegela | 🐎 Caballito — subile precio o bajale costo |
| **Poco vendido** | 🧩 Incógnita — promocionala | 🐕 Perro — repensala o sacala |

Platos sin receta o sin ventas quedan en una lista aparte "sin datos" — la
matriz solo muestra lo comparable. Vista como listas agrupadas por
cuadrante (mobile-first), no chart.

### D5. Modificadores: FUERA de A3 (explícito)

Los modificadores viven como JSON en `MenuItem.modifiers` (no como filas) —
anclarles recetas requiere su propio diseño (¿receta por opción?, ¿cómo
sobrevive a ediciones del JSON?). A3 costea el plato BASE. El costo de
adiciones se pierde por ahora; documentado como mejora futura junto con A4
(el consumo tampoco explota modificadores hasta entonces).

### D6. Superficie: `/operator/recetas`

Página propia (patrón inventario/compras), gate módulo `recipes`, item de
nav "Recetas". Tres tabs:

1. **Platos** — la carta con: precio, costo de receta (o "sin receta" /
   "costo incompleto"), **food cost %** (semáforo: ≤30% ok, 30-40% atención,
   >40% rojo — umbrales estándar de industria, fijos en A3) y margen $.
   Búsqueda + filtro por categoría. Tap → editor de receta (sheet): líneas
   insumo + cantidad neta (unidades display, `toBaseQty`) + merma % +
   costo de línea derivado en vivo; total, food cost y margen actualizándose
   al editar. Guardar = reemplazo completo de la receta (PUT).
2. **Sub-recetas** — insumos con receta: crear (elegir insumo output +
   rendimiento + líneas), editar, borrar. Muestra costo derivado por unidad
   base vs. costo actual de inventario del insumo.
3. **Ingeniería** — la matriz D4 con selector de período.

### D7. Flip al cierre

`recipes.shipped = true` al final (PR 5): el admin lo activa por comercio y
aparecen nav + página. Nota comercial: recetas requiere el catálogo de
insumos (A0) — el flujo natural es activar compras/inventario primero,
pero técnicamente basta `recipes` (el catálogo de insumos ya es visible
con cualquiera de los tres módulos).

## Modelo de datos (Prisma)

```prisma
/// Receta de un plato (menuItemId) O de un insumo elaborado
/// (outputIngredientId + rendimiento). Exactamente una ancla (lo valida
/// la API; en DB ambas columnas son únicas y opcionales).
model Recipe {
  id           String     @id @default(cuid())
  restaurantId String
  restaurant   Restaurant @relation(fields: [restaurantId], references: [id], onDelete: Cascade)

  menuItemId String?   @unique
  menuItem   MenuItem? @relation(fields: [menuItemId], references: [id], onDelete: Cascade)

  outputIngredientId String?     @unique
  outputIngredient   Ingredient? @relation("IngredientRecipe", fields: [outputIngredientId], references: [id], onDelete: Cascade)
  outputQtyBase      Int? // rendimiento del batch (solo sub-receta)

  notes     String?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  items RecipeItem[]

  @@index([restaurantId])
}

model RecipeItem {
  id           String     @id @default(cuid())
  recipeId     String
  recipe       Recipe     @relation(fields: [recipeId], references: [id], onDelete: Cascade)
  ingredientId String
  ingredient   Ingredient @relation(fields: [ingredientId], references: [id], onDelete: Restrict)

  /// Cantidad NETA al plato, en unidad base del insumo.
  qtyBase  Int
  /// Merma de preparación 0-90 (%). Costo usa bruto = neto / (1 − merma).
  wastePct Int @default(0)

  @@unique([recipeId, ingredientId])
}
```

Back-relations: `MenuItem.recipe Recipe?`, `Ingredient.recipe Recipe?`
("IngredientRecipe") + `Ingredient.recipeItems RecipeItem[]`,
`Restaurant.recipes Recipe[]`.

## Lógica central: `src/lib/erp/recipes.ts` (pura, testeable)

- `grossQty(qtyBase, wastePct)` = `qtyBase / (1 − wastePct/100)` (float solo
  para costeo, redondeado en centavos al final).
- `resolveIngredientCost(ctx, ingredientId, depth)`: cascada D3 con memo,
  tope 3, ciclo → "incomplete".
- `recipeCost(ctx, recipe)`: Σ `grossQty × costPerBase`; devuelve
  `{ costCents, complete: boolean, breakdown: por línea }`.
- `engineeringQuadrant(popularity, margin, popThreshold, marginThreshold)`.
- Sanity con tsx contra los criterios de aceptación.

## API (gate `recipes`, guard `getErpContext`)

```
GET  /api/operator/recipes             → platos activos (precio, receta?,
                                         costo/completo/food cost/margen) +
                                         sub-recetas con costo derivado
PUT  /api/operator/recipes/dish/[menuItemId]   → upsert receta del plato
     { items: [{ingredientId, qtyBase, wastePct}], notes? }   (items [] = borrar)
PUT  /api/operator/recipes/sub/[ingredientId]  → upsert sub-receta
     { outputQtyBase, items: [...], notes? }   · DELETE → borrar
     (409 recipe_cycle si se referencia a sí misma directa/indirectamente;
      400 ingredient_in_own_recipe)
GET  /api/operator/menu-engineering?days=30    → matriz D4
```

Validaciones: insumos del comercio y activos, qtyBase ≥ 1, wastePct 0-90,
menuItem del comercio, máx. 100 líneas por receta.

## i18n

Extensión de `opErp` (es/en/pt): nav "Recetas", tabs, editor, semáforo de
food cost, cuadrantes con acciones sugeridas, errores. Glob a MIGRATED.

## Fuera de alcance (explícito)

Modificadores con receta (D5). Consumo automático por venta y alertas de
margen (A4 — las alertas de "subió el insumo X" necesitan la línea de
tiempo de costos que A4 formaliza). Producción de batches (A5). Escalado
de recetas / porciones múltiples (una receta = una porción del plato).

## Entrega (5 PRs)

1. Schema + `src/lib/erp/recipes.ts` + sanity tsx.
2. API (recipes CRUD dish/sub + engineering).
3. UI tab Platos (lista con food cost + editor de receta) + nav — subagente.
4. UI tabs Sub-recetas + Ingeniería — subagente.
5. Flip `recipes.shipped = true` + verificación integral.

## Criterios de aceptación

1. Plato $38.000 con receta: 180 g lomo (merma 20%, costo $16/g → bruto
   225 g = $3.600 — ejemplo ilustrativo con promedio real de inventario),
   más líneas → costo total, **food cost %** y margen visibles en vivo; al
   cambiar una cantidad el costo se actualiza sin guardar.
2. Sub-receta "Salsa casa" (rinde 2000 ml) usada dentro de un plato: el
   costo de la línea sale del costo derivado de la sub-receta cuando el
   insumo no tiene promedio de inventario.
3. Insumo sin ninguna fuente de costo → plato marcado "costo incompleto"
   (no $0 mentiroso).
4. Ingeniería 30 días: platos clasificados en 4 cuadrantes con los umbrales
   D4; sin receta o sin ventas → lista "sin datos".
5. Ciclos de sub-recetas rechazados (409). Módulo apagado → sin nav/página
   (404) / API 403. Trilingüe en paridad.
