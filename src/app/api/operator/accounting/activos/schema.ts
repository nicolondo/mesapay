// Forma del cuerpo de alta/edición de un activo (compartida por POST /activos
// y PATCH /activos/[id]). Sólo la forma: las reglas de negocio (cuentas
// 15xx/5xxx imputables, rescate < compra, rangos) las aplica
// `validateAssetInput` en src/lib/erp/activos.ts y devuelve su código.
import { z } from "zod";

export const assetBodySchema = z.object({
  name: z.string().max(500),
  code: z.string().max(100).nullable().optional(),
  purchaseDate: z.string().max(10),
  purchaseCents: z.number().int(),
  salvageCents: z.number().int().default(0),
  usefulLifeMonths: z.number().int(),
  assetAccountCode: z.string().max(20),
  depreciationAccountCode: z.string().max(20),
  expenseAccountCode: z.string().max(20),
  notes: z.string().max(5000).nullable().optional(),
});

/** Edición: todos los campos opcionales; se mezclan sobre el activo actual. */
export const assetPatchSchema = assetBodySchema.partial().strict();
