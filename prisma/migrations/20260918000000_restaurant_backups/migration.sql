-- Copias de seguridad por comercio: snapshot JSON de todas sus tablas,
-- creación manual y automática diaria, retención 7 días. Ver src/lib/backups.
-- CreateTable
CREATE TABLE "RestaurantBackup" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "createdById" TEXT,
    "sizeBytes" INTEGER NOT NULL,
    "tableCounts" JSONB NOT NULL,
    "data" JSONB NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RestaurantBackup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RestaurantBackup_restaurantId_createdAt_idx" ON "RestaurantBackup"("restaurantId", "createdAt");

-- CreateIndex
CREATE INDEX "RestaurantBackup_expiresAt_idx" ON "RestaurantBackup"("expiresAt");

-- AddForeignKey
ALTER TABLE "RestaurantBackup" ADD CONSTRAINT "RestaurantBackup_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
