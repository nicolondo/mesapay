-- Comisiones de ventas por mesero. La tasa vive en el mesero
-- ("User"."waiterCommissionBps", puntos base; distinta de "commissionBps",
-- que es la del comercial) y se SELLA en la cuenta al cobrarla: quién,
-- qué %, sobre qué base y cuánto. Cambiar el % después sólo afecta cuentas
-- futuras. Ver src/lib/waiterCommissionsSeal.ts.

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "waiterCommissionBps" INTEGER;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "commissionBaseCents" INTEGER,
ADD COLUMN     "commissionBps" INTEGER,
ADD COLUMN     "commissionCents" INTEGER,
ADD COLUMN     "commissionSealedAt" TIMESTAMP(3),
ADD COLUMN     "commissionWaiterId" TEXT;

-- CreateIndex
CREATE INDEX "Order_restaurantId_commissionSealedAt_idx" ON "Order"("restaurantId", "commissionSealedAt");

-- CreateIndex
CREATE INDEX "Order_commissionWaiterId_paidAt_idx" ON "Order"("commissionWaiterId", "paidAt");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_commissionWaiterId_fkey" FOREIGN KEY ("commissionWaiterId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

