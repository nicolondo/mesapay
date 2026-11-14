// Piezas compartidas de las rutas de notas crédito de proveedores.
import { NextResponse } from "next/server";
import { z } from "zod";
import { StockError } from "./stock";
import { SupplierCreditError } from "./supplierCreditNoteService";
import { SUPPLIER_CREDIT_NOTE_KINDS } from "./supplierCreditNotes";
import type { ModuleSlug } from "@/lib/modules";

export const CREDIT_NOTE_GATE: ModuleSlug[] = ["purchasing"];

const cents = z.number().int().min(0).max(2_000_000_000);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const id = z.string().min(1).max(40);

export const allocationSchema = z
  .array(z.object({ kind: z.enum(["purchase", "expense"]), id, amountCents: cents.min(1) }))
  .max(200);

export const createCreditNoteSchema = z.object({
  supplierId: id,
  number: z.string().trim().min(1).max(60),
  date: day,
  cude: z.string().trim().max(200).nullable().optional(),
  kind: z.enum(SUPPLIER_CREDIT_NOTE_KINDS),
  agreement: z.string().trim().max(120).nullable().optional(),
  totalCents: cents.min(1),
  ivaPct: z.number().int().min(0).max(100).default(0),
  ivaCents: cents.default(0),
  incCents: cents.default(0),
  accountCode: z.string().trim().max(12).nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
  attachmentUrl: z
    .string()
    .regex(/^\/uploads\/[a-z0-9-]+\.(pdf|jpg|png|webp)$/)
    .nullable()
    .optional(),
  invoiceUploadId: id.nullable().optional(),
  relatedPurchaseIds: z.array(id).max(20).default([]),
  lines: z
    .array(
      z.object({
        ingredientId: id,
        purchaseOrderItemId: id.nullable().optional(),
        qtyBase: z.number().int().min(1).max(2_000_000_000),
        valueCents: cents.min(1),
      }),
    )
    .max(200)
    .default([]),
  /** null/ausente = plan por defecto (relacionadas primero, luego FIFO). */
  applications: allocationSchema.nullable().optional(),
});

export const refundSchema = z.object({
  amountCents: cents.min(1),
  date: day,
  accountCode: z.string().trim().min(4).max(12),
  note: z.string().trim().max(300).nullable().optional(),
});

/** Error de dominio → respuesta JSON. Otros errores se relanzan. */
export function creditErrorResponse(err: unknown): NextResponse {
  if (err instanceof SupplierCreditError) {
    return NextResponse.json({ error: err.code, ...(err.detail ?? {}) }, { status: err.status });
  }
  if (err instanceof StockError) {
    return NextResponse.json({ error: err.code }, { status: 400 });
  }
  throw err;
}
