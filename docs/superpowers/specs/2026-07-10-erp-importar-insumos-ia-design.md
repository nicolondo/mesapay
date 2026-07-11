# ERP · Importar insumos con IA (inventario inicial valorado)

> Spec para aprobación antes de codear. Extiende el módulo `inventory`
> (A1). Decisiones del dueño (2026-07-10): ambos formatos (foto/PDF +
> Excel/CSV); catálogo + stock inicial + costo (inventario valorado); la
> IA auto-categoriza; extrae la unidad del nombre y la quita; regla del
> alcohol (750 ml = botella, no volumen); campo de instrucciones libres
> para guiar a la IA.

## Objetivo

Que el comercio suba un archivo con sus insumos —**foto/PDF** de una lista
o planilla, o **Excel/CSV** exportado de otro sistema— y la IA lo lea,
**limpie los nombres**, **infiera la unidad de medida y la categoría**, y
arme una **tabla de revisión compacta y editable**. Al confirmar, se
**crean los insumos** y se **siembra el inventario inicial valorado**
(cantidad × costo). Eficiente en espacio: puede ser mucha data.

## Decisiones de diseño

### D1. Fuente unificada → la IA razona sobre el contenido

- **Imagen/PDF** → content block de visión (mismo patrón que A2.5).
- **CSV** → se manda como texto.
- **XLSX** → se convierte la primera hoja a texto/CSV con **SheetJS
  (`xlsx`)** y se manda como texto. *(Nueva dependencia — liviana, estándar.)*
- Junto al contenido va el texto de **instrucciones libres** del operador.

### D2. Extracción — `extractInventoryImport(source, instructions)` (anthropic.ts)

Schema (zod) por fila:

```
{
  name: string,                 // nombre LIMPIO (sin la unidad/tamaño)
  measureKind: "mass"|"volume"|"count",
  category: string | null,      // la IA sugiere
  quantity: number | null,      // existencia inicial (en `unit`)
  unit: string | null,          // unidad tal cual ("kg","g","L","ml","botella","und","caja")
  unitPriceCents: number | null,// costo unitario (para valorar), en CENTAVOS
  presentationNote: string | null, // "botella 750 ml", "bulto 25 kg" — informativo
  confidence: number            // 0..1
}
```
+ nivel documento: `currency` ("COP"|"MXN"|"unknown"), `notes`.

