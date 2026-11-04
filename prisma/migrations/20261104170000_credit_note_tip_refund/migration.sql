-- Propina devuelta con la nota crédito de ANULACIÓN (aditiva, escrita a mano).
--
-- La propina no va en la factura electrónica (ni en la nota), pero el
-- cliente la pagó: anular la factura también se la devuelve. Tres columnas,
-- todas nullable y sin reescribir nada:
--   · tipRefundCents     propina que la nota le devuelve al cliente. Se fija
--                        al crear la nota (0 si no es anulación). null = nota
--                        anterior a este cambio: la contabilidad la calcula y
--                        la fija la primera vez que la ve (ensureCreditNoteStamps).
--   · tipReceivableCents parte de esa propina que canceló cartera de crédito
--                        de cliente. null = la parte de la propina todavía no
--                        se contabilizó.
--   · tipPostedMonth     mes (YYYY-MM) del asiento «Notas crédito» que asentó
--                        la propina devuelta. Igual al de la nota salvo en una
--                        nota ya asentada en un mes que se cerró antes de este
--                        cambio: la propina entra en el primer mes abierto.
ALTER TABLE "CreditNote" ADD COLUMN "tipRefundCents" INTEGER,
ADD COLUMN "tipReceivableCents" INTEGER,
ADD COLUMN "tipPostedMonth" TEXT;

-- Misma convención que credit_note_receivable_valid: aplica a filas nuevas o
-- actualizadas sin reescribir el histórico.
ALTER TABLE "CreditNote" ADD CONSTRAINT credit_note_tip_refund_valid CHECK
  ("tipRefundCents" IS NULL OR "tipRefundCents" >= 0) NOT VALID;

ALTER TABLE "CreditNote" ADD CONSTRAINT credit_note_tip_receivable_valid CHECK
  ("tipReceivableCents" IS NULL OR ("tipReceivableCents" >= 0 AND "tipReceivableCents" <= COALESCE("tipRefundCents", 0))) NOT VALID;
