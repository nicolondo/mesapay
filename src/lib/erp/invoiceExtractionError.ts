export type InvoiceExtractionErrorCode =
  | "ai_response_incomplete"
  | "ai_invalid_response"
  | "ai_timeout";

/** Safe to return or log: never carries source text, amounts or provider errors. */
export class InvoiceExtractionError extends Error {
  constructor(readonly code: InvoiceExtractionErrorCode) {
    super(code);
    this.name = "InvoiceExtractionError";
  }
}
