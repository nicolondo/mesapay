# Cobrar una cuenta con varios medios

El administrador y el mesero pueden elegir **Cobrar → Combinar medios**, escribir el importe total de una parte y registrarla en efectivo o con un datáfono habilitado. Después de confirmar el pago, la pantalla muestra los abonos recibidos y prepara el saldo restante para cobrarlo con otro medio. También funciona en mostrador; la preparación solo comienza cuando la cuenta está completamente pagada.

El importe ingresado incluye la propina de esa parte. La propina se elige para toda la cuenta y se reparte con aritmética entera entre los pagos; se descuenta lo ya cobrado y se conserva exactamente el saldo. No se vuelve a sumar la propina completa en cada medio. Los importes con centavos se muestran con precisión; el efectivo físico redondeado informa la propina adicional antes de confirmarlo. Se rechazan importes fuera de límites, superiores al saldo o que dejarían un saldo imposible de cobrar.

La cuenta permanece abierta hasta completar el consumo. Los pagos quedan registrados individualmente, solo el efectivo entra en caja y se genera una sola factura al terminar. El impuesto al consumo y los demás informes usan los registros de pago existentes. No se agregan medios manuales nuevos, migraciones ni cobros automáticos.

El datáfono externo requiere confirmar que el dinero se recibió. Se puede descartar una solicitud que no se cobró. Los pagos electrónicos en curso mantienen su reserva y bloquean otro abono desde esta modalidad. El regreso de Smart POS conserva el flujo del administrador o del mesero y vuelve al saldo cuando el pago es parcial. La selección de modalidad y propina se recuerda para esa cuenta en la misma pestaña.

Los reintentos de efectivo tras una respuesta perdida conservan la misma clave y el mismo importe original. La confirmación del datáfono también refresca su estado si la respuesta no llega. Se verifica el restaurante activo al acceder a los controles de cobro; los permisos de administrador y el turno requerido del mesero siguen aplicándose. La aprobación y el rechazo concurrentes del datáfono se serializan sobre la cuenta.

## Validación

- 3.917 pruebas unitarias y 313 pruebas de integración aprobadas.
- 14 comprobaciones generales de navegador aprobadas; se mantienen 2 omisiones preexistentes.
- Cobertura del cálculo nuevo: 100 % de líneas, funciones, instrucciones y ramas.
- Compilación de producción y TypeScript correctos; ESLint sin errores y con los 31 avisos preexistentes.
- 20 escenarios de navegador aprobados en Chromium y WebKit móvil sobre la compilación de producción, con datos sintéticos en PostgreSQL local; se comprueban caja, saldo, factura única, centavos, permisos y respuestas perdidas. No se enviaron cobros a un proveedor, documentos a la DIAN ni correos reales.
- Revisión independiente del cálculo, los permisos, los reintentos y la confirmación de pagos; hallazgos corregidos antes de publicar.

La reversión consiste en volver a la versión anterior de la aplicación. Los abonos ya registrados permanecen como pagos normales de la cuenta y son compatibles con esa versión.
