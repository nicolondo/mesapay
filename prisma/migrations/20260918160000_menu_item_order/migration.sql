-- Orden de los platos dentro de cada categoría de la carta.
-- "alphabetical" (default, lo pidió el dueño): natural por el nombre que se
-- muestra. "manual": el orden por posición (MenuItem.sortOrder) que se arma
-- a mano en el editor de la carta. Ver src/lib/menuOrder.ts.

-- AlterTable
ALTER TABLE "Restaurant" ADD COLUMN "menuItemOrder" TEXT NOT NULL DEFAULT 'alphabetical';
