ALTER TABLE "TerminalPrintReservation" ADD COLUMN "fault" TEXT,
    ADD COLUMN "nextProbeAt" TIMESTAMP(3);
ALTER TABLE "FinancialOperation" ADD COLUMN "gatewayTimedOutAt" TIMESTAMP(3);
