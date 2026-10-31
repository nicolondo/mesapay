-- Análisis de ventas: cuentas pagadas de un comercio por rango de fecha de
-- pago. Sólo agrega un índice (sin tocar datos); una versión anterior de la
-- aplicación lo ignora sin problema. Rollback: DROP INDEX del mismo nombre.
CREATE INDEX "Order_restaurantId_status_paidAt_idx" ON "Order"("restaurantId", "status", "paidAt");
