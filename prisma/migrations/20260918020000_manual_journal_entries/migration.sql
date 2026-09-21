-- Comprobantes manuales, reversas y centro de costos por línea.
--
-- JournalEntry:
--   thirdPartyName/thirdPartyTaxId: tercero desnormalizado (MESAPAY no tiene
--     una entidad "tercero" única; el asiento guarda el texto elegido).
--   createdById: quién creó el comprobante (manuales y reversas).
--   annulledAt: cuándo se anuló por reversa; las líneas SIGUEN en el libro y
--     la reversa las netea.
--   reversalOfId: si es una reversa, id del comprobante que anula. Sin FK a
--     propósito: el original puede desaparecer si su mes se reabre y el motor
--     lo regenera.
-- JournalLine.costCenterId: centro de costos opcional de la línea.

-- AlterTable
ALTER TABLE "JournalEntry" ADD COLUMN     "thirdPartyName" TEXT,
ADD COLUMN     "thirdPartyTaxId" TEXT,
ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "annulledAt" TIMESTAMP(3),
ADD COLUMN     "reversalOfId" TEXT;

-- AlterTable
ALTER TABLE "JournalLine" ADD COLUMN     "costCenterId" TEXT;

-- CreateIndex
CREATE INDEX "JournalEntry_reversalOfId_idx" ON "JournalEntry"("reversalOfId");

-- CreateIndex
CREATE INDEX "JournalLine_costCenterId_idx" ON "JournalLine"("costCenterId");

-- AddForeignKey
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_costCenterId_fkey" FOREIGN KEY ("costCenterId") REFERENCES "CostCenter"("id") ON DELETE SET NULL ON UPDATE CASCADE;
