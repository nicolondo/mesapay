# Integración de la auditoría — 9 de septiembre de 2026

Rama local: `codex/platform-hardening`. Trabajo aislado en `/tmp/mesapay-audit-resume`. Se conservó un checkpoint de la auditoría (`3431410`) y se integró `origin/main` en `d56288f`, con los cambios recientes de Claude. El checkout original de MESAPAY quedó intacto. No se desplegó ni se operaron pagos o documentos fiscales reales.

## Correcciones implementadas

- Límites de peticiones, origen y autorización compartida en las APIs; personal limitado al restaurante activo, acceso de invitado firmado por mesa/pedido y acceso del comensal identificado a sus propias cuentas. Sesiones de personal revocadas al cambiar credenciales, permisos o estado.
- Reserva de saldo en PostgreSQL, idempotencia de intentos y webhooks, protección contra pagos simultáneos, estados inciertos sin liberar automáticamente el saldo y límites acumulados de devoluciones. Conciliación manual con referencia, evidencia y auditoría transaccional, sin enviar cargos/devoluciones al proveedor.
- Protección de cuentas cerradas o con dinero reservado al añadir, cancelar o modificar líneas/descuentos. Cálculo coherente de impuestos añadidos, descuentos y propinas. Bloqueo del abono de reservas para evitar doble aplicación.
- Bloqueo de inventario verificado con PostgreSQL; reintentos persistentes del consumo para que pedidos antiguos con fallos no bloqueen el resto. Eventos compartidos entre procesos, reconexión del cliente y detección de operaciones financieras abandonadas.
- Importaciones con validación de cada redirección, DNS fijado a direcciones públicas y límite de tamaño descomprimido; imágenes SVG rasterizadas. Se retiró el registro completo de cuerpos/cabeceras del webhook de suscripción.
- Se conservaron la corrección DIAN del prefijo/sucursal, la identidad de comensales por comercio, los descuentos, la facturación al pagar, los avisos de caja y la cola/agente de impresión de Claude.
- Se corrigieron los errores de lint de React y tipos: sincronización de referencias tras el commit, reinicio de formularios al cambiar sus datos, capacidades del navegador con hidratación consistente y tiempos de vistas recibidos desde el servidor. No se desactivaron las reglas para hacer pasar la revisión.
- Migraciones versionadas, bloqueo del despliegue antes del build, comprobaciones antes de migrar y readiness del esquema. CI para aplicación y agente, pruebas de PostgreSQL y navegador; README de desarrollo y procedimiento de adopción del baseline.

## Validación local

| Comprobación | Resultado |
| --- | --- |
| Unitarias y rutas simuladas | 674 pruebas, 62 archivos: pasan |
| PostgreSQL 17 real, base local desechable | 12 pruebas: pasan |
| Navegador, escritorio y móvil Chromium | 4 pruebas: pasan; flujo QR/pedido y conciliación con fixtures locales |
| TypeScript | Pasa |
| Build de producción | Pasa |
| ESLint | 0 errores; 33 advertencias no bloqueantes |
| Agente de impresión | `go test ./...`: pasa |
| Migraciones | Baseline, hardening y reintentos aplicados en base vacía de pruebas |
| SQL/shell/diff | `git diff --check` y `bash -n`: pasan |

Las pruebas de PostgreSQL cubren cobros simultáneos, reenvío del mismo token, impuestos/descuentos, webhooks duplicados y rollback, aprobación tardía, devoluciones concurrentes, conciliación auditada, separación entre restaurantes, suscripciones duplicadas, inventario e invalidación de sesiones. Las pruebas de navegador usan exclusivamente un restaurante, usuarios y pagos ficticios.

## Límites y siguiente integración

Esta tanda corrige los riesgos funcionales priorizados; no equivale a una certificación completa de todos los módulos. Siguen como trabajo de evolución la división de componentes grandes, la eliminación de textos/formateos regionales heredados y una cobertura funcional completa de todos los módulos ERP. Las 33 advertencias de lint están visibles, no suprimidas globalmente.

Para desplegar, ensayar primero sobre una copia restaurada de la base real y seguir `vps/blue-green/SETUP.md`. El baseline representa `d56288f`; una instalación con otro esquema necesita un diff revisado antes de marcarlo como aplicado. La aceptación final del documento de Son y Melona debe comprobarse con la DIAN en su ambiente de habilitación. No se enviaron documentos para probar esta integración. Tampoco se probó una impresora física ni el instalador de Windows en este turno.

Para continuar con Claude: partir de `codex/platform-hardening` o integrar su diff contra `d56288f`. No volver a aplicar el checkpoint antiguo del checkout original: sus cambios ya forman parte de esta rama. Los helpers de pago dependen de las migraciones; no copiar sólo las rutas y omitir los triggers.
