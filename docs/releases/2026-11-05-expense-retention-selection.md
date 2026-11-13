# Selección manual de retenciones en gastos

En **Contabilidad → Gastos → Nuevo gasto → Impuestos y retenciones → Agregar retención** se puede elegir cualquier concepto del catálogo del comercio, aunque no esté activo para las sugerencias automáticas. Antes, el selector desaparecía si todos estaban inactivos; esa era la configuración de Son y Melona al diagnosticar el reporte.

La selección se guarda en el gasto, permite ajustar el importe y se conserva al volver a abrirlo. No activa conceptos ni modifica la configuración del comercio. Las sugerencias siguen usando únicamente conceptos activos. El servidor mantiene los controles de proveedor obligatorio, importe máximo de retención y pertenencia del concepto al comercio.

Si falla la carga del catálogo, el formulario muestra el error y **Reintentar**, conservando los datos escritos. La consulta tiene un límite de espera y se cancela al cerrar el formulario. El guardado con impuestos espera a que se conozca la configuración fiscal para no usar valores incompletos.

Las plantillas recurrentes siguen consultando los conceptos activos al generar gastos. Al seleccionar una retención inactiva en una plantilla, se muestran los nombres afectados y un acceso a su configuración, para aclarar que no se repetirá automáticamente. Los textos están disponibles en español, inglés y portugués.

## Validación

- 6.004 pruebas unitarias y 399 pruebas de integración aprobadas.
- Regresión con PostgreSQL real: crear, consultar y modificar una retención de concepto inactivo; no se activa el concepto ni se admiten conceptos de otro comercio.
- Navegador de escritorio y WebKit móvil: selección de retefuente, reteIVA y reteICA, ajuste de valores, guardado, reapertura, aviso de recurrentes y recuperación de la carga fallida sin perder el borrador.
- ESLint sin errores; se conservan 30 avisos preexistentes.

No se cambian cálculos, tarifas, configuración de comercios ni migraciones. La reversión consiste en activar la versión anterior; los gastos guardados conservan el formato que esa versión ya admite.
