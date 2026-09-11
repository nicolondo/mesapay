CREATE TABLE "BillingCustomer" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "docType" "InvoiceDocType" NOT NULL,
    "docNumber" TEXT NOT NULL,
    "verificationDigit" TEXT,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "address" TEXT NOT NULL,
    "municipalityCode" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "department" TEXT NOT NULL,
    "country" TEXT NOT NULL DEFAULT 'CO',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BillingCustomer_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BillingCustomer_restaurantId_docType_docNumber_key" ON "BillingCustomer"("restaurantId", "docType", "docNumber");
CREATE INDEX "BillingCustomer_restaurantId_customerName_idx" ON "BillingCustomer"("restaurantId", "customerName");
ALTER TABLE "BillingCustomer" ADD CONSTRAINT "BillingCustomer_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
