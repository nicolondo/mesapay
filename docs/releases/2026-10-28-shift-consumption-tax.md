# Impuesto al consumo separado en los cierres

Los cierres muestran el **Impuesto al consumo (INC)** incluido en los cobros del turno. Se presenta en el resumen del turno abierto, al confirmar el cierre, en los cierres recientes, en el historial y en el reporte detallado imprimible. Los textos están disponibles en español, inglés y portugués. El modal admite desplazamiento vertical en pantallas pequeñas.

El importe es informativo y ya está incluido en el total cobrado. No modifica el efectivo esperado, las propinas, los medios de pago, el total de ventas ni la diferencia de caja. El valor de comida sin propina conserva su significado anterior: todavía incluye los impuestos correspondientes.

## Cálculo e históricos

El cálculo utiliza exclusivamente los datos fiscales congelados de la factura: INC incluido en los precios del menú más INC agregado en líneas libres. Excluye IVA y propinas. No aplica la tarifa actual del restaurante a facturas anteriores.

En pagos divididos, el impuesto se reparte proporcionalmente al consumo pagado, con redondeo acumulado exacto y límite en el impuesto de la factura. Primero se consideran todos los pagos originalmente liquidados, incluidos los posteriormente reembolsados; después se seleccionan los pagos aprobados del turno. De este modo, una devolución no redistribuye el impuesto entre los otros pagos ni lo duplica en otro cierre. Los turnos personales conservan su ventana de cobro y el filtro por restaurante.

Las facturas antiguas sin impuestos registrados conservan su valor de cero. Cuando no existe factura o faltan datos fiables, el cierre muestra cuántos cobros no tienen desglose fiscal confirmado; no inventa un impuesto para completar el importe. Esta situación no impide cerrar caja.

Las consultas se realizan por lotes y solo proyectan los campos fiscales necesarios, sin cargar datos del cliente ni las líneas completas de las facturas. No hay migraciones, cambios en existencias o emisión de documentos fiscales. Para revertir basta con volver a la versión anterior de la aplicación.

## Validación

- **3.828 pruebas unitarias y 303 integraciones** aprobadas.
- **18 escenarios de navegador** aprobados sobre la compilación de producción, en Chrome y WebKit móvil: 10 de INC y 8 de fechas de jornada.
- Cobertura de los módulos nuevos de cálculo y consulta: **100 % de líneas, funciones e instrucciones; 98,03 % de ramas**.
- TypeScript y compilación correctos; ESLint sin errores, con los 31 avisos preexistentes.
- Revisión independiente de cálculo, devoluciones, históricos, aislamiento entre comercios, consultas y traducciones: sin hallazgos pendientes.

Se comprobó un cierre mixto con $186.500 cobrados, $15.000 de propinas y $12.000 de INC. El efectivo esperado se mantuvo en $518.000 y la diferencia de caja en $0. También se verificaron pagos divididos entre turnos, reportes personales, datos históricos malformados, ausencia de factura y presentación impresa.

Las pruebas usan datos sintéticos en PostgreSQL local, con la zona horaria UTC de producción. La validación de impresión utiliza la presentación de impresión del navegador; no se realizó una impresión física ni se crearon cierres de prueba en producción.
