# Cantidades acumuladas por escaneo de inventario

Al escanear otra vez un insumo ya contado, se abre una cantidad adicional junto a las anteriores. Por ejemplo, 12 unidades en bodega y 3 en la barra se conservan como dos cantidades editables y suman 15 unidades. Los códigos principales y adicionales del mismo insumo comparten ese desglose. Si queda una cantidad vacía o inválida, el escaneo la enfoca para terminarla antes de abrir otra.

Cada cantidad se puede corregir o quitar. El botón «Agregar cantidad» permite hacerlo sin lector. Las cantidades se distribuyen en columnas según el ancho disponible, sin desplazamiento horizontal, y el total contado se muestra aparte de la diferencia con el inventario teórico. Se admiten unidades compatibles dentro del mismo insumo, como kilos y gramos.

El escáner permanece en la cabecera. **Enter** en una cantidad válida devuelve el foco al escáner vacío; la instrucción se muestra junto al campo. Enter no guarda ni ajusta existencias. «Guardar borrador» conserva el total y cada cantidad para retomar el conteo posteriormente. Una cantidad cero es explícita; un campo vacío no equivale a cero y se omite al guardar. Los textos nuevos están traducidos a español, inglés y portugués.

El preliminar conserva su propio desglose. Al iniciar el conteo definitivo se abren cantidades vacías para contar de nuevo; las cantidades iniciales siguen visibles como referencia. Las revisiones, permisos y comprobaciones de movimientos concurrentes siguen aplicándose antes de confirmar un ajuste.

## Persistencia y compatibilidad

La migración `20261028190000_stock_count_parts` agrega los arreglos `countedParts` y `preliminaryParts` a `StockCountItem`, con valores enteros en unidad base y valor predeterminado vacío. No cambia totales históricos ni existencias. Los conteos anteriores se presentan con una sola cantidad correspondiente a su total.

La API y el servicio validan que los parciales sean enteros no negativos y sumen exactamente el total. Se conservan los límites de 2.000.000.000 unidades base y se admiten hasta 200 cantidades por insumo. Se valida el lote completo antes de escribir. Los clientes anteriores que solo envían el total siguen siendo compatibles: se conserva el desglose si coincide, o se normaliza a una sola cantidad si cambió el total.

La migración es aditiva. Si se revierte la aplicación, deben mantenerse ambas columnas para conservar los desgloses. Las copias por comercio incluyen automáticamente los campos nuevos y siguen admitiendo copias anteriores.

## Validación

Se reprodujo primero el fallo de regresión: el segundo escaneo no encontraba una segunda cantidad. Las pruebas comprueban escaneos repetidos y alias, sumas, edición y eliminación, guardado y reapertura, cero frente a vacío, unidades mixtas, límites y desbordamiento. También comprueban que Enter no escribe datos, el aislamiento entre comercios, revisiones obsoletas y el ciclo preliminar → reconteo → ajuste definitivo.

Las verificaciones utilizan datos sintéticos en PostgreSQL local y lectores HID simulados en Chrome y WebKit móvil. No se crean conteos ni movimientos de prueba en producción. No se ha probado un lector físico ni el teclado virtual de un teléfono real.

Resultado local: **3.789 pruebas unitarias, 296 integraciones y 20 escenarios E2E sobre la compilación de producción** aprobados. TypeScript y build correctos; ESLint sin errores, con los 31 avisos preexistentes. Los módulos de entrada y validación de parciales alcanzan 95,65 % de líneas y 100 % de ramas. Revisión independiente sin hallazgos pendientes.
