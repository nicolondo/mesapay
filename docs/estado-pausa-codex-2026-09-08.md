# Estado de trabajo para continuar con Claude

El usuario pidió cerrar esta tanda rápidamente y pausar para trabajar con Claude. No se hicieron commits, push ni despliegues. Se preservaron los commits de Claude hasta `0186de0`.

Los cambios locales incluyen permisos por restaurante y capacidades de acceso al QR, revocación de sesiones, controles de pagos demo en producción, reserva de saldo, procesamiento transaccional de webhooks, protección de reintentos y devoluciones, impuestos en totales, bloqueo de inventario, protección SSRF, eventos compartidos por PostgreSQL, migraciones versionadas y traducciones nuevas es/en/pt. Muchas rutas tienen un cambio mecánico para aplicar `secureApi`.

## Antes de desplegar

Esta tanda **no equivale a terminar toda la auditoría**. Requiere pruebas funcionales de checkout/QR/pickup, cobros parciales, devoluciones y permisos con roles reales. El lint conserva 50 errores (React hooks y tipos `any`) presentes en la revisión inicial. El nuevo script de despliegue exige lint: fallará hasta resolverlos. No deshabilitar las reglas globalmente.

El esquema usa nuevas columnas y triggers. No ejecutar esta versión contra la base existente sin migraciones. Las dos migraciones se probaron en una base temporal PostgreSQL 17; NO se aplicaron a desarrollo habitual ni producción.

Para instalaciones existentes creadas con `db push`, se debe verificar primero que la base corresponde exactamente a `20260908000000_baseline` (incluye barcode de Claude), con copia de seguridad y prueba de restauración. Solo entonces se puede registrar esa baseline con `prisma migrate resolve --applied 20260908000000_baseline` y aplicar el hardening mediante `prisma migrate deploy`. No marcarla aplicada a ciegas; nunca usar `--accept-data-loss`. Las migraciones deben mantenerse compatibles con el proceso anterior durante blue/green.

## Pendiente prioritario

- Pruebas de integración concurrentes contra PostgreSQL: reservas, webhooks duplicados, devoluciones, inventario y revocación JWT. Las pruebas unitarias no reemplazan estas verificaciones.
- Revisar todas las rutas afectadas por `secureApi` y verificar sesiones de operador/mesero/group_admin y cookies de QR detrás del proxy real.
- Terminar un flujo visible de conciliación para pagos/refunds inciertos; actualmente se conservan pendientes y no se debe repetir el cobro sin verificar el proveedor. `Payment.reconciliationRequired`, `refundReservedCents` y `FinancialOperation` permiten detectarlos.
- Los eventos de pantalla se comparten por DB; la entrega exacta de impresión y tareas de correo no está garantizada. Revisar reconexiones, deduplicación de impresión y cola durable.
- El barrido de inventario ya no limita a 48 horas; falta resolver paginación ante 500 órdenes fallidas antiguas. Configurar el cron autenticado y alertas por errores/conciliación.
- Completar la revisión de APIs de suscripción (reintentos externos y eventos fallidos), i18n legacy, mensajes push, importes/monedas, accesibilidad y separación de componentes grandes.
- Añadir CI y runbooks de operaciones. El informe original describe los demás hallazgos.

No tocar `.agents/` ni `.codex/` preexistentes al preparar un commit. No incluir credenciales ni archivos temporales. Consultar `git diff` y mantener los cambios posteriores de Claude al retomar.

## Validación al pausar

- `npm test`: 34 archivos y 312 pruebas pasan (20 nuevas para acceso firmado, URLs internas, importes, demo y total con impuesto).
- `npx tsc --noEmit`: pasa.
- `npm run build`: pasa con la base temporal, sin modificar la base habitual. Permanecen avisos de middleware deprecado, raíz Turbopack y rutas dinámicas de filesystem.
- `npx eslint src`: 50 errores y advertencias pendientes; no se ocultaron las reglas.
- `git diff --check` y `bash -n vps/blue-green/activate.sh`: pasan.
- Migraciones baseline y hardening: aplicadas correctamente en la base aislada `mesapay_hardening` en PostgreSQL 17, puerto 5548.

La tanda queda guardada localmente, sin commit ni despliegue, y Codex queda pausado hasta nuevo aviso del usuario.
