-- Documento soporte en adquisiciones efectuadas a sujetos no obligados a
-- expedir factura de venta o documento equivalente (DIAN, Resolución 000167
-- de 2021, anexo técnico v1.1) y su nota de ajuste.
--
-- 100 % ADITIVA (blue/green): columnas nuevas con default o nullable y dos
-- tablas nuevas. La versión anterior de la app sigue funcionando con este
-- esquema (no lee nada de esto) y un rollback no pierde datos de nadie.
-- Ningún comercio cambia de comportamiento: `supportDocEnabled` arranca en
-- false y `notObligatedToInvoice` en false.

-- Configuración por emisor (va junto a la de facturación electrónica: mismo
-- certificado, distinto software, numeración y ambiente).
ALTER TABLE "DianConfig" ADD COLUMN "supportDocEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "supportDocEnvironment" TEXT NOT NULL DEFAULT 'habilitacion',
ADD COLUMN "supportDocStatus" TEXT NOT NULL DEFAULT 'pending',
ADD COLUMN "supportDocSoftwareId" TEXT,
ADD COLUMN "supportDocSoftwarePinEnc" TEXT,
ADD COLUMN "supportDocTestSetId" TEXT,
ADD COLUMN "supportDocResolutionNumber" TEXT,
ADD COLUMN "supportDocPrefix" TEXT,
ADD COLUMN "supportDocFrom" INTEGER,
ADD COLUMN "supportDocTo" INTEGER,
ADD COLUMN "supportDocValidFrom" TIMESTAMP(3),
ADD COLUMN "supportDocValidTo" TIMESTAMP(3),
ADD COLUMN "supportDocAdjustmentPrefix" TEXT NOT NULL DEFAULT 'NAS';

-- Datos del vendedor que exige el anexo (municipio DANE, código postal,
-- país) y la marca de sujeto no obligado a facturar.
ALTER TABLE "Supplier" ADD COLUMN "notObligatedToInvoice" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "cityCode" TEXT,
ADD COLUMN "postalCode" TEXT,
ADD COLUMN "countryCode" TEXT,
ADD COLUMN "foreignCityName" TEXT;

-- Consecutivos (tabla de plataforma, sin restaurantId: una copia de
-- seguridad restaurada no puede devolver el contador).
CREATE TABLE "SupportDocumentSeries" (
    "id" TEXT NOT NULL,
    "issuerNit" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "nextNumber" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "SupportDocumentSeries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SupportDocumentSeries_issuerNit_environment_kind_prefix_key" ON "SupportDocumentSeries"("issuerNit", "environment", "kind", "prefix");

-- Documentos soporte y notas de ajuste. Tabla nueva y vacía: los índices
-- únicos no pueden chocar con datos existentes.
CREATE TABLE "SupportDocument" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "expenseId" TEXT,
    "purchaseOrderId" TEXT,
    "activeKey" TEXT,
    "adjustsId" TEXT,
    "seriesId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "documentNumber" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "issuerNit" TEXT NOT NULL,
    "reasonCode" TEXT,
    "reasonText" TEXT,
    "snapshot" JSONB NOT NULL,
    "subtotalCents" INTEGER NOT NULL,
    "taxCents" INTEGER NOT NULL,
    "withholdingCents" INTEGER NOT NULL DEFAULT 0,
    "totalCents" INTEGER NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'to_send',
    "cuds" TEXT,
    "issuedAt" TIMESTAMP(3),
    "xmlZip" BYTEA,
    "submissionFileName" TEXT,
    "responseXml" TEXT,
    "trackId" TEXT,
    "errors" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextAttemptAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportDocument_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SupportDocument_activeKey_key" ON "SupportDocument"("activeKey");
CREATE UNIQUE INDEX "SupportDocument_seriesId_number_key" ON "SupportDocument"("seriesId", "number");
CREATE INDEX "SupportDocument_restaurantId_createdAt_idx" ON "SupportDocument"("restaurantId", "createdAt");
CREATE INDEX "SupportDocument_expenseId_idx" ON "SupportDocument"("expenseId");
CREATE INDEX "SupportDocument_purchaseOrderId_idx" ON "SupportDocument"("purchaseOrderId");
CREATE INDEX "SupportDocument_adjustsId_idx" ON "SupportDocument"("adjustsId");
CREATE INDEX "SupportDocument_state_nextAttemptAt_idx" ON "SupportDocument"("state", "nextAttemptAt");

-- El documento fiscal sobrevive a su origen: borrar el gasto o la compra
-- deja el documento (con su foto en `snapshot`) sin vínculo.
ALTER TABLE "SupportDocument" ADD CONSTRAINT "SupportDocument_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SupportDocument" ADD CONSTRAINT "SupportDocument_expenseId_fkey" FOREIGN KEY ("expenseId") REFERENCES "Expense"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SupportDocument" ADD CONSTRAINT "SupportDocument_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SupportDocument" ADD CONSTRAINT "SupportDocument_adjustsId_fkey" FOREIGN KEY ("adjustsId") REFERENCES "SupportDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SupportDocument" ADD CONSTRAINT "SupportDocument_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "SupportDocumentSeries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SupportDocument" ADD CONSTRAINT "SupportDocument_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
