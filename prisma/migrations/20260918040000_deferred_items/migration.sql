-- Diferidos: gastos pagados por anticipado (puente 17xx) e ingresos recibidos
-- por anticipado (puente 27xx) que se amortizan mes a mes contra la cuenta
-- destino. El asiento inicial por el total y la cuota mensual viven en
-- JournalEntry (source "deferred_item" / "deferred"); acá sólo el catálogo.
-- Ver src/lib/erp/deferred.ts.

-- CreateTable
CREATE TABLE "DeferredItem" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "totalCents" INTEGER NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "months" INTEGER NOT NULL,
    "sourceAccountCode" TEXT NOT NULL,
    "deferralAccountCode" TEXT NOT NULL,
    "targetAccountCode" TEXT NOT NULL,
    "costCenterId" TEXT,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "closedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeferredItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeferredItem_restaurantId_status_idx" ON "DeferredItem"("restaurantId", "status");

-- CreateIndex
CREATE INDEX "DeferredItem_costCenterId_idx" ON "DeferredItem"("costCenterId");

-- AddForeignKey
ALTER TABLE "DeferredItem" ADD CONSTRAINT "DeferredItem_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeferredItem" ADD CONSTRAINT "DeferredItem_costCenterId_fkey" FOREIGN KEY ("costCenterId") REFERENCES "CostCenter"("id") ON DELETE SET NULL ON UPDATE CASCADE;
