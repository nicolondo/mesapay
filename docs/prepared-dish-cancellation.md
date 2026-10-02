# Cancelación de platos preparados

Desde el primer inicio de preparación, sólo los roles `operator`,
`platform_admin` y `group_admin` pueden cancelar o dejar de cobrar un plato.
La política es general: la lista configurable de cortesías del restaurante
no puede conceder este permiso a meseros, cocina o bar.

Antes de empezar se conservan los permisos anteriores. Los platos servidos
siguen usando **No cobrar** (`comp`) para conservar la distinción contable;
el administrador no los convierte en cancelación normal. Las facturas
manuales y las líneas libres no se consideran preparadas sólo por llevar
los sellos técnicos `ready`/`servedAt`.

## Garantías

- La API comprueba el rol y los datos actuales después de bloquear la orden.
  La comprobación cubre plato, ronda, cancelación de cuenta, cortesía completa
  y borrado desde la vista del comensal.
- `OrderItem.preparationFirstStartedAt` conserva el primer inicio conocido.
  Cambiar el estado a pendiente, deshacer la entrega, reiniciar el cronómetro
  del bar o trasladar el plato a otra mesa no borra esa evidencia.
- El rechazo HTTP 403 lleva `cancellation_admin_required`, traducido en
  español, inglés y portugués. Los importes, la disponibilidad del menú y
  los efectos de impresión/auditoría no cambian en una solicitud rechazada.
- Trasladar un plato bloquea y relee origen y destino en orden estable;
  comprueba pagos y recalcula ambas cuentas dentro de la transacción.
- La cancelación de una cuenta que ya empezó a prepararse conserva el flujo
  de resolver plato por plato con motivo. Se mantienen los límites de
  comercio y los bloqueos de cuentas pagadas o con pagos en curso.

## Publicación

Aplicar `20261002200000_preparation_cancellation_control` antes de iniciar
la nueva versión. La migración es aditiva y conserva la evidencia de platos
existentes a partir de sus sellos y estados; no cancela ningún plato.
Las fechas inferidas para registros antiguos son evidencia de preparación,
no una nueva medición exacta del tiempo de cocina.

Esta entrega se preparó desde `063ba471` en una rama aislada. No incluye las
notas crédito ni el ajuste configurable de permisos para mover mesas que
siguen en entregas separadas. No se ha publicado en producción.

## Verificación

Se prueban los roles y estados, el cambio de estado hacia atrás, rondas
mixtas, las cortesías habilitadas para meseros, la migración de registros
antiguos, excepciones manuales, límites de comercio y operaciones de cocina,
traslado y cancelación concurrentes con PostgreSQL real.

```sh
npm test
npx tsc --noEmit
npm run lint
npm run build
DATABASE_URL=postgresql://usuario@localhost:5548/mesapay_cancellation_validation \
  npx vitest run --config vitest.integration.config.ts \
  integration/cancellation-permissions.test.ts integration/platform.test.ts
DATABASE_URL=postgresql://usuario@localhost:5548/mesapay_cancellation_validation \
  PLAYWRIGHT_BASE_URL=http://localhost:3391 \
  npx playwright test e2e/cancellation-control.spec.ts --project=desktop
```

Las pruebas de integración y navegador sólo admiten base y aplicación
locales aisladas. No usar pedidos reales para comprobar las cancelaciones.