**Reglas del prompt:**
- **Limpiar el nombre**: si el nombre trae la unidad/tamaño ("Harina
  25kg", "Aceite 1L"), extraer la medida y **quitarla del nombre**
  (name="Harina"); la medida va a `unit`/`presentationNote`.
- **measureKind**: masa (kg/g/lb) → `mass`; volumen (L/ml/cc) → `volume`;
  conteo (und/botella/caja/bulto/paquete/lata) → `count`.
- **Regla del alcohol / embotellados** (crítica): si el producto es una
  **bebida/licor embotellado** y el nombre dice "750 ml" / "1 L" / etc.,
  eso **NO es la unidad de medida** — es una **botella (1 unidad)** de ese
  tamaño. ⇒ `measureKind="count"`, `unit="botella"`,
  `presentationNote="botella 750 ml"`. Generaliza a embotellados/enlatados.
- **Precio y cantidad**: leerlos de las columnas que correspondan; usar
  las **instrucciones libres** del operador para desambiguar (ej. "la
  columna PRECIO es el costo sin IVA", "COD es SKU, ignorar", "la columna
  4 es la existencia actual").
- **Categoría**: sugerir una categoría corta (Proteínas, Lácteos,
  Licores, Empaques…). Filas basura (encabezados, totales) → omitir.

### D3. Instrucciones libres (el pedido clave)

Un **textarea "Instrucciones para la IA"** en la pantalla de carga. Su
texto se inyecta en el prompt (sección claramente delimitada, "el usuario
indica: …"). Permite decir cómo interpretar una columna/campo. Se puede
**re-procesar** con nuevas instrucciones sin re-subir (el cliente
conserva el archivo y re-llama la API).

### D4. Matching (server, sin IA) — `matchInventory`

- Cada fila contra los insumos existentes por nombre `fold`
  (accent-insensitive): `matched` (ya existe) o `new` (se creará) — mismo
  criterio que la factura-IA (F4).
- Categoría: si la sugerida coincide (fold) con una categoría existente
  del comercio, se reusa esa; si no, queda como categoría nueva.

### D5. Pantalla de revisión (compacta)

- **Tabla densa** (no cards): una fila por insumo. Columnas: estado
  (chip "ya existe" verde / "nuevo" azul, reusa `MatchStatusChip`) ·
  Nombre · Medida (selector masa/volumen/conteo) · Categoría
  (input + datalist con las del comercio) · Cantidad · Unidad · Costo ·
  badge de baja confianza. **Edición inline**; header sticky; scroll.
- **Checkbox por fila** para excluir basura (+ "marcar todo/nada").
- Textarea de **instrucciones** + botón **"Re-procesar"** (re-llama la IA
  con el mismo archivo + instrucciones nuevas).
- Resumen: "N nuevos · M ya existen · total valorado $X".

### D6. Confirmación (tx) — crear insumos + sembrar stock valorado

Por cada fila seleccionada:
- `new` ⇒ crear `Ingredient` (name, measureKind, category).
- `matched` ⇒ por defecto **no** se re-crea el catálogo; si tiene
  cantidad, se puede sembrar stock igual (toggle "actualizar existencias
  de los que ya existen").
- **Stock inicial valorado**: `qtyBase = toBaseQty(quantity, measureKind,
  unit)`; si `qtyBase>0`, `applyStockMovement(tx, { kind:"adjust_in",
  qtyBase, totalCostCents: round(quantity × unitPriceCents) })` — entrada
  con costo ⇒ inventario valorado (A1). `count` (botella/und) ⇒ base =
  unidades.
- Todo en una sola transacción: o se crea todo lo seleccionado, o nada.

Sin persistir la carga (patrón del import de carta): se procesa en
memoria; reintentar = re-procesar/re-subir. El archivo no se guarda como
evidencia (a diferencia de la factura A2.5, que sí lo liga a la OC).

## API (gate `inventory`)

```
POST /api/operator/inventory-import           → multipart: file + instructions
     → { rows, match }   (maxDuration alto — IA)
POST /api/operator/inventory-import/confirm    → { rows: [...editadas/seleccionadas],
     updateExisting: bool } → crea insumos + siembra stock en tx → 201 { created, seeded }
```

Validaciones: tamaño de archivo (como uploads), formatos permitidos
(pdf/jpg/png/webp/csv/xlsx), qty ≥ 0, precio ≥ 0, ≤ N filas.

## Lógica central (pura, testeable)

- `matchInventory(extraction, { ingredients, categories })` → filas
  emparejadas/nuevas + categoría reusada/nueva.
- `sheetToText(buffer)` (SheetJS) → CSV de la primera hoja.
- Sanity tsx: limpieza de nombre, measureKind por caso (incl. alcohol
  → count), match por nombre `fold`, qtyBase y valor exactos.

## Entrega (3 PRs)

1. **Backend**: `extractInventoryImport` (schema IA + prompt con reglas de
   nombre/unidad/alcohol/instrucciones) + `sheetToText` (SheetJS, dep
   nueva) + `matchInventory` (puro) + sanity tsx.
2. **API**: subir/extraer/matchear + confirmar (crea insumos + siembra
   stock valorado en tx).
3. **UI** (subagente): botón "Importar con IA" en Insumos + pantalla de
   carga (archivo + instrucciones) + tabla de revisión compacta editable
   + re-procesar + confirmar + i18n trilingüe.

## Fuera de alcance (explícito)

Lista de precios de proveedor (esto siembra stock del comercio, no
proveedores); múltiples hojas de un Excel (solo la primera); conciliación
con conteos físicos; aprendizaje de correcciones; unidades exóticas fuera
de masa/volumen/conteo.

## Criterios de aceptación

1. Subir foto/PDF **o** Excel/CSV → la IA arma la tabla con nombre limpio,
   unidad, categoría, cantidad y costo; baja confianza en ámbar.
2. "Harina 25kg" ⇒ name="Harina", measureKind=mass, presentación 25kg.
   "Aguardiente 750ml" ⇒ name="Aguardiente", **measureKind=count**
   (botella), NO volumen.
3. El textarea de instrucciones cambia cómo la IA interpreta las columnas;
   se puede re-procesar sin re-subir.
4. Confirmar crea los insumos nuevos y **siembra el inventario inicial
   valorado** (cantidad × costo) vía `adjust_in`; los que ya existen se
   emparejan (no se duplican).
5. Trilingüe en paridad; tsc/eslint/build verdes.
