# Jornada de los cierres después de medianoche

Los cierres recientes, el historial de turnos y el reporte imprimible identifican cada turno por la jornada en que se abrió. La fecha y hora reales de cierre siguen visibles por separado.

Por ejemplo, en Son y Melona, el turno abierto el 17 de octubre y cerrado el 18 a la 01:18 pertenece a la jornada del 17. El cerrado el 12 a la 01:01 pertenece a la jornada del 11. Se aplica la hora de corte configurada del comercio al momento de abrir el turno; un turno abierto antes de ese corte pertenece a la jornada anterior.

## Persistencia y compatibilidad

- `Shift.businessDate` guarda la jornada como fecha sin hora. Cambiar después la hora de corte no reclasifica los turnos existentes.
- La migración `20261020180000_shift_business_date` completa los turnos históricos usando la hora de corte actual del comercio, pues no existe un historial de configuraciones anteriores. Conserva los importes, pagos y marcas de apertura y cierre.
- El disparador de inserción asigna la jornada en los tres flujos de apertura, incluidos los de una versión anterior durante el despliegue azul/verde. Convierte explícitamente el timestamp UTC a Bogotá, independientemente de la zona horaria de PostgreSQL.
- Las copias de seguridad nuevas conservan la jornada. Al restaurar una copia anterior sin este campo, la aplicación calcula la fecha con la configuración del comercio contenida en esa copia.
- Si se revierte el binario después de aplicar la migración, las aperturas y cierres normales siguen siendo compatibles. Las restauraciones de comercios deben ejecutarse con esta versión o una posterior: un binario anterior desconoce el campo y puede calcularlo con la configuración que tenía el comercio antes de restaurar.
- La agrupación diaria de pagos conserva su comportamiento actual. Esta corrección identifica la jornada del turno, incluso cuando su duración supera 24 horas.

## Impresión

El reporte incluye la jornada y mantiene la apertura, el cierre y la duración. Su encabezado permanece visible al imprimir. Se elimina la columna vacía del menú lateral en modo impresión para aprovechar el ancho de la hoja.

## Validación

- 3.543 pruebas unitarias y 239 pruebas de integración con PostgreSQL 17 aprobadas.
- 18 casos de integración nuevos: históricos, madrugada, cambio de mes y año, turnos largos, configuración posterior, aislamiento entre comercios, zona horaria de la sesión y restauración de copias.
- 8 casos de navegador en Chrome e iPhone: fechas de la foto, importes conservados, historial, impresión y traducciones al inglés y portugués.
- Regresiones reproducidas antes de corregirlas: fecha del cierre como jornada y reporte impreso de solo 264 píxeles de ancho.
- Cobertura de los módulos de fecha y restauración: 81,69% de líneas y 87,34% de ramas; las funciones nuevas de jornada quedan cubiertas completamente.
- Revisión independiente ECC aprobada, incluida la migración y la compatibilidad de restauraciones.
- Compilación de producción y TypeScript aprobados. Los 8 casos de navegador también pasan sobre esa compilación. Lint no tiene errores y conserva los 31 avisos previos.
