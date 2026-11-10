# Seguimiento de wallet y filtros de Órdenes

## Comportamiento

En `/operator/orders` se puede elegir **Todas**, **Mesas** o **Facturas manuales**, y seleccionar una mesa concreta. El filtro se aplica inmediatamente, conserva fechas, estado y búsqueda, reinicia la página y actualiza los totales. La búsqueda por número de factura respeta también el tipo y la mesa elegidos. Los pedidos de recogida permanecen en Todas. La selección de mesas sólo incluye las del comercio activo.

Las wallets del administrador general y del comercio muestran **Pendiente estimado por ingresar**, calculado por MESAPAY a partir de sus propios cobros y de observaciones del saldo disponible. No depende del reporte de liquidaciones. El disponible sigue siendo exclusivamente el informado por Kushki; la estimación nunca autoriza una dispersión.

El seguimiento inicia con una consulta válida del saldo y una fecha de corte visible. Por decisión del usuario, el pendiente inicial es cero y los cobros anteriores quedan aparte para revisión. No se reconstruye un pendiente histórico desconocido. Se pueden incorporar importes pendientes anteriores explícitamente y registrar comisiones, entradas, salidas externas o correcciones con motivo, confirmación, idempotencia y auditoría. Los documentos originales no se modifican.

El importe histórico incorporado corresponde al pendiente en la fecha de inicio, que se muestra en el formulario y su confirmación. El máximo conserva el valor observado en ese corte; una devolución posterior revisada no lo reduce ni se descuenta dos veces. Los abonos posteriores ya están reflejados en la variación del saldo.

La diferencia se calcula como pendiente inicial + cobros + histórico incorporado − devoluciones − comisiones + ajustes − variación del disponible − dispersiones efectivas. Una diferencia negativa permanece visible para revisión. No equivale a confirmar el abono de una transacción particular. Movimientos externos, comisiones desconocidas o una cuenta recaudadora que no abone a la wallet configurada requieren conciliación.

## Datos y controles

- Se congela la cuenta, ambiente y moneda utilizados en cada nuevo cobro: órdenes, datáfono, recogida, reservas, bonos y suscripciones. No se guardan credenciales en los cobros. Efectivo, datáfonos externos, simulaciones y aplicaciones posteriores de anticipos/bonos quedan fuera.
- Una suscripción anterior sin vínculo se verifica con una consulta autenticada de su identificador y moneda antes de fijarlo para futuros cobros. Una consulta fallida no interrumpe la facturación ni inventa un vínculo.
- Los movimientos tienen identidad única por fuente y devoluciones acumuladas; paginación y reintentos no duplican importes. Las cuentas y ambientes no se mezclan. Un cambio de configuración no reasigna cobros históricos.
- Una lectura inicial concurrente con cobros o dispersiones se descarta y se reintenta. Los egresos inciertos, fuentes sin confirmar, cambios históricos sin revisar y consultas incompletas impiden presentar una cifra como vigente. Los fallos de consulta nunca se sustituyen por saldo cero.
- Los ajustes que reconocen cambios de movimientos anteriores requieren una confirmación explícita sobre la versión revisada. El historial técnico se conserva; no se marcan cobros como abonados a partir de una diferencia de saldos.
- Las dispersiones del comercio guardan el intento antes del envío, conservan la misma identidad al recuperar una respuesta perdida y verifican el estado con Kushki. Un callback sólo solicita esa consulta. El destino propio mostrado en la confirmación debe seguir siendo el mismo al enviar.
- Restaurar una copia de un comercio conserva los intentos de dispersión y el seguimiento de wallet. El archivo de eliminación no exporta secretos de callback.

## Operación

Migración aditiva: `20261110090000_wallet_tracking`. No altera importes ni estados de cobros existentes. La tarea `mesapay-wallet-tracking.timer` ejecuta la comparación cada cinco minutos, con cursor, límite de trabajo y exclusión de ejecuciones concurrentes. Los archivos de instalación están en `docs/cron/`; la ruta exige `CRON_SECRET`. Abrir una wallet también permite iniciar o actualizar su seguimiento.

Antes de activar: respaldo validado, pruebas con PostgreSQL local y proveedores simulados, revisión independiente, compilación y pruebas de navegador. Tras publicar: verificar ambas cuentas, fecha de corte, servicio y temporizador. No se envían cobros, devoluciones, dispersiones, documentos fiscales ni correos reales como parte de la validación.

## Validación de la versión

- 6.427 pruebas unitarias en 540 archivos y 470 pruebas de integración en 52 archivos, aprobadas con PostgreSQL aislado.
- 62 pruebas de navegador aprobadas sobre la compilación de producción local, en Chrome de escritorio y WebKit de iPhone: filtros, estimación, histórico, aislamiento de cuentas y recuperación de respuestas perdidas.
- Compilación y TypeScript correctos. Lint sin errores; conserva 30 avisos anteriores a este cambio.
- Cobertura de líneas: seguimiento 99,57%, dispersiones del comercio 99,68%, filtros 93,03%. Revisión independiente aprobada.
- Migración probada desde una base vacía y respaldo previo validado. Evidencia local en las carpetas QA del 10 de noviembre, fuera del repositorio.
