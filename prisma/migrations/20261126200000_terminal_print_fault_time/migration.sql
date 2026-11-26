ALTER TABLE "TerminalPrintReservation"
    ADD COLUMN "faultAt" TIMESTAMP(3),
    ADD COLUMN "lastJobStatus" TEXT;
