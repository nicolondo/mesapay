-- Información exógena DIAN: tablas de captura manual por año gravable.
--
-- ExogenaShareholder (formato 1010): socios/accionistas con su participación
--   en basis points (sharePctBps), valor nominal y prima en centavos (BIGINT:
--   el capital social supera los $21,4 M COP que caben en un INTEGER).
-- ExogenaHolding (formato 1012): cuentas bancarias, inversiones y acciones
--   al 31 de diciembre (concepto 1110 / 1115 / 1200-1206) por entidad.
-- Ambas cuelgan del comercio (CASCADE) y se consultan por (restaurantId, year).

-- CreateTable
CREATE TABLE "ExogenaShareholder" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "docType" TEXT NOT NULL,
    "docNumber" TEXT NOT NULL,
    "dv" TEXT,
    "sharePctBps" INTEGER NOT NULL,
    "nominalCents" BIGINT NOT NULL,
    "premiumCents" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExogenaShareholder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExogenaHolding" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "concept" TEXT NOT NULL,
    "entityName" TEXT NOT NULL,
    "entityDocType" TEXT NOT NULL,
    "entityDocNumber" TEXT NOT NULL,
    "valueCents" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExogenaHolding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExogenaShareholder_restaurantId_year_idx" ON "ExogenaShareholder"("restaurantId", "year");

-- CreateIndex
CREATE INDEX "ExogenaHolding_restaurantId_year_idx" ON "ExogenaHolding"("restaurantId", "year");

-- AddForeignKey
ALTER TABLE "ExogenaShareholder" ADD CONSTRAINT "ExogenaShareholder_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExogenaHolding" ADD CONSTRAINT "ExogenaHolding_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
