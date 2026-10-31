-- Limpieza histórica de solicitudes de factura (InvoiceRequest) que ya
-- quedaron cubiertas por una factura electrónica ACEPTADA por la DIAN.
--
-- Solo datos: no cambia ninguna tabla, columna ni índice.
--
-- Por qué: con el módulo `einvoicing` la factura sale sola a la DIAN con los
-- datos del cliente y nadie marca la solicitud como generada; quedaban
-- `pending` para siempre. Desde este cambio la aceptación las cierra sola
-- (src/lib/dian/invoiceRequestClosure.ts). Esto cierra las de antes.
--
-- CONDICIÓN EXACTA (la misma, en TS y con tests, en
-- `historicalCleanupCloses` de src/lib/dian/invoiceRequestCoverage.ts).
-- Pasa a `generated` una InvoiceRequest si y sólo si:
--   1. ir.status = 'pending';
--   2. su comercio tiene el módulo einvoicing: Restaurant.enabledModules es
--      un arreglo JSON que contiene "einvoicing" (igual que isModuleEnabled);
--   3. la orden de la solicitud tiene SimpleInvoice con DianDocument de
--      kind = 'invoice' y state = 'accepted';
--   4. ir.createdAt <= GREATEST(DianDocument.createdAt, SimpleInvoice.createdAt).
--
-- Sobre el punto 4: la fecha de aceptación NO está guardada. DianDocument no
-- tiene fecha de aceptación; `updatedAt` se mueve con cada envío o reenvío
-- del correo (y una solicitud tardía dispara justamente un envío, así que
-- usarlo cerraría los casos que hay que mostrar); `emailedAt` lo pisa cada
-- reenvío; y la fecha de emisión vive dentro del XML zipeado, que SQL no
-- puede leer. La mejor aproximación SEGURA es una cota inferior: la factura
-- no se pudo emitir antes de que existieran la tirilla y el documento DIAN,
-- y en la emisión automática normal los dos nacen segundos antes de la
-- aceptación. Una solicitud anterior o igual a esa cota seguro estaba cuando
-- se emitió la factura. Las posteriores se dejan pendientes a propósito:
-- pueden ser casos "llegó después" (la factura ya había salido a consumidor
-- final) y la pantalla de Facturas los decide leyendo el XML aceptado.
--
-- Qué se escribe: status = 'generated', generatedAt = esa misma cota (cuando
-- ya existía la factura), updatedAt = ahora. generatedByEmail queda NULL
-- (no la marcó una persona). Nada más cambia.
UPDATE "InvoiceRequest" AS ir
SET "status" = 'generated'::"InvoiceRequestStatus",
    "generatedAt" = GREATEST(dd."createdAt", si."createdAt"),
    "generatedByEmail" = NULL,
    "updatedAt" = CURRENT_TIMESTAMP
FROM "SimpleInvoice" AS si
JOIN "DianDocument" AS dd ON dd."simpleInvoiceId" = si."id"
JOIN "Restaurant" AS r ON r."id" = si."restaurantId"
WHERE si."orderId" = ir."orderId"
  AND ir."status" = 'pending'::"InvoiceRequestStatus"
  AND jsonb_typeof(r."enabledModules") = 'array'
  AND r."enabledModules" @> '["einvoicing"]'::jsonb
  AND dd."kind" = 'invoice'
  AND dd."state" = 'accepted'
  AND ir."createdAt" <= GREATEST(dd."createdAt", si."createdAt");
