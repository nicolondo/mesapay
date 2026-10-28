# IVA incluido por línea en facturas de compra

Al importar una factura, cada línea muestra la casilla **Impuestos incluidos en este importe**. Se activa o desactiva según la evidencia de esa línea; una misma factura puede combinar importes con impuestos y bases sin impuestos. El operador puede corregir la elección antes de confirmar y ver inmediatamente la base, IVA, consumo y total resultantes.

## Detección y revisión

- El extractor conserva encabezados, importes y tributos impresos. La conciliación determinista compara las etiquetas explícitas, el IVA de la línea, la relación entre precio unitario y total, y los totales del documento. No asigna una convención por proveedor ni por la sola presencia de una tarifa de IVA.
- Precio unitario y total de línea tienen bases independientes. Un importe de línea nunca se multiplica de nuevo por la cantidad. El consumo fijo no se transforma en una tarifa de IVA.
- Las contradicciones quedan marcadas en la extracción para que una segunda lectura no borre la ambigüedad. Sin evidencia suficiente se pide una elección explícita. Las líneas exentas no entran en conflicto por una diferencia de convención que no cambia sus importes.
- La conciliación considera retenciones y descuentos transcritos. No reparte automáticamente el consumo del documento: si falta asignarlo a las líneas, permanece la revisión obligatoria.
- La elección manual se conserva al cambiar proveedor, correspondencia o presentación, y después de un intento fallido de confirmación. Confirmar una base desconocida conserva el IVA documental; cambiar entre dos bases conocidas recalcula el IVA para no conservar un importe incompatible.
- Las importaciones pendientes antiguas se interpretan una sola vez al abrir la revisión. Si carecen de los metadatos históricos de consumo, siguen exigiendo revisión; la ausencia de notas opcionales no impide abrirlas.

## Persistencia y compatibilidad

Los cambios se limitan al extractor, la interpretación inicial y el control de revisión. La confirmación conserva el contrato de base neta, IVA explícito y consumo por línea; los mismos centavos continúan en el borrador, recepción, inventario y cuentas por pagar. No hay migración de base de datos ni modificación de compras ya confirmadas. Los textos del control están disponibles en español, inglés y portugués.

## Validación

Pruebas unitarias de evidencia, negaciones, ambigüedad, conflictos persistentes, importes mixtos, exentos, redondeos, consumo y cambios manuales. Pruebas PostgreSQL del flujo de importación, persistencia, confirmación y recepción. Pruebas de navegador en Chrome e iPhone/WebKit, incluyendo correspondencias de proveedores, reintentos y revisión de documentos antiguos; capturas comprobadas en ambos tamaños.

La lectura de documentos se simula con extracciones sintéticas en las pruebas: no se envían facturas reales a un proveedor de IA ni se crean movimientos de prueba en producción. La cobertura del detector y del helper de revisión se mide aparte de la cobertura global del proyecto. Se ejecutan también TypeScript, ESLint y compilación de producción antes de publicar.

Resultado local de la versión final: **3.743 unitarias, 288 de integración PostgreSQL y 62 E2E** aprobadas; estas últimas sobre la compilación de producción local. TypeScript y build aprobados, ESLint sin errores y con los 31 avisos preexistentes. Detector y helper de revisión: 100% de líneas y 98,17% de ramas en conjunto. Revisión independiente de código y seguridad sin hallazgos críticos o altos pendientes.
