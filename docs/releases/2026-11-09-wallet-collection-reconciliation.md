# Cobros de MESAPAY y conciliación de liquidaciones

## Alcance

Las wallets de plataforma y comercio incorporan una consulta independiente de los cobros registrados en MESAPAY y su correspondencia con el reporte de liquidaciones de Kushki. Un fallo del saldo disponible no elimina esta información. El período consultado y los límites de cobertura son visibles.

**Esta vista no resuelve todavía el saldo exacto pendiente de ingresar a la wallet.** Ningún importe informativo se suma al disponible, permite una dispersión ni genera un movimiento contable. No hay migraciones ni modificaciones de pagos, devoluciones, wallets o cuentas de recaudación.

## Fuente y correspondencia

La fuente son los cobros locales por Kushki. Se excluyen efectivo, datáfonos externos, otros proveedores y las aplicaciones posteriores de depósitos y bonos, para no contar el mismo ingreso dos veces. Las suscripciones y las cuentas de los comercios se consultan por separado. Los datos históricos que carecen de moneda o fecha de cobro conservan esa limitación.

El reporte usa la [consulta de liquidaciones de Kushki](https://api-docs.kushkipagos.com/colombia/online-payments/settlement), con el canal `ecommerce` y fecha máxima del día anterior. La correspondencia exige referencias inequívocas e importes coherentes; no se hace por nombre, fechas aproximadas ni importe aislado. Una moneda local conocida debe coincidir. Si falta la moneda histórica local, la moneda del reporte se presenta como información del proveedor, sin alterar el registro.

La fecha informada por Kushki puede estar en el futuro. No se usa para marcar un cobro como acreditado. La clave de recaudación de suscripciones y la wallet de Transfer Out son configuraciones distintas; esta vista no afirma que todo lo liquidado por la primera llegue a la segunda.

## Dependencia externa pendiente

El diagnóstico autorizado confirmó que la consulta de suscripciones funciona y que Son y Melona recibe `403/E003`: el comercio no tiene permiso para consultar liquidaciones. Hace falta habilitar ese reporte y confirmar con Kushki el contrato que identifica el destino wallet y el abono efectivo, incluyendo los cobros por datáfono.

El endpoint de movimientos que existía en el código no se conecta a esta vista: su contrato no está verificado y responde `Missing Authentication Token`. No se interpreta ese error como un historial vacío.

## Controles

Las rutas exigen el rol correspondiente y el contexto vigente, limitan las consultas y devuelven `Cache-Control: no-store`. Una respuesta para otra cuenta se descarta. Las credenciales y las respuestas crudas del proveedor nunca llegan al navegador. El parser rechaza respuestas inválidas y no trata paginación parcial como conciliación completa.

## Validación

- 6.249 pruebas unitarias aprobadas; 22 pruebas de integración de wallets con PostgreSQL y transporte simulado, incluyendo aislamiento por comercio y ausencia de escrituras financieras.
- 18 escenarios de navegador aprobados en Chrome y Safari móvil: consulta independiente del disponible, cambio de cuenta, moneda desconocida, neto negativo, centavos y cobertura incompleta. Los 10 escenarios de la nueva vista también pasaron sobre la compilación de producción local.
- Compilación y TypeScript correctos. Lint sin errores; 30 avisos preexistentes.
- Módulo de conciliación: 100% de cobertura de líneas/funciones y más de 89% de ramas. Revisión independiente ECC sin hallazgos abiertos.
- Se corrigió una prueba anterior de enlace de pago cuya fecha fija vencía el 9 de noviembre: ahora controla su reloj. No se modificó la vigencia de los enlaces reales.
