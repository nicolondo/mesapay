# Recuperación de lecturas de facturas de compra

Una respuesta de IA que no se podía interpretar se devolvía como una extracción vacía con confianza cero. Compras la guardaba como carga pendiente y abría una revisión con total $0 y un fragmento técnico de la respuesta. El pantallazo confirma ese camino de error; no permite distinguir si la respuesta original quedó truncada o contenía JSON inválido. Los delimitadores Markdown válidos ya se eliminaban.

## Corrección

- La lectura comprueba la terminación del proveedor antes de interpretar el JSON. Una respuesta marcada como incompleta nunca se acepta, aunque su fragmento sea JSON válido.
- Se utiliza streaming interno con JSON compacto. Para Haiku/Sonnet 4.5 se amplía el presupuesto de salida de 8192 a 32000 tokens y hasta 64000 en un segundo intento. Otros modelos conservan el límite anterior.
- Como máximo se realizan dos lecturas del documento original. No se concatenan ni reparan fragmentos. Hay un plazo compartido de 480 segundos y se desactivan los reintentos HTTP adicionales del SDK.
- Los fallos devuelven códigos seguros, sin texto del documento. Compras no guarda el archivo ni una carga pendiente si la extracción falla o no contiene líneas utilizables después de la normalización existente.
- La pantalla conserva el archivo en memoria y ofrece **Reintentar lectura** y **Elegir otro archivo**. Bloquea envíos concurrentes y respuestas vacías; los mensajes están disponibles en español, inglés y portugués.
- Gastos conserva el adjunto cuando falla la IA, sin prellenar valores. Las cuentas de cobro válidas sin líneas continúan utilizando sus totales impresos.

No se modifican los cálculos de IVA, consumo, descuentos, retenciones, correspondencias de productos ni la confirmación manual. No hay cambios de esquema o dependencias.

## Validación

Regresiones con respuestas simuladas: JSON normal y con delimitadores, respuesta incompleta incluso con JSON válido, esquema inválido, negativa, recuperación en segundo intento, límites de reintentos, plazo compartido, modelo personalizado y factura completa de 100 líneas. Las rutas verifican ausencia de cargas pendientes en errores y conservación de adjuntos de gastos. La integración cubre edición, correspondencias, impuestos incluidos, descuentos, totales y retenciones.

Las pruebas usan documentos sintéticos y bases locales. No se creó una compra real ni se envió el documento del cliente a la IA; sólo se recibió el pantallazo del error.
