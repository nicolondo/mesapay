# Resolución inmediata de cobros del datáfono

El administrador puede usar **Cancelar cobro manualmente** desde que el cobro se envía al datáfono Kushki, también si el equipo no acepta la cancelación remota o el envío sigue esperando respuesta. El diálogo abre con **No se cobró** seleccionado. Debe verificar el resultado en el datáfono, registrar evidencia y confirmar. La cuenta se libera al guardar esa decisión.

Cuando no llegó respuesta, **Resolver cobro** está disponible sin los tres minutos de espera anteriores y sin esperar a que termine **Consultar en Kushki**. Para registrar un cobro aprobado se mantiene la exigencia de autorización o voucher. Los permisos de administrador, el aislamiento entre comercios y la comprobación del estado bajo bloqueo de la cuenta permanecen vigentes.

La decisión manual queda auditada. Una aprobación real que llega después de una cancelación se registra y queda marcada para conciliación. Si el resultado real coincide con una aprobación manual, se vincula su referencia al mismo registro, sin duplicar el cobro ni la factura. Si el datáfono rechaza un cobro aprobado manualmente, se conserva la aprobación y se señala el conflicto para revisión. La consulta y el envío inicial no anuncian ese rechazo como aplicado.

Los textos y la ayuda se actualizaron en español, inglés y portugués. La cancelación manual registra el resultado verificado en MESAPAY: no envía una devolución ni garantiza que el datáfono haya detenido una operación todavía activa.

## Validación y reversión

Se aprobaron 6.003 pruebas unitarias y 398 de integración. La compilación de producción y TypeScript pasan; ESLint no reporta errores (30 avisos preexistentes). La medición del motor modificado obtuvo 96,33 % de líneas y 93,54 % de ramas. Diez escenarios de navegador pasaron sobre la compilación de producción local en Chromium y WebKit móvil.

Pruebas con datos sintéticos cubren cancelación inmediata, evidencia, voucher, permisos, solicitudes concurrentes, consultas retenidas, envío inicial en curso y respuestas tardías. Se comprobaron los flujos en Chromium de escritorio y WebKit móvil, y las transacciones con PostgreSQL local. Las pruebas no realizan cobros, envíos a la DIAN ni correos reales.

No hay migraciones ni cambios de configuración. Para revertir, se puede activar la versión anterior; las decisiones ya guardadas permanecen como registros normales de pago y auditoría. La versión anterior no contiene la conciliación mejorada de referencias manuales ante respuestas tardías.
