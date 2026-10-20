# Insumos recordados al importar facturas de compra

Un proveedor puede imprimir un nombre distinto del que usa el restaurante para el mismo insumo. La revisión de facturas ahora permite seleccionar el insumo existente y recordar esa relación para las próximas facturas del proveedor.

## Uso

1. En **Compras → Cargar factura**, abre **Usar insumo existente** o **Cambiar insumo** en la línea correspondiente.
2. Busca y selecciona el insumo del catálogo. La opción **Recordar esta relación para próximas facturas de este proveedor** queda seleccionada; se puede desmarcar.
3. Confirma la compra como borrador o con recepción. La relación se guarda junto con la compra.
4. Una nueva factura del mismo proveedor con esa descripción selecciona el insumo y muestra **Relación guardada para este proveedor**. Para corregirla, elige otro insumo y confirma con la opción de recordar.

La descripción original sigue visible. La relación se guarda por proveedor y comercio, no por similitud global entre productos. Tolera diferencias de mayúsculas, acentos y espacios, pero conserva signos y separadores de referencias y cantidades.

## Comportamiento y compatibilidad

- Las sugerencias automáticas no se aprenden por sí solas. Cancelar la revisión o fallar la confirmación no guarda relaciones.
- La descripción procede de la extracción guardada en el servidor. Eliminar o reordenar líneas no cambia su identidad.
- Cambiar de proveedor descarta sus asociaciones automáticas y presentaciones. Conserva las elecciones manuales y los importes revisados. Un cambio entre unidades de distinta dimensión exige revisar la cantidad.
- Un insumo archivado no se reutiliza: se solicita seleccionar un reemplazo o crear uno nuevo.
- Dos elecciones contradictorias para el mismo nombre y proveedor en una factura requieren corrección antes de guardar.
- No se modifica ninguna compra histórica. La migración `20261020170000_supplier_invoice_aliases` añade una tabla independiente; las copias de seguridad incluyen las relaciones y admiten copias anteriores que no tenían esta tabla.
- No cambia la extracción de IA ni añade solicitudes al proveedor de IA para recordar o consultar relaciones.

## Validación

La validación usa una base PostgreSQL local aislada y facturas sintéticas. Las pruebas de navegador simulan únicamente la extracción OCR; autenticación, catálogo, asociaciones y confirmación usan las rutas y la persistencia reales.

- 3.520 pruebas unitarias y 221 pruebas de integración PostgreSQL 17 aprobadas.
- 24 casos de navegador aprobados en Chrome e iPhone: borrador, recepción, segunda factura, corrección, exclusión voluntaria, proveedor distinto, archivado, líneas eliminadas y respuestas tardías o fallidas.
- Cobertura de persistencia y contexto: 96,66% de líneas y 97,72% de ramas. Emparejamiento: 100% y 96%. Edición de asociaciones: 100% y 88,88%.
- Revisión independiente ECC aprobada. Se corrigieron dos casos en los que un reintento o una respuesta tardía podían desmarcar una elección explícita.
- Compilación de producción, TypeScript y lint aprobados; lint conserva los 31 avisos previos, sin errores. El caso principal también se verificó en móvil y escritorio sobre la compilación de producción, con revisión de capturas.
