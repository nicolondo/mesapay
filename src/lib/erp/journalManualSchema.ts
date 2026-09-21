// Cuerpo JSON de POST/PUT /api/operator/accounting/entries. Sólo forma y
// tipos: las reglas contables (cuadre, mes abierto, cuentas) las aplica
// `validateManualEntry` y devuelven un código de error propio.
import { z } from "zod";

const centsSchema = z.number().int().min(0).max(1_000_000_000_000);

export const manualLineSchema = z.object({
  accountCode: z.string().trim().min(1).max(12),
  debitCents: centsSchema.nullish(),
  creditCents: centsSchema.nullish(),
  costCenterId: z.string().trim().max(64).nullish(),
  memo: z.string().trim().max(300).nullish(),
});

export const manualEntryBodySchema = z.object({
  date: z.string().trim().min(10).max(10),
  memo: z.string().trim().min(1).max(300),
  thirdPartyName: z.string().trim().max(160).nullish(),
  thirdPartyTaxId: z.string().trim().max(20).nullish(),
  lines: z.array(manualLineSchema).min(1).max(200),
});

export type ManualEntryBody = z.infer<typeof manualEntryBodySchema>;
