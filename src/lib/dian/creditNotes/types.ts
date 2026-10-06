import type { DianLine } from "../ubl";
import type { CreditNoteAccountingStatus } from "@/lib/erp/creditNoteLedger";
export type CreditReason = "1" | "2" | "3" | "4" | "5" | "6";
export type OriginalCreditLine = DianLine & {
    lineId: string;
    grossCents: number;
};
export type OriginalInvoiceSnapshot = import("../creditNoteSource").CreditNoteSource & {
    documentId: string;
};
export type CreditedLine = DianLine & {
    originalLineId: string;
    grossCents: number;
};
export type CreditNoteSnapshot = {
    version: 1;
    originalDocumentId: string;
    original: OriginalInvoiceSnapshot;
    lines: CreditedLine[];
    locale: string;
    recipientEmail: string | null;
    brandName: string;
};
export type CreditNoteInput = {
    originalInvoiceId: string;
    requestId: string;
    sourceVersion: string;
    mode: "total" | "partial";
    reasonCode: CreditReason;
    reasonText: string;
    lines?: Array<{
        lineId: string;
        grossCents: number;
    }>;
};
export type RemainingCreditLine = OriginalCreditLine & {
    grossCents: number;
    reservedGrossCents: number;
    reservedTaxCents: number;
    remainingGrossCents: number;
};
export type CreditNoteProposal = {
    lines: CreditedLine[];
    subtotalCents: number;
    taxCents: number;
    totalCents: number;
};
export type CreditNoteDto = {
    /**
     * Contabilización de la nota aceptada («Contabilizada en …» / pendiente).
     * null = la nota no está aceptada o el comercio no lleva contabilidad.
     */
    accounting: CreditNoteAccountingStatus | null;
    id: string;
    publicToken: string;
    canAbandon: boolean;
    canRetry: boolean;
    originalInvoiceId: string;
    documentNumber: string;
    number: number;
    reasonCode: string;
    reasonText: string;
    subtotalCents: number;
    taxCents: number;
    totalCents: number;
    environment: "1" | "2";
    createdAt: string;
    abandonedAt: string | null;
    snapshot: CreditNoteSnapshot;
    document: {
        id: string;
        state: string;
        cufe: string | null;
        trackId: string | null;
        errors: string[];
        lastError: string | null;
        issuedAt: string | null;
        emailedAt: string | null;
        emailError: string | null;
    } | null;
};
export type CreditNoteSource = {
    originalInvoiceId: string;
    original: OriginalInvoiceSnapshot;
    lines: RemainingCreditLine[];
    remainingTotalCents: number;
    sourceVersion: string;
    prefix: string;
    nextNumber: number;
    notes: CreditNoteDto[];
};
export type CreditNoteInvoiceChoice = {
    id: string;
    invoiceNumber: string;
    customerName: string | null;
    paidAt: string | null;
    totalCents: number;
    acceptedCreditCents: number;
    reservedCreditCents: number;
};

export type CreditNotePreviewInput = Omit<CreditNoteInput, "requestId">;
