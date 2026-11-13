-- «Ajustes» / ajuste al peso de la factura del proveedor (aditiva, escrita a mano).
--
-- Centavos CON signo que la factura suma o resta al final para que el total a
-- pagar quede redondeado (p. ej. "Ajustes −0,32"). Es parte de la cuenta por
-- pagar —el saldo del proveedor es el Total impreso— pero no de ninguna línea:
-- no cambia el costo del inventario, ni el IVA, ni el consumo, ni las
-- retenciones. El asiento «Compras del día» lo lleva a gastos diversos.
-- Default 0: las compras existentes no cambian.
ALTER TABLE "PurchaseOrder" ADD COLUMN "roundingCents" INTEGER NOT NULL DEFAULT 0;
