# Notas crédito electrónicas

## Uso

En **Facturas → Notas crédito**, un administrador puede buscar una factura aceptada por la DIAN por su número o código de pedido. El módulo de facturación electrónica debe estar habilitado.

1. Antes de emitir la primera nota, revisar el prefijo y próximo consecutivo en **Numeración de notas crédito**. El valor inicial es `NC1`; si el emisor ya utiliza esa serie en otro sistema, se debe configurar una serie o consecutivo disponible. No se permite retroceder un contador usado.
2. Seleccionar la factura original y elegir ajuste total o parcial. Los ajustes parciales se introducen como importes, con impuestos incluidos, por línea original.
3. Elegir el motivo DIAN y explicar el ajuste. Revisar base, impuestos y total antes de confirmar. La anulación exige la factura completa, sin ajustes anteriores reservados.
4. Confirmar crea y reserva una sola nota. La pantalla intenta enviarla; el cron existente de DIAN recupera envíos pendientes y consulta su resultado.
5. Al ser aceptada, se puede descargar PDF/XML, imprimir una copia, consultar el CUDE/QR y reenviar el correo al destinatario original. El PDF/XML también está disponible mediante un enlace privado para el cliente.

La nota ajusta fiscalmente la factura. No ejecuta una devolución de dinero, no cambia el estado pagado del pedido y no mueve inventario. Los reembolsos se gestionan por separado. Si la cuenta se cobró a crédito de cliente y ese crédito tiene saldo, la nota aceptada sí baja la deuda del cliente (ver «Contabilidad e impuestos»).

## Contabilidad e impuestos

Sólo cuentan las notas **aceptadas por la DIAN** y no descartadas; una nota rechazada, pendiente o descartada no toca libros ni reportes. El dato sale del `snapshot.lines` de la nota (lo que declaró su XML), agrupado por tarifa (IVA x %, INC x %, sin impuesto), nunca del pedido actual. Base + impuesto tiene que cuadrar al centavo con `subtotalCents`, `taxCents` y `totalCents`; una nota que no cuadra se excluye de contabilidad, impuestos, exógena y libro de ventas, y queda en el log (`[creditNotes] nota crédito que no cuadra`).

**Fecha fiscal.** El día colombiano del instante de emisión firmado (`DianDocument.issuedAt`, el mismo `dianIssueDateTime` del XML y del CUDE). Ya estaba persistido junto con el XML firmado; no hizo falta una columna nueva.

**Asiento mensual «Notas crédito del mes»** (`source = credit_note`, regenerable como los demás resúmenes del motor):

| Cuenta | Débito | Crédito |
|---|---|---|
| 417505 Devoluciones en ventas | base de las notas | |
| IVA generado por tarifa (24080501 19 %, 24080503 5 %) / 241205 INC | impuesto de las notas | |
| 130505 Clientes | | parte que canceló cartera de crédito de cliente |
| 238020 Reintegros por pagar (devoluciones a clientes) | | el resto: lo que el comercio le debe devolver al cliente |

