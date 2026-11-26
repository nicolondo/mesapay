CREATE TABLE "TerminalPrintReservation" (
    "serial" TEXT PRIMARY KEY,
    "jobId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
