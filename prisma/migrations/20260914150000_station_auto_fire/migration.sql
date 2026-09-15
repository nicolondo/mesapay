-- Marchado automático por estación. Con el flag activo, los ítems que
-- nacen "placed" en esa estación pasan solos a "in_kitchen" al llegar la
-- ronda y, si la impresión de la estación está activa, la comanda sale en
-- ese instante. Pedido para el bar (el bartender no mira un tablero);
-- cocina lleva el mismo código y nace apagada.
ALTER TABLE "Restaurant" ADD COLUMN "kitchenAutoFire" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Restaurant" ADD COLUMN "barAutoFire" BOOLEAN NOT NULL DEFAULT false;
