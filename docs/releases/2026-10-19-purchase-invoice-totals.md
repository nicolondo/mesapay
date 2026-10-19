# Importación de compras: totales con impuestos

La importación podía tomar un total final de línea como base antes de IVA y volver a gravarlo. También omitía el consumo fijo de licores. El caso reportado era dos botellas de $69.425: el total impreso de $138.850 debe permanecer en $138.850.

## Comportamiento

- La extracción conserva por separado precio unitario, total de línea, encabezado de origen y si cada importe incluye impuestos. La tarifa de IVA por sí sola no determina esa base.
- La revisión permite elegir importe unitario o de toda la línea, base con/sin impuestos, IVA y consumo total. Muestra el total final y el precio final por unidad antes de confirmar.
- Los totales de línea no se multiplican por la cantidad. Un precio unitario se multiplica una sola vez. Cambiar unidad, presentación o insumo conserva el importe previamente revisado.
- IVA documental y consumo se guardan separados del costo neto. El mismo cálculo se usa al guardar, recibir, valorar inventario, registrar pagos y consultar informes. Los centavos se conservan entre recepciones parciales.
- El consumo del resumen debe asignarse a sus líneas antes de confirmar. La asignación descuenta el saldo pendiente del resumen; no duplica el impuesto.
- Lecturas antiguas sin metadatos, tarifas ilegibles y consumo ambiguo exigen revisión. No se reinterpretan automáticamente como importes sin impuestos.
- Las cuentas por pagar se calculan con el saldo real. Una nueva recepción posterior al pago de un lote parcial vuelve a mostrar la deuda restante sin alterar abonos anteriores.

## Compatibilidad y operación

La migración `20261019150000_purchase_documentary_taxes` añade `expectedTaxCents` nullable, `expectedIncCents` con valor inicial cero y `nonInventoryReceivedIncCents` con valor inicial cero. El IVA null conserva el cálculo anterior por tarifa. No realiza backfill ni modifica facturas o movimientos de inventario existentes.

Las importaciones pendientes pueden releerse o revisarse con los nuevos controles. Las compras históricas ya confirmadas con importes incorrectos requieren revisión individual; este cambio no las reescribe.

## Validación

- 3.494 pruebas unitarias y 195 pruebas de integración con PostgreSQL 17 aprobadas.
- 26 pruebas de navegador: Chrome e iPhone, borrador/reapertura/recepción, precio unitario y total, IVA explícito, consumo ambiguo y asignación del resumen. Solo se simula la respuesta OCR; la persistencia es real en una base aislada.
- Caso de nueve líneas del documento: total final $1.419.725 e impuesto al consumo $337.722 conservados exactamente.
- Cobertura del núcleo backend: 94,63% líneas y 82,60% ramas. Interpretación/revisión: 100% líneas y 97,14% ramas.
- Compilación de producción, TypeScript, lint y revisión independiente aprobados. Los 31 avisos de lint son previos al cambio.
- No se efectuó una nueva solicitud de IA con el PDF real durante esta validación; los cálculos usan los valores impresos del documento y las pruebas del extractor simulan la respuesta del proveedor.
