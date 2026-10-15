# Precios editables de insumos — 15 de octubre de 2026

Insumos permite crear, cambiar y quitar un precio de referencia por kilogramo,
litro o unidad. Se muestra en la lista y en el editor, con separador de miles y
dos decimales. El costo promedio del inventario se muestra por separado.

## Comportamiento

- `Ingredient.referencePriceCents` guarda centavos por 1000 unidades base
  (1 kg, 1 L o 1 unidad). `null` significa sin referencia; cero es explícito.
  Los campos omitidos en PATCH se conservan. Cambiar el precio registra actor,
  valor anterior y valor nuevo con el mecanismo de auditoría existente.
- Las nuevas líneas libres de compra sugieren cantidad × referencia. Una
  modificación manual del costo se conserva al cambiar cantidad o unidad.
  Las presentaciones del proveedor siguen usando su propio precio.
- Recetas usa la cascada inventario valorado → subreceta → referencia manual
  → proveedor preferido. El cero explícito se propaga por subrecetas completas;
  las recetas vacías siguen sin costo conocido.
- Editar la referencia no modifica existencias, movimientos, compras anteriores,
  precios o historial de proveedores, ni lotes de producción.
- Cambiar dimensión borra una referencia anterior salvo que PATCH incluya una
  nueva. Bulk aplica la misma protección de inventario que la edición individual:
  no reinterpreta saldos, movimientos ni presentaciones. Pedir la dimensión actual
  conserva el precio. Las operaciones se serializan con el bloqueo de stock.
- Los selectores de proveedor, presentación e insumo de Nueva orden usan grupos
  accesibles. Se corrige el clic reenviado por una etiqueta en Safari móvil que
  deshacía la selección inmediatamente.
- El promedio visible se limpia después de una puesta a cero confirmada desde
  el editor. Los errores de guardado conservan los datos para reintentar.
- Textos completos en español, inglés y portugués.

## Validación

- Suite completa: 3337 pruebas unitarias aprobadas antes de agregar seis
  regresiones adicionales de cobertura (también aprobadas).
- 114 casos específicos de unidades e integración con PostgreSQL real.
  Incluyen aislamiento por comercio, validación, cambios de unidades,
  conservación de históricos y concurrencia con recepción de inventario.
- Cobertura del helper, costeo y tres APIs evaluadas: 93,60 % de líneas,
  92,43 % de ramas y 86,66 % de funciones. El helper nuevo tiene 100 %.
  No es cobertura global de la aplicación.
- 28 E2E locales con autenticación real: WebKit móvil y Chrome de escritorio,
  edición, recarga, decimales, reintentos, compras, proveedor, cambio de unidad,
  puesta a cero y regresiones del editor anterior.
- Revisión visual móvil/escritorio y revisión independiente ECC de código,
  seguridad y datos sin bloqueadores. Lint sin errores; 31 avisos preexistentes.
- Compilación de producción y TypeScript aprobados. Cálculo exacto con BigInt
  compatible con el objetivo TypeScript existente, sin cambiar su configuración.

## Despliegue

Migración aditiva `20261015230000_ingredient_reference_price`: columna nullable
y restricción entre 0 y 2.000.000.000 centavos. No rellena precios ni cambia datos
comerciales existentes. Compatible con la versión anterior durante el cambio
azul/verde. Obtener respaldo antes de ejecutar el pipeline habitual completo.
