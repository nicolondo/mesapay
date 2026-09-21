-- Cuenta de origen del abono a proveedor (caja/banco); null en los históricos.
ALTER TABLE "PurchasePayment" ADD COLUMN "accountCode" TEXT;
