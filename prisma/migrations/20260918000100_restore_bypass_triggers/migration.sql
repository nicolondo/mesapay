-- Bypass de los triggers de negocio durante la restauración de copias.
--
-- La restauración (src/lib/backups/restore.ts) recarga un estado histórico
-- CONSISTENTE de un comercio entero. reserve_payment y order_event están
-- hechos para operaciones incrementales —una fila nueva contra un estado ya
-- válido— y evaluados fila por fila sobre una recarga rechazan estados
-- legítimos (una cuenta cancelada después de cobrarse → order_closed) y
-- generan un PlatformEvent (SSE) por cada orden reinsertada, que no cambió.
--
-- Por eso salen temprano cuando la transacción de restauración ejecuta
-- `SET LOCAL app.restoring = '1'`. El GUC muere con la transacción (un fallo
-- no deja nada colgado), no toma locks de tabla (a diferencia de
-- ALTER TABLE … DISABLE TRIGGER, que frena las ventas de todos los comercios
-- hasta el commit) y no exige superusuario (a diferencia de
-- session_replication_role). Fuera de una restauración el setting no existe:
-- current_setting(..., true) devuelve NULL y el cuerpo es el mismo que dejó
-- 20260908010000_platform_hardening. Los CHECK y las FKs no se tocan.
CREATE OR REPLACE FUNCTION mesapay_reserve_payment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o "Order"%ROWTYPE; claimed bigint;
BEGIN
  IF current_setting('app.restoring', true) = '1' THEN RETURN NEW; END IF;
  SELECT * INTO o FROM "Order" WHERE id = NEW."orderId" FOR UPDATE;
  IF NEW.status IN ('pending', 'approved') THEN
    IF o.status = 'cancelled' THEN RAISE EXCEPTION 'order_closed' USING ERRCODE = '23514'; END IF;
    SELECT COALESCE(SUM("amountCents" - "tipCents"), 0) INTO claimed
      FROM "Payment" WHERE "orderId" = NEW."orderId" AND status IN ('pending', 'approved');
    IF claimed + NEW."amountCents" - NEW."tipCents" > GREATEST(0, o."subtotalCents"::bigint + o."taxCents" - o."discountCents") + 1 THEN
      RAISE EXCEPTION 'amount_exceeds_outstanding' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION mesapay_order_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.restoring', true) = '1' THEN RETURN NEW; END IF;
  INSERT INTO "PlatformEvent" ("restaurantId", "orderId", payload)
    VALUES (NEW."restaurantId", NEW.id, jsonb_build_object('type',
      CASE WHEN NEW.status = 'paid' THEN 'order.paid' ELSE 'order.updated' END, 'orderId', NEW.id));
  RETURN NEW;
END $$;
