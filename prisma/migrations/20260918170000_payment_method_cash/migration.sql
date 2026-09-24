-- Efectivo real como método de pago propio.
--
--   PaymentMethod.cash → el efectivo que se cobra en la mesa o en la caja.
--                        Hasta ahora se grababa como `demo_cash`, un nombre
--                        heredado de cuando los pagos eran simulados, y el
--                        detalle del pedido lo mostraba como "Efectivo (demo)".
--
-- No se reescriben filas: los pagos ya guardados como `demo_cash` se quedan
-- así (fueron plata real) y el código los trata igual que `cash` en caja,
-- cierre de turno, contabilidad y reportes (`isCashMethod`).

-- AlterEnum
ALTER TYPE "PaymentMethod" ADD VALUE 'cash';
