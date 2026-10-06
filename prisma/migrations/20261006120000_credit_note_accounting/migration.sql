-- Contabilidad de las notas crédito electrónicas (aditiva, escrita a mano).
--
-- CreditNote: datos contables que se fijan una sola vez tras la aceptación
-- de la DIAN (parte que cancela cartera de cliente, cuándo se fijó y en qué
-- mes quedó asentada). Todo nullable: las notas existentes (0 en
-- producción al escribir esto) quedan "pendientes" y el motor las fija la
-- primera vez que las ve.
ALTER TABLE "CreditNote" ADD COLUMN "receivableCents" INTEGER,
ADD COLUMN "accountingStampedAt" TIMESTAMP(3),
ADD COLUMN "postedMonth" TEXT;

-- Payment: parte de un cargo a crédito de cliente cancelada por notas
-- crédito aceptadas. Baja la deuda del cliente igual que refundedCents.
ALTER TABLE "Payment" ADD COLUMN "creditNoteCents" INTEGER NOT NULL DEFAULT 0;

-- Misma convención que payment_amounts_valid: aplica a filas nuevas o
-- actualizadas sin reescribir el histórico.
ALTER TABLE "Payment" ADD CONSTRAINT payment_credit_note_valid CHECK
  ("creditNoteCents" >= 0 AND "creditNoteCents" <= "amountCents") NOT VALID;

ALTER TABLE "CreditNote" ADD CONSTRAINT credit_note_receivable_valid CHECK
  ("receivableCents" IS NULL OR ("receivableCents" >= 0 AND "receivableCents" <= "totalCents")) NOT VALID;
