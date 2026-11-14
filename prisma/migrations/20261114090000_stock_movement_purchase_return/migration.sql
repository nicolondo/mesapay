-- Devolución de mercancía al proveedor (nota crédito tipo «devolución»).
--
--   StockMovementKind.purchase_return → salida del kardex hacia el proveedor,
--                                       valorada al costo que acreditó la nota
--                                       (su anulación: el mismo kind con signo
--                                       contrario; el libro es append-only).
--
-- Va SOLO en su migración, como `kushki_bre_b` (20261113150000): PostgreSQL
-- no deja usar un valor de enum en la misma transacción que lo agrega.
-- Aditivo: no reescribe filas. La versión anterior nunca escribe este valor.

-- AlterEnum
ALTER TYPE "StockMovementKind" ADD VALUE 'purchase_return';
