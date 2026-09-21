-- La factura electrónica nominativa ya no pide dirección, ciudad ni
-- departamento del adquiriente: el bloque cac:PhysicalLocation es opcional
-- en el XML DIAN (la de consumidor final ya sale sin él). Las columnas
-- pasan a admitir NULL; las filas existentes conservan sus valores.

-- AlterTable
ALTER TABLE "BillingCustomer" ALTER COLUMN "address" DROP NOT NULL;
ALTER TABLE "BillingCustomer" ALTER COLUMN "municipalityCode" DROP NOT NULL;
ALTER TABLE "BillingCustomer" ALTER COLUMN "city" DROP NOT NULL;
ALTER TABLE "BillingCustomer" ALTER COLUMN "department" DROP NOT NULL;

-- AlterTable
ALTER TABLE "InvoiceRequest" ALTER COLUMN "address" DROP NOT NULL;
ALTER TABLE "InvoiceRequest" ALTER COLUMN "city" DROP NOT NULL;
ALTER TABLE "InvoiceRequest" ALTER COLUMN "department" DROP NOT NULL;
