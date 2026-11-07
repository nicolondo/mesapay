# Wallet de MESAPAY y dispersiones de plataforma

La sección **Administrador general → Wallet MESAPAY** permite configurar la cuenta Kushki de dispersión de la plataforma, consultar su saldo disponible y enviar transferencias a cuentas bancarias en Colombia. El historial es propio de MESAPAY y no pertenece a ningún restaurante.

## Configuración y uso

1. Abrir **Wallet MESAPAY → Configurar cuenta de dispersión**.
2. Introducir un nombre identificable, ambiente y el par de llaves de Transfer Out correspondiente a la cuenta de MESAPAY. La llave privada se cifra y nunca se devuelve al navegador. Las llaves de cobro de suscripciones se mantienen en **Configuración**.
3. Consultar **Saldo disponible para dispersar**. Es el saldo que reporta Kushki para la cuenta configurada, con fecha de consulta; no es una suma de mensualidades ni una garantía de que cobros recientes estén liquidados. La relación entre la recaudación de suscripciones y esa cuenta se debe establecer con Kushki.
4. Ingresar el banco, tipo y número de cuenta, identificación y nombre del beneficiario, monto en COP y concepto opcional. Revisar el resumen antes de confirmar el envío.
5. Consultar el historial y actualizar el estado. Un envío iniciado no se presenta como dinero entregado. Si el resultado es desconocido, se conserva el intento para conciliación y no se reenvía automáticamente. Si falta el ticket, se puede ingresar el que figure en Kushki: se contrasta su referencia e importe antes de vincularlo. Un intento de preparación vencido solo se libera cuando consta que no llegó a iniciar el envío.

## Controles

- Acceso exclusivo al administrador de plataforma, sin depender del restaurante seleccionado.
- Intento persistido antes de enviar, referencia estable e idempotencia para evitar duplicados.
- Credenciales históricas vinculadas a cada operación; cambiar la configuración no cambia la cuenta consultada para transferencias anteriores.
- Notificaciones autenticadas y resultado verificado con la consulta privada de estado de Kushki.
- Historial con cuenta de destino enmascarada; no almacena número completo de cuenta ni documento del destinatario.
- Interfaz en español, inglés y portugués, adaptable a móvil y con separación automática de miles.

## Compatibilidad y publicación

La migración añade cuentas e intentos de dispersión de plataforma y un vínculo opcional en `PlatformConfig`. No modifica los cobros de suscripción ni los movimientos y saldos de restaurantes. La sección permanece sin configurar hasta guardar explícitamente las credenciales.

Antes de una reversión a una versión sin esta función, revisar los intentos pendientes con Kushki: esa versión no recibe el nuevo webhook ni permite consultar el historial de plataforma. Conservar las tablas y las credenciales cifradas para recuperación; no deshacer la migración borrando operaciones.

## Referencias del proveedor

- [Transferencias y saldo para dispersión](https://docs.kushki.com/co/payouts/transfer).
- [Integración de transferencias a cuentas bancarias](https://docs.kushki.com/co/payouts/transfer/transfer-out/).
- [Consulta de estado](https://api-docs.kushkipagos.com/colombia/online-payments/transfer-out/status).

Las pruebas utilizan bases locales y respuestas simuladas del proveedor; no envían dinero real.

## Validación de la versión

- 6.052 pruebas unitarias y 413 de integración con PostgreSQL aprobadas.
- Ocho escenarios de navegador de la wallet en Chromium y WebKit móvil, más 14 comprobaciones generales (dos omisiones preexistentes).
- Compilación de producción y TypeScript aprobados; ESLint sin errores y 30 avisos previos.
- Cobertura de la nueva lógica: 97,47 % de líneas, 83,49 % de ramas y 96,66 % de funciones. Revisión independiente de seguridad sin hallazgos críticos o altos pendientes.
