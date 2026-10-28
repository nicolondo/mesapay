# Conteo continuo con lector de códigos

El campo de escaneo permanece en la cabecera del conteo, mientras el detalle se desplaza de forma independiente. Escanear un código principal o adicional lleva a la cantidad del insumo, incluso si un filtro ocultaba la fila. Volver a escanear el mismo código conserva la cantidad digitada y la selecciona para editarla.

Una cantidad válida seguida de **Enter** devuelve el foco al escáner vacío. El texto **«Pulsa Enter para escanear el siguiente código.»** aparece junto a cada cantidad editable y está asociado al campo para lectores de pantalla. Los valores vacíos o inválidos mantienen el foco y muestran una indicación; cero continúa siendo un conteo explícito válido. Los textos están traducidos a español, inglés y portugués.

Enter no guarda el borrador, no avanza de etapa y no ajusta existencias. Esas acciones conservan sus botones y validaciones actuales. El escáner se muestra únicamente durante el conteo inicial y el definitivo. En pantallas de hasta 600 px de alto, los botones inferiores se desplazan con el detalle para no cubrir la cantidad enfocada.

## Validación

Se reprodujo primero el error original con una lista de 40 insumos: escanear la última fila dejaba el escáner fuera de pantalla. Las regresiones de navegador comprueban la posición de la cabecera, el ciclo de teclado, códigos repetidos y adicionales, cero y decimales, cantidades inválidas, conservación al guardar y reabrir y las etapas preliminar, definitiva y cerrada. Comprueban además que Enter no emite escrituras ni movimientos de inventario, y que los botones no tapan el campo en pantallas cortas.

Las pruebas utilizan lector HID simulado y datos sintéticos en PostgreSQL local. No se crean conteos ni ajustes de prueba en producción. No hay cambios de API, cálculos ni esquema de base de datos.

Resultado local: **3.743 pruebas unitarias, 47 integraciones de inventario y códigos de barras y 14 pruebas E2E en Chrome y WebKit** aprobadas. Las E2E finales se ejecutaron sobre la compilación de producción. TypeScript y build correctos; ESLint sin errores y con los 31 avisos preexistentes. La revisión independiente detectó y permitió corregir la superposición de botones en pantallas cortas; no quedaron hallazgos pendientes. No se probó un lector físico ni el teclado virtual de un teléfono real.
