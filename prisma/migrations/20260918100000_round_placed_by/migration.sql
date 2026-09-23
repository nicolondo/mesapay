-- Quién montó la ronda. Cuando el personal (mesero, administrador, cocina…)
-- monta un pedido desde la carta con su sesión, la ronda queda estampada con
-- el usuario, y con un SNAPSHOT de su nombre y rol para que la comanda siga
-- diciendo quién fue aunque el usuario cambie de nombre o se borre (la FK
-- queda en null). Los pedidos del comensal quedan con los tres en null.
-- Ver src/lib/orders/placedBy.ts.

-- AlterTable
ALTER TABLE "Round" ADD COLUMN     "placedByName" TEXT,
ADD COLUMN     "placedByRole" TEXT,
ADD COLUMN     "placedByUserId" TEXT;

-- CreateIndex
CREATE INDEX "Round_placedByUserId_idx" ON "Round"("placedByUserId");

-- AddForeignKey
ALTER TABLE "Round" ADD CONSTRAINT "Round_placedByUserId_fkey" FOREIGN KEY ("placedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
