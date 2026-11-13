# Fondos pendientes en las wallets

## Estado

La presentación y el contrato de datos se incluyeron en la versión del rediseño del administrador. **No está resuelta la obtención del importe pendiente real.** El usuario autorizó posteriormente el diagnóstico de sólo lectura para la cuenta de suscripciones de MESAPAY y Son y Melona. La consulta se realizó sin cobros, devoluciones ni dispersiones.

Actualización del 9 de noviembre: el reporte de suscripciones responde correctamente al indicar `switch=ecommerce` y limitar `endDate` al día anterior. Son y Melona devuelve `403/E003`, falta de permisos para consultar liquidaciones. El reporte de suscripciones puede incluir `payment_date` futura y no identifica la wallet de destino; una fila de ese reporte no basta para afirmar que hubo un abono. Ver [conciliación informativa](2026-11-09-wallet-collection-reconciliation.md).

## Comportamiento preparado

Las wallets del administrador general y del comercio muestran un bloque independiente **Pendiente por ingresar**. Un importe informado, incluido cero, se diferencia de un dato no informado y de una consulta fallida. El pendiente no incrementa los fondos disponibles ni habilita dispersiones.

El proveedor de comercios devolvía siempre `pendingCents: 0`, aunque Kushki no lo enviara. Se sustituye por `null` con `pendingStatus: not_reported`, también para una wallet disponible vacía. Una respuesta de autenticación fallida ya no se interpreta como saldo cero por contener el texto WLT400; se exige HTTP400 y código JSON exacto.

El comercio dispone de actualización manual del saldo y reintento; los errores terminan el estado de carga y descartan cifras anteriores. Textos en español, inglés y portugués. El contrato admite `reported`, `not_reported` y `unavailable`; el proveedor real actual no fabrica valores `reported`.

## Dependencia para mostrar un importe real

[Balance for Payouts](https://api-docs.kushkipagos.com/es/saldo-para-payouts-36274558e0) documenta `currentBalance`, moneda y fecha, pero no un pendiente agregado. La [API de liquidaciones](https://api-docs.kushkipagos.com/colombia/online-payments/settlement) documenta pagos liquidados, comisiones y valor neto. La ausencia de un registro no confirma que un cobro esté pendiente ni que vaya a abonarse a la wallet configurada.

No calcular el pendiente restando el disponible a las ventas, usando `Payment.settledAt` como fecha de acreditación, asignando todas las suscripciones a la wallet activa ni inventando un plazo de liquidación. Los cobros de suscripciones y las cuentas de dispersión tienen credenciales independientes. Los pagos históricos no incluyen identidad de cuenta de recaudación y estado de acreditación suficientes para ese cálculo.

Antes de conectar una fuente, verificar cuenta, moneda, ambiente, significado del importe, comisiones y vínculo entre recaudación y wallet. Si Kushki ofrece un reporte específico, integrar ese contrato y probarlo con respuestas verificadas. Ninguna prueba de esta preparación envía dinero real ni consulta credenciales de producción.

## Compatibilidad

No hay migraciones ni cambios de credenciales, movimientos o cuentas. El cliente nuevo trata como desconocida una respuesta antigua que no incluya los campos de pendiente. Los límites de pago continúan basados en `availableCents`.

## Validación local

- 6.056 pruebas unitarias y 418 de integración aprobadas.
- Ocho escenarios de navegador sobre la compilación de producción, en Chromium y WebKit móvil, con respuestas sintéticas de saldo y pagos externos bloqueados.
- Compilación y TypeScript correctos; lint sin errores y 30 avisos preexistentes.
- Revisión independiente sin hallazgos bloqueantes; verificación visual de ambos estados móviles de dato no informado.
- Los casos iniciales de fechas de otras funciones requirieron configurar UTC en la base temporal de integración para igualar CI. No se cambiaron los cálculos de la aplicación ni las aserciones de esos casos.
