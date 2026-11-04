-- Lista de Órdenes paginada por período (día/semana/mes/rango): sus dos
-- flujos filtran y ordenan por fecha sin estado fijo («Todas»), las cobradas
-- por "paidAt" y el resto por "createdAt". Sólo agrega índices (sin tocar
-- datos); una versión anterior de la aplicación los ignora sin problema.
-- Rollback: DROP INDEX de los mismos nombres.
CREATE INDEX "Order_restaurantId_paidAt_idx" ON "Order"("restaurantId", "paidAt");
CREATE INDEX "Order_restaurantId_createdAt_idx" ON "Order"("restaurantId", "createdAt");
