-- Envío automático de la factura electrónica (AttachedDocument) al
-- adquiriente cuando la DIAN acepta. `emailedAt` es la marca de
-- idempotencia: la aceptación puede verse por DOS caminos (la respuesta
-- síncrona de SendBillSync y la consulta diferida de GetStatusZip), y sin
-- esto el comensal recibiría el mismo correo dos veces.
-- `emailError` guarda por qué no salió (p. ej. "no_recipient": nadie pidió
-- factura en esa cuenta, que no es un error).
ALTER TABLE "DianDocument" ADD COLUMN "emailedAt" TIMESTAMP(3);
ALTER TABLE "DianDocument" ADD COLUMN "emailError" TEXT;
