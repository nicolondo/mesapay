-- User-confirmed invoice names. No catalog, prices or inventory are rewritten.
CREATE TABLE "SupplierInvoiceAlias" (
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "ingredientId" TEXT NOT NULL,
    "sourceDescription" VARCHAR(500) NOT NULL,
    "normalizedDescription" VARCHAR(500) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierInvoiceAlias_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SupplierInvoiceAlias_supplierId_normalizedDescription_key"
    ON "SupplierInvoiceAlias"("supplierId", "normalizedDescription");
CREATE INDEX "SupplierInvoiceAlias_ingredientId_idx"
    ON "SupplierInvoiceAlias"("ingredientId");

ALTER TABLE "SupplierInvoiceAlias" ADD CONSTRAINT "SupplierInvoiceAlias_supplierId_fkey"
    FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SupplierInvoiceAlias" ADD CONSTRAINT "SupplierInvoiceAlias_ingredientId_fkey"
    FOREIGN KEY ("ingredientId") REFERENCES "Ingredient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