- **Contrapartida.** Al aceptarse la nota se fija una sola vez (`CreditNote.receivableCents`) cuánto de ella cancela cartera: si la cuenta se cobró a crédito de cliente (`customer_credit`), hasta el saldo pendiente FIFO de ese cargo. Esa parte baja también la deuda del cliente (`Payment.creditNoteCents`, que pesa como un reembolso en `customerCredit.chargeDebtCents`, la cartera y el tope de crédito). Si el cliente ya había pagado la cuenta, o se cobró de contado, va a 238020.
- **Por qué 238020.** Es la subcuenta «Reintegros por pagar» de acreedores varios (2380) del PUC: una obligación de devolver dinero de una venta ya reversada. No se usa 2805 (anticipos y avances recibidos) porque no es plata recibida antes de entregar el bien o servicio. La siembra incremental del plan de cuentas la crea en los comercios existentes la próxima vez que se abre la contabilidad (mismo mecanismo que usó 130505 en #485). La valida el contador.
- **Mes.** El mes fiscal de la nota si está abierto. Si ya está cerrado cuando la nota se acepta (o se cerró antes de regenerar el diario), la nota entra en el **primer mes abierto** (cierre + 1), igual que las reversas de comprobantes. Una vez incluida en un asiento queda marcada (`CreditNote.postedMonth`) y no se mueve aunque después se cierren o reabran meses. La pantalla de la nota muestra «Contabilizada en <mes>» o «Pendiente de contabilizar …» (con el aviso de mes cerrado).
- **Reembolso posterior (sin doble conteo).** Notas y reembolsos de la pasarela del mismo pedido se cruzan en orden cronológico. Un reembolso hecho **después** de la nota debita 238020 (hasta lo que la nota dejó pendiente) contra la pasarela en «Devoluciones del mes», en vez de volver a debitar devoluciones e impuesto. Un reembolso hecho **antes** de la nota ya se asentó como devolución estimada: la nota no repite esa parte (se asienta sólo lo no cubierto, prorrateado por tarifa).

**Reportes de impuestos.** «Impuestos del período» resta las notas con fecha fiscal en el período de la tarifa de cada línea y muestra impuesto bruto, devoluciones, notas crédito y neto. «Impuestos detallados» (pantalla y CSV) lista cada nota como documento negativo con su número NC…, fecha fiscal, el tercero de la factura original y la factura que ajusta. Los reembolsos ligados a una nota (antes o después) ya no se restan aparte como devolución estimada. El cruce documental vs libro puede mostrar diferencia en un mes cuando una nota de un mes fiscal cerrado quedó asentada en el primer mes abierto: es esperado.

**Exógena.** Las notas del año (fecha fiscal) restan al tercero de la factura original, consumidor final incluido: la base va a «devoluciones, rebajas y descuentos» del 1007, el IVA a «IVA resultante por devoluciones en ventas» del 1005 y el INC se netea del 1006 (sin bajar de cero; el formato no tiene casilla de INC devuelto).

**Libro de ventas.** El libro de ventas, su CSV y la hoja «Ventas» del Excel para el contador listan las notas del mes en negativo (número de la nota y factura que ajusta); el total del Excel queda neto de notas.

**Fuera de alcance.** El estado de resultados operativo de la pestaña Contabilidad (calculado desde las cuentas pagadas, que tampoco resta reembolsos) no cambia; el estado de resultados, balance, diario y mayor de Reportes salen de los asientos y sí reflejan las notas.

## Reglas de integridad

- Los datos provienen del XML aceptado y firmado de la factura original. Se congelan emisor, adquiriente, líneas, impuestos, referencia CUFE, correo e idioma. Cambiar después el menú o el cliente no altera la nota.
- La primera versión admite el perfil de facturas COP emitido por MESAPAY: unidades enteras, un impuesto IVA/INC por línea y sin descuentos/cargos o retenciones externos al perfil soportado. Los documentos incompatibles se bloquean; no se reconstruyen con datos actuales.
- El saldo disponible descuenta notas aceptadas y notas todavía reservadas. Una nota rechazada conserva su reserva hasta descartarla expresamente. Los documentos aceptados o con envío incierto no pueden descartarse. Los consecutivos nunca se reutilizan.
- La clave de solicitud recupera el mismo documento ante fallos de conexión. Una revisión obsoleta exige revisar nuevamente los importes. Se bloquean colisiones de números incluso entre prefijos distintos.
- El número fiscal es independiente del número anual de archivo técnico DIAN. Contador de archivo, XML firmado comprimido, CUDE, nombre y fecha se guardan juntos en una transacción. Los reintentos consultan el CUDE y reutilizan exactamente esos bytes.
- Las escrituras de emisión comparan un token de exclusión y la versión leída. Un proceso vencido no puede sustituir un documento aceptado ni reconstruir el XML que guardó otro proceso.
- Agotar los reenvíos automáticos no detiene la consulta del estado de un envío incierto. El código de estado DIAN `90` y la regla de documento duplicado `90` se tratan de forma diferente.
- Si la DIAN devuelve un CUDE diferente, se conserva la respuesta y sus reglas, pero no se acepta la nota ni se libera su saldo. Un rechazo `99` con regla `90` se diagnostica como conflicto de numeración únicamente cuando el acuse referencia el mismo número, emisor y ambiente, y su CUDE coincide con el identificador ajeno devuelto. El UUID raíz del `ApplicationResponse` no se usa como CUDE del documento.
- Un conflicto confirmado detiene los reenvíos automáticos y oculta **Enviar / reintentar**. **Consultar estado DIAN** permite reconciliar exclusivamente una respuesta definitiva correspondiente al CUDE guardado. Una consulta no encontrada, incierta o fallida conserva la evidencia y la reserva. Cambiar el prefijo solo afecta notas nuevas: no renumera ni reescribe una nota firmada. Nunca se fuerza la aceptación ni se borra la nota; reemplazarla es una acción explícita del comercio (ver «Notas fallidas»).
- El AttachedDocument verifica el CUDE y aceptación del acuse, se firma y se almacena una sola vez. Su descarga posterior no requiere volver a firmar ni mantener el certificado original vigente.
- Los permisos se verifican en el servidor. Los meseros no pueden crear, emitir o descargar notas por las rutas administrativas. Los enlaces públicos sólo muestran notas aceptadas y se sirven sin caché ni indexación.
- Restaurar un respaldo no puede borrar el historial fiscal de notas crédito. Se conservó la compatibilidad de respaldos anteriores a esta funcionalidad cuando el comercio no tiene notas.

## Notas fallidas: descartar y emitir de nuevo

Descartar **no borra** nada: la nota y su documento DIAN quedan para auditoría (evento `credit_note.abandon`), el número nunca se reutiliza y la factura queda libre para otra nota. La lista oculta las descartadas por defecto («Ver descartadas (N)»).

Una nota se puede descartar (`canAbandon` en `creditNotes/domain.ts`, clasificación en `creditNoteFailure` de `creditNoteResponse.ts`) cuando:

- nunca se firmó ni se envió (sin XML y 0 intentos), o
- está **rechazada por la DIAN de forma definitiva**: estado `rejected`, el conflicto de numeración `dian_numbering_conflict` (IsValid=false, 99, regla 90, verificado contra el acuse) o un CUDE ajeno cuya respuesta guardada sea IsValid=false + StatusCode 99, o
- está **«No recibida por la DIAN»** (`lastError = dian_not_received`).

Un error de canal (timeout, 5xx, Fault SOAP, respuesta ilegible), un envío `sent` o una nota `pending` **no** se pueden descartar: la DIAN todavía podría tenerla como válida.

**Consulta de estado.** Producción envía con `SendBillSync`, que no devuelve ZipKey: la consulta es `GetStatus` con el **CUDE** guardado. `GetStatusZip` sólo se usa con el ZipKey de un envío asíncrono del set de pruebas; un `trackId` vacío o en blanco nunca se consulta. Un trackId vacío en producción es lo esperado y no causa el código 66.

**Umbral de «No recibida por la DIAN»** (`creditNoteDeliveryState.ts`): la consulta de estado devolvió «no encontrado» (66/90) **al menos 3 veces seguidas** (`DianDocument.statusNotFoundCount`) y pasaron **24 horas** desde la emisión firmada (`issuedAt`). SendBillSync es síncrono: un documento validado aparece en la consulta en segundos. Cualquier otra respuesta de la DIAN reinicia la racha; un fallo de canal no la cambia. Mientras quedan reenvíos automáticos se retransmiten los mismos bytes; la marca la pone una consulta sin reenvío (barrido con los reenvíos agotados o **Consultar estado DIAN**). Una nota marcada sale del barrido; **Consultar estado DIAN** y **Enviar / reintentar** siguen disponibles, y si la DIAN responde que la tiene (aceptada o rechazada con ese CUDE) gana la DIAN y el estado se actualiza. Un fallo de canal o de configuración posterior no borra la marca. Una nota descartada ya no se consulta.

**Descartar y emitir de nuevo** (`reissueCreditNote`): en una transacción descarta la nota y crea el reemplazo para la misma factura, con el mismo motivo, explicación e importes por línea (la anulación, motivo 2, se reemite total), y la pantalla lo envía a la DIAN. Es idempotente (`requestId = reissue:<id>`), el reemplazo registra `replacesCreditNoteId` en su auditoría y no se puede reemitir una nota ya descartada (se usa el flujo normal, así no se duplica un reemplazo hecho por otro camino).

**Serie de una nota nueva** (`chooseCreditNotePrefix`): se usa el prefijo configurado (`DianConfig.creditNotePrefix`) salvo que su serie esté **en conflicto**: alguna de sus notas —descartadas incluidas— recibió el rechazo regla 90 y ninguna nota posterior de esa serie fue aceptada. En ese caso se usa otra serie del mismo NIT y ambiente, sin conflicto, válida y con al menos una nota aceptada (la de aceptación más reciente). Si no existe, no se emite: hay que configurar un prefijo nuevo, y la pantalla de numeración lo explica. Una serie en conflicto no se puede volver a configurar (`series_in_conflict`). La decisión se recalcula desde la evidencia fiscal; no reescribe la configuración. Con `NC` en conflicto y `NCM1` aceptada, las notas nuevas y los reemplazos salen en `NCM`.

## Instalación y operación

La migración aditiva `20261031140000_credit_note_status_not_found` agrega `DianDocument.statusNotFoundCount` (entero, default 0). Las notas existentes arrancan en 0: alcanzan el umbral con consultas nuevas, sin migración de datos.

La contabilidad de las notas agrega la migración aditiva `20261006120000_credit_note_accounting` (columnas nullable en `CreditNote` y `Payment.creditNoteCents` con default 0). Esta versión incorpora la migración aditiva `20261002190000_electronic_credit_notes`, dependencias de generación PDF y fuentes con licencia OFL en `public/fonts`. El despliegue debe ejecutar los pasos normales `npm ci`, `prisma generate` y `prisma migrate deploy`, conservar los archivos públicos y reiniciar la aplicación.

No se añadieron credenciales nuevas. Se reutilizan certificado, software, PIN, ambiente y set de pruebas DIAN del emisor, además del proveedor de correo ya configurado. Las notas crédito no consumen la resolución de facturas ni requieren su clave técnica. Su emisor y ambiente deben coincidir con la factura de referencia.

El cron `POST /api/cron/dian-emit` mantiene su autenticación y ahora procesa también la cola de notas. No se debe activar un segundo cron separado que duplique este trabajo.

Para validar después del despliegue, primero comprobar el acceso y la configuración sin crear una nota. Una prueba real requiere seleccionar expresamente la factura, motivo e importe autorizados; no se deben utilizar facturas reales como datos de prueba improvisados.

## Verificación de esta implementación

Se verificaron firma y esquema XSD oficiales de la nota y su contenedor, cálculo del CUDE con el vector oficial, concurrencia en PostgreSQL, aislamiento entre comercios, reservas, recuperación de envíos y numeración anual. También se probaron revisión y confirmación explícita en móvil y escritorio, y las API reales usando datos ficticios locales.

Las pruebas SOAP y correo no transmiten documentos ni mensajes reales. Validar el XSD y las firmas localmente no equivale a obtener aceptación de una nota real en la DIAN.

Referencias primarias:

- [Anexo técnico DIAN 1.9](https://www.dian.gov.co/impuestos/factura-electronica/Documents/Anexo-Tecnico-Factura-Electronica-de-Venta-vr-1-9.pdf): notas crédito, CUDE, QR, contenedor y nombres de archivo.
- [Caja de herramientas DIAN 2026](https://www.dian.gov.co/impuestos/factura-electronica/Documents/Caja-de-herramientas-FE_V19_v2026.zip): esquemas y motivos de nota crédito.
