# Mejoras aprobadas — 2 de octubre de 2026

Entrega conjunta desde `063ba471`: entrada y navegación del comensal,
hora de pago en facturas e historial, copias de facturas, área segura móvil,
edición de insumos, confirmación para poner existencias en cero, permisos
de traslados, notas crédito electrónicas y cancelación de platos preparados.

Los permisos de traslado y cancelación se aplican por separado. Desde el
primer inicio de preparación, sólo administradores pueden cancelar o dejar
de cobrar. Los traslados de plato y cuenta completa comparten bloqueo y
revalidan origen, destino, pagos y sección del mesero dentro de la transacción.

## Verificación local

- 3.133 pruebas unitarias en 280 archivos.
- 109 pruebas PostgreSQL de la suite completa, más dos regresiones nuevas
  de traslado concurrente verificadas en la suite de cancelación (22/22).
- 37 pruebas de navegador sobre la compilación de producción, con datos
  ficticios: comensal, notas crédito, permisos, inventario y áreas seguras.
- TypeScript y compilación completos; ESLint sin errores, 31 advertencias
  preexistentes. Archivos de integración modificados sin advertencias.
- Base local vacía creada mediante las 37 migraciones, incluidos triggers
  financieros. El fixture de cierres ahora crea cuentas con saldo válido
  antes de pagarlas, conservando la comprobación de importes elevados.

No se emitieron documentos fiscales ni se alteraron pedidos reales para
validar la entrega. La prueba de descargas de nota crédito usa un documento
local marcado sin validez fiscal; no acredita aceptación real de DIAN.

## Despliegue

Publicación aprobada expresamente por el propietario. El procedimiento
blue/green compila, comprueba y aplica las migraciones antes de activar el
nuevo servicio, comprueba salud y luego cambia el tráfico.

Migraciones aditivas:

- `20261002150000_admin_only_table_move`
- `20261002190000_electronic_credit_notes`
- `20261002200000_preparation_cancellation_control`

Tras activar la versión, configurar `adminOnlyTableMove=true` exclusivamente
en `sonymelona`, registrando antes/después y versión en auditoría. El resto
de los comercios conserva su configuración. No hacer traslados, cancelaciones
o notas crédito reales como comprobación de publicación.

La integración Rappi sigue pendiente del acceso del proveedor; esta entrega
no la activa.
