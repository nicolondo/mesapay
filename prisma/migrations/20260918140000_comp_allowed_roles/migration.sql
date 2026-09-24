-- Quién puede NO COBRAR un plato o una cuenta. Política configurable por
-- el comercio en /operator/settings/staff-policies: lista de roles del
-- personal ("operator", "mesero", "terminal") autorizados a anular el cobro
-- de un plato entregado (OrderItem.cancellationKind = "comp") o a cerrar
-- la cuenta completa como cortesía. Default: sólo el administrador, que es
-- lo que el dueño pidió ("solamente lo pueda hacer un usuario específico").
-- platform_admin / group_admin impersonando no pasan por la lista.
-- Ver src/lib/staffPolicies.ts (canCompOrders) y src/lib/compGuard.ts.

-- AlterTable
ALTER TABLE "Restaurant" ADD COLUMN     "compAllowedRoles" TEXT[] DEFAULT ARRAY['operator']::TEXT[];
