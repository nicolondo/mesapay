# Ventas del panel sin impuestos ni propina

El gráfico de los últimos siete días, su total y el detalle diario muestran el valor de las ventas antes de impuestos y propina. «Ventas hoy» y «Ticket promedio» usan el mismo cálculo. El panel indica expresamente «Ventas sin impuestos ni propina», con traducciones al inglés y portugués.

## Cálculo y alcance

- Se descuentan del total de cada orden pagada la propina, el impuesto añadido a líneas libres y el impuesto incluido en los precios del menú. Los descuentos ya reflejados en el total se conservan y no se restan dos veces.
- Se usa el impuesto incluido que quedó guardado al emitir la factura, aunque el comercio haya cambiado su configuración tributaria después. Las facturas históricas sin impuesto guardado conservan su interpretación original de impuesto cero.
- Para órdenes sin factura, el impuesto incluido se calcula con la configuración actual del comercio sobre líneas de menú vigentes, excluyendo productos y rondas cancelados y líneas libres con su propio impuesto. Se aplica el mismo redondeo por línea de la facturación.
- La fecha de pago y la hora de corte del comercio siguen determinando la jornada. Se mantienen las reglas existentes sobre órdenes pagadas, cortesías y devoluciones: este indicador no reemplaza los reportes fiscales de notas crédito ni el arqueo de efectivo.
- No cambia pedidos, importes cobrados, facturas ni datos históricos. No requiere migraciones ni dependencias nuevas.

## Presentación y consultas

El detalle diario está abierto al entrar. En paneles estrechos se omiten los importes encima de las barras para evitar que se sobrepongan; los valores exactos siguen visibles en la tabla. Una sola consulta alimenta la gráfica y los indicadores, seleccionando únicamente los campos tributarios necesarios de la factura. Las líneas de órdenes sin factura se consultan en un lote, con separación por comercio y agrupación lineal.

## Validación

- Regresión reproducida antes de la corrección: la prueba de navegador obtenía $23.991.500 con impuestos y propinas donde correspondían $20.190.000.
- 3.572 pruebas unitarias y 245 de integración con PostgreSQL 17 aprobadas, incluidas 29 unitarias y seis de integración nuevas para este cálculo.
- Seis casos de navegador en móvil y escritorio validan importes, indicadores, detalle abierto, traducciones y ausencia de sobreposición.
- Cobertura de los módulos nuevos: 100% de líneas, funciones y sentencias; 95,34% de ramas.
- Revisión independiente ECC de cálculo, seguridad, consultas y presentación aprobada. Conserva las facturas históricas y el aislamiento entre comercios.
- Compilación de producción y TypeScript aprobados; los seis casos de navegador también pasan sobre esa compilación. ESLint no tiene errores y conserva los 31 avisos previos.
