-- AlterTable
ALTER TABLE "DianConfig" ADD COLUMN     "creditNotePrefix" TEXT NOT NULL DEFAULT 'NC';

-- AlterTable
ALTER TABLE "DianDocument" ADD COLUMN     "creditNoteId" TEXT,
ADD COLUMN     "issuedAt" TIMESTAMP(3),
ADD COLUMN     "leaseExpiresAt" TIMESTAMP(3),
ADD COLUMN     "leaseToken" TEXT;

-- CreateTable
CREATE TABLE "CreditNoteSeries" (
    "id" TEXT NOT NULL,
    "issuerNit" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "prefix" TEXT NOT NULL DEFAULT 'NC',
    "nextNumber" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "CreditNoteSeries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditNote" (
    "publicToken" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "originalInvoiceId" TEXT NOT NULL,
    "seriesId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "documentNumber" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "reasonText" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "subtotalCents" INTEGER NOT NULL,
    "taxCents" INTEGER NOT NULL,
    "totalCents" INTEGER NOT NULL,
    "createdById" TEXT,
    "abandonedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CreditNoteSeries_issuerNit_environment_prefix_key" ON "CreditNoteSeries"("issuerNit", "environment", "prefix");

-- CreateIndex
CREATE UNIQUE INDEX "CreditNote_publicToken_key" ON "CreditNote"("publicToken");

-- CreateIndex
CREATE INDEX "CreditNote_restaurantId_createdAt_idx" ON "CreditNote"("restaurantId", "createdAt");

-- CreateIndex
CREATE INDEX "CreditNote_originalInvoiceId_abandonedAt_idx" ON "CreditNote"("originalInvoiceId", "abandonedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CreditNote_restaurantId_requestId_key" ON "CreditNote"("restaurantId", "requestId");

-- CreateIndex
CREATE UNIQUE INDEX "CreditNote_seriesId_number_key" ON "CreditNote"("seriesId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "DianDocument_creditNoteId_key" ON "DianDocument"("creditNoteId");

-- AddForeignKey
ALTER TABLE "DianDocument" ADD CONSTRAINT "DianDocument_creditNoteId_fkey" FOREIGN KEY ("creditNoteId") REFERENCES "CreditNote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditNote" ADD CONSTRAINT "CreditNote_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditNote" ADD CONSTRAINT "CreditNote_originalInvoiceId_fkey" FOREIGN KEY ("originalInvoiceId") REFERENCES "SimpleInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditNote" ADD CONSTRAINT "CreditNote_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "CreditNoteSeries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditNote" ADD CONSTRAINT "CreditNote_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Fiscal invariants remain enforced for every writer, including maintenance.
ALTER TABLE "CreditNote" ADD CONSTRAINT "CreditNote_amounts_check" CHECK (
 "subtotalCents" > 0 AND "taxCents" >= 0 AND "totalCents" > 0
 AND "subtotalCents"::bigint + "taxCents"::bigint = "totalCents"::bigint
 AND "number" > 0 AND "reasonCode" IN ('1','2','3','4','5','6')
);
ALTER TABLE "CreditNoteSeries" ADD CONSTRAINT "CreditNoteSeries_scope_check" CHECK (
 "nextNumber" > 0 AND "environment" IN ('1','2') AND "prefix" ~ '^[A-Z0-9]{1,10}$'
);
ALTER TABLE "DianDocument" ADD CONSTRAINT "DianDocument_credit_reference_check" CHECK (
 ("creditNoteId" IS NULL AND "kind" <> 'credit_note')
 OR ("creditNoteId" IS NOT NULL AND "kind" = 'credit_note' AND "simpleInvoiceId" IS NULL)
) NOT VALID;
-- NOT VALID preserves older unlinked legacy notes, but protects every new write.

-- Signed AttachedDocument, frozen on first delivery and reused by email/download.
ALTER TABLE "DianDocument" ADD COLUMN "deliveryXml" TEXT;

-- Concatenated fiscal document numbers must be unique even across overlapping prefixes.
ALTER TABLE "CreditNote" ADD COLUMN "fiscalKey" TEXT;
UPDATE "CreditNote" AS n SET "fiscalKey" = s."issuerNit" || ':' || s."environment" || ':' || n."documentNumber" FROM "CreditNoteSeries" AS s WHERE n."seriesId" = s.id;
ALTER TABLE "CreditNote" ALTER COLUMN "fiscalKey" SET NOT NULL;
CREATE UNIQUE INDEX "CreditNote_fiscalKey_key" ON "CreditNote"("fiscalKey");

-- DIAN Annex1.9 transport file names use an annual sequence independent of fiscal numbering.
ALTER TABLE "DianDocument" ADD COLUMN "submissionFileName" TEXT;
CREATE TABLE "CreditNoteFileSeries" (
 "issuerNit" TEXT NOT NULL,
 "environment" TEXT NOT NULL,
 "year" INTEGER NOT NULL,
 "lastNumber" INTEGER NOT NULL DEFAULT 0,
 CONSTRAINT "CreditNoteFileSeries_pkey" PRIMARY KEY ("issuerNit", "environment", "year"),
 CONSTRAINT "CreditNoteFileSeries_scope_check" CHECK ("issuerNit" ~ '^[0-9]{1,10}$' AND "environment" IN ('1','2') AND "year" BETWEEN 2000 AND 9999 AND "lastNumber" >= 0)
);
