# Costeo desde compras recibidas

Las facturas importadas podían registrar una compra sin presentación de proveedor. La recepción actualizaba inventario, pero sólo actualizaba el precio del proveedor cuando la línea tenía una presentación asociada. Un insumo no inventariable o agotado quedaba sin fuente de costo aunque tuviera compras recibidas. La lista de Insumos mostraba únicamente la referencia manual, aumentando la confusión.

## Resultado

- Las recetas consultan el costo de compras recibidas. La prioridad es inventario, subreceta, referencia manual, compra recibida y proveedor preferido. Una referencia manual explícita, incluido cero, se conserva.
- El costo de compra es el promedio ponderado de la cantidad efectivamente recibida de una misma OC e insumo. Suma movimientos inventariables y costos/impuestos no inventariables congelados al recibir; no vuelve a calcular impuestos históricos ni descuenta retenciones. Agrupar antes de unir evita duplicar movimientos de insumos repetidos en la factura.
- Borradores, cancelaciones y cantidades sin recibir no aportan costo. La evidencia inconsistente no genera un importe inventado ni provoca volver silenciosamente a una compra anterior más barata.
- La recepción guarda `PurchaseOrderItem.lastReceivedAt`, independiente de pagos posteriores. La migración `20261108160000_purchase_line_received_at` añade únicamente una columna nullable. Para datos anteriores se usa evidencia existente y se identifica cuando sólo está disponible la fecha de registro de una compra parcial.
- Insumos muestra el costo usado en recetas, su origen y, cuando corresponde, la compra y fecha verificable. La referencia manual sigue siendo un campo separado. Abrir la compra desde el editor conserva el borrador abriendo otra pestaña.
- Volver a Recetas actualiza los costos sin perder cantidades o notas que todavía no se han guardado. Textos en español, inglés y portugués.

## Recuperación histórica

Se realiza por lectura: no requiere volver a recibir facturas, escribir precios manuales, revalorizar existencias ni regenerar asientos o cuentas por pagar. La comprobación de Son y Melona recuperó 135 costos de insumos comprados y 12 preparaciones derivadas; 90 recetas adicionales obtuvieron costo completo. Permanecen identificados los insumos sin compras recibidas vinculadas ni otras fuentes de costo. No se fusionan insumos por semejanza de nombre.

Las pruebas cubren IVA/consumo históricos, descuentos, referencias manuales, cantidades parciales y repetidas, aislamiento de comercios, fechas estables, recuperación de recetas y conservación de registros. Se revisó la interfaz en Chrome y Safari móvil. La evidencia operativa se conserva fuera del repositorio; no se incluyen documentos ni datos de compras reales en pruebas versionadas.

La reversión de código puede dejar la columna nullable: el código anterior la ignora. No borrar esa evidencia de recepción durante un rollback.
