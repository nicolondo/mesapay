# Gastos de representación y productos no cobrados

Los administradores encuentran ambos informes directamente en el menú **Negocio**, y también como accesos desde **Cierre**:

- `/operator/reports/gastos-representacion`: cuentas cerradas con la opción de gastos de representación. Permite consultar las cuentas/mesas o sus productos y abrir el detalle de una cuenta.
- `/operator/reports/no-cobrados`: productos cancelados, cortesías individuales y productos incluidos en gastos de representación, con fecha, motivo y responsable.

Ambos permiten elegir fechas, todo el historial, buscar por producto/motivo/mesa/código y filtrar por correo del responsable. El segundo también permite filtrar por tipo. El CSV descarga todos los registros del filtro, independientemente de la página visible.

## Definición de los datos

- Un cierre de representación se identifica por `Order.compedAt`. Conserva `compLabel`, `compNote` y `compAmountCents`, aunque luego cambie la configuración del restaurante.
- Sólo pertenecen a ese cierre los productos con `cancellationKind=comp` y `cancelledAt=compedAt`. Las cortesías individuales anteriores no se vuelven a sumar como representación.
- Una cancelación puede estar registrada en el producto o en su ronda. Se toma la primera fecha válida, con motivo y responsable de ese mismo evento; en empate prevalece el producto. No se cuentan dos veces.
- `priceCentsSnapshot * qty` ya incluye modificadores. Los valores no son costo de inventario ni pérdida neta de caja; excluyen propina, descuentos de cuenta e impuestos adicionales de líneas libres.
- El total del cierre usa el valor histórico guardado, incluso si es cero. Si falta, se calcula desde sus productos conservados. Si tampoco hay productos, se muestra como desconocido, sin inventar cero. Las discrepancias entre cierre y detalle se señalan.
- La mesa mostrada es la actualmente vinculada a la cuenta. Los movimientos no conservan una mesa histórica en cada cancelación. Productos borrados físicamente sin registro no pueden reconstruirse. Un estado de cuenta `cancelled` por sí solo no constituye una cancelación: también se usa al trasladar todos sus productos.
- Los días respetan `businessDayCutoffHour` en Bogotá, con inicio inclusivo y fin exclusivo.

## Lectura, permisos y exportación

Las rutas API equivalentes bajo `/api/operator/reports/` aceptan `range=today|7d|30d|month|all`, o `desde`/`hasta`, además de `q`, `email`, `orderId`, `page` y `format=json|csv`. Representación acepta `vista=cuentas|productos`; no cobrados acepta `kind=all|cancel|comp|representation`, donde `comp` son cortesías individuales.

Acceso para administradores de restaurante, plataforma y grupo con comercio activo autorizado. No requiere el módulo contable ni que la opción de cortesía siga habilitada. Toda consulta se limita al comercio activo, usa parámetros SQL y respuestas privadas sin caché. Los endpoints tienen límite de frecuencia; el CSV protege texto contra fórmulas de hoja de cálculo.

Los agregados y la página se leen en una transacción `RepeatableRead`. La página muestra hasta 50 filas; los totales cubren todo el filtro. El CSV usa cursor estable por fecha/ID y lotes de 500, con memoria acotada y sin límite de registros. Excluye eventos posteriores al inicio de la exportación; no constituye una instantánea de correcciones retroactivas concurrentes. Un error durante la descarga interrumpe el cuerpo en lugar de finalizar un CSV incompleto como si fuera correcto.

No hay migraciones ni cambios a pedidos, pagos, inventario o facturación. Las pruebas usan exclusivamente una base PostgreSQL local aislada: filtros y CSV, permisos, precedencia de cancelaciones, snapshots, más de 500 productos, aislamiento entre restaurantes y recorridos en móvil/escritorio.
