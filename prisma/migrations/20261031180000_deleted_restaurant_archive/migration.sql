-- Eliminar un comercio con toda su información (src/lib/restaurantDeletion).
--
-- 1) Los pagos de la mensualidad (MembershipPayment) y las comisiones de los
--    comerciales (CommissionEntry) son registros de la PLATAFORMA: sobreviven
--    al comercio. La FK pasa de CASCADE a SET NULL y se guarda el nombre del
--    comercio en "deletedRestaurantName" al eliminarlo.
-- 2) DeletedRestaurantArchive: archivo final del comercio eliminado (ZIP con
--    los datos, los documentos fiscales DIAN y los archivos que hay que
--    conservar). Tabla de plataforma SIN FK a Restaurant, para que no se vaya
--    en cascada con él (y su columna se llama "deletedRestaurantId", no
--    "restaurantId", para que las copias y el borrado no la tomen como tabla
--    del comercio). Es también el registro de auditoría del borrado.

-- DropForeignKey
ALTER TABLE "MembershipPayment" DROP CONSTRAINT "MembershipPayment_restaurantId_fkey";

-- DropForeignKey
ALTER TABLE "CommissionEntry" DROP CONSTRAINT "CommissionEntry_restaurantId_fkey";

-- AlterTable
ALTER TABLE "MembershipPayment" ADD COLUMN "deletedRestaurantName" TEXT,
ALTER COLUMN "restaurantId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "CommissionEntry" ADD COLUMN "deletedRestaurantName" TEXT,
ALTER COLUMN "restaurantId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "DeletedRestaurantArchive" (
    "id" TEXT NOT NULL,
    "deletedRestaurantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "legalName" TEXT,
    "taxId" TEXT,
    "country" TEXT,
    "deletedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedById" TEXT,
    "deletedByEmail" TEXT NOT NULL,
    "counts" JSONB NOT NULL,
    "formatVersion" INTEGER NOT NULL DEFAULT 1,
    "archive" BYTEA NOT NULL,
    "archiveBytes" INTEGER NOT NULL,
    "archiveSha256" TEXT NOT NULL,

    CONSTRAINT "DeletedRestaurantArchive_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DeletedRestaurantArchive_deletedRestaurantId_key" ON "DeletedRestaurantArchive"("deletedRestaurantId");

-- CreateIndex
CREATE INDEX "DeletedRestaurantArchive_deletedAt_idx" ON "DeletedRestaurantArchive"("deletedAt");

-- CreateIndex
CREATE INDEX "DeletedRestaurantArchive_slug_idx" ON "DeletedRestaurantArchive"("slug");

-- AddForeignKey
ALTER TABLE "MembershipPayment" ADD CONSTRAINT "MembershipPayment_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionEntry" ADD CONSTRAINT "CommissionEntry_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
