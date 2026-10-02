# Notas crédito electrónicas

## Uso

En **Facturas → Notas crédito**, un administrador puede buscar una factura aceptada por la DIAN por su número o código de pedido. El módulo de facturación electrónica debe estar habilitado.

1. Antes de emitir la primera nota, revisar el prefijo y próximo consecutivo en **Numeración de notas crédito**. El valor inicial es `NC1`; si el emisor ya utiliza esa serie en otro sistema, se debe configurar una serie o consecutivo disponible. No se permite retroceder un contador usado.
2. Seleccionar la factura original y elegir ajuste total o parcial. Los ajustes parciales se introducen como importes, con impuestos incluidos, por línea original.
3. Elegir el motivo DIAN y explicar el ajuste. Revisar base, impuestos y total antes de confirmar. La anulación exige la factura completa, sin ajustes anteriores reservados.
4. Confirmar crea y reserva una sola nota. La pantalla intenta enviarla; el cron existente de DIAN recupera envíos pendientes y consulta su resultado.
5. Al ser aceptada, se puede descargar PDF/XML, imprimir una copia, consultar el CUDE/QR y reenviar el correo al destinatario original. El PDF/XML también está disponible mediante un enlace privado para el cliente.

La nota ajusta fiscalmente la factura. No ejecuta una devolución de dinero, no cambia el estado pagado del pedido y no mueve inventario. Los reembolsos se gestionan por separado.

## Reglas de integridad

- Los datos provienen del XML aceptado y firmado de la factura original. Se congelan emisor, adquiriente, líneas, impuestos, referencia CUFE, correo e idioma. Cambiar después el menú o el cliente no altera la nota.
- La primera versión admite el perfil de facturas COP emitido por MESAPAY: unidades enteras, un impuesto IVA/INC por línea y sin descuentos/cargos o retenciones externos al perfil soportado. Los documentos incompatibles se bloquean; no se reconstruyen con datos actuales.
- El saldo disponible descuenta notas aceptadas y notas todavía reservadas. Una nota rechazada conserva su reserva hasta descartarla expresamente. Los documentos aceptados o con envío incierto no pueden descartarse. Los consecutivos nunca se reutilizan.
- La clave de solicitud recupera el mismo documento ante fallos de conexión. Una revisión obsoleta exige revisar nuevamente los importes. Se bloquean colisiones de números incluso entre prefijos distintos.
- El número fiscal es independiente del número anual de archivo técnico DIAN. Contador de archivo, XML firmado comprimido, CUDE, nombre y fecha se guardan juntos en una transacción. Los reintentos consultan el CUDE y reutilizan exactamente esos bytes.
- Las escrituras de emisión comparan un token de exclusión y la versión leída. Un proceso vencido no puede sustituir un documento aceptado ni reconstruir el XML que guardó otro proceso.
- Agotar los reenvíos automáticos no detiene la consulta del estado de un envío incierto. El código de estado DIAN `90` y la regla de documento duplicado `90` se tratan de forma diferente.
- El AttachedDocument verifica el CUDE y aceptación del acuse, se firma y se almacena una sola vez. Su descarga posterior no requiere volver a firmar ni mantener el certificado original vigente.
- Los permisos se verifican en el servidor. Los meseros no pueden crear, emitir o descargar notas por las rutas administrativas. Los enlaces públicos sólo muestran notas aceptadas y se sirven sin caché ni indexación.
- Restaurar un respaldo no puede borrar el historial fiscal de notas crédito. Se conservó la compatibilidad de respaldos anteriores a esta funcionalidad cuando el comercio no tiene notas.

## Instalación y operación

Esta versión incorpora la migración aditiva `20261002190000_electronic_credit_notes`, dependencias de generación PDF y fuentes con licencia OFL en `public/fonts`. El despliegue debe ejecutar los pasos normales `npm ci`, `prisma generate` y `prisma migrate deploy`, conservar los archivos públicos y reiniciar la aplicación.

No se añadieron credenciales nuevas. Se reutilizan certificado, software, PIN, ambiente y set de pruebas DIAN del emisor, además del proveedor de correo ya configurado. Las notas crédito no consumen la resolución de facturas ni requieren su clave técnica. Su emisor y ambiente deben coincidir con la factura de referencia.

El cron `POST /api/cron/dian-emit` mantiene su autenticación y ahora procesa también la cola de notas. No se debe activar un segundo cron separado que duplique este trabajo.

Para validar después del despliegue, primero comprobar el acceso y la configuración sin crear una nota. Una prueba real requiere seleccionar expresamente la factura, motivo e importe autorizados; no se deben utilizar facturas reales como datos de prueba improvisados.

## Verificación de esta implementación

Se verificaron firma y esquema XSD oficiales de la nota y su contenedor, cálculo del CUDE con el vector oficial, concurrencia en PostgreSQL, aislamiento entre comercios, reservas, recuperación de envíos y numeración anual. También se probaron revisión y confirmación explícita en móvil y escritorio, y las API reales usando datos ficticios locales.

Las pruebas SOAP y correo no transmiten documentos ni mensajes reales. Validar el XSD y las firmas localmente no equivale a obtener aceptación de una nota real en la DIAN.

Referencias primarias:

- [Anexo técnico DIAN 1.9](https://www.dian.gov.co/impuestos/factura-electronica/Documents/Anexo-Tecnico-Factura-Electronica-de-Venta-vr-1-9.pdf): notas crédito, CUDE, QR, contenedor y nombres de archivo.
- [Caja de herramientas DIAN 2026](https://www.dian.gov.co/impuestos/factura-electronica/Documents/Caja-de-herramientas-FE_V19_v2026.zip): esquemas y motivos de nota crédito.
