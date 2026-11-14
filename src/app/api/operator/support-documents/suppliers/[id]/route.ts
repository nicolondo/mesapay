import { secureApi } from "@/lib/secureApi";
import { z } from "zod";
import { db } from "@/lib/db";
import { findMunicipioByCode } from "@/lib/dane/municipios";
import { supportDocApi } from "@/lib/dian/supportDocument/api";
import { findDianCountry } from "@/lib/dian/supportDocument/catalogs";
import { SupportDocError } from "@/lib/dian/supportDocument/errors";
import { SUPPLIER_DS_SELECT } from "@/lib/dian/supportDocument/seller";
import { supplierView } from "@/lib/dian/supportDocument/view";

export const dynamic = "force-dynamic";

const nullableText = (max: number) => z.string().trim().max(max).nullable().optional();

const schema = z.object({
  notObligatedToInvoice: z.boolean().optional(),
  name: z.string().trim().min(1).max(120).optional(),
  taxId: nullableText(40),
  taxIdType: z.enum(["NIT", "CC", "CE", "PA"]).nullable().optional(),
  personType: z.enum(["natural", "juridica"]).nullable().optional(),
  address: nullableText(300),
  cityCode: z.string().trim().regex(/^\d{5}$/).nullable().optional(),
  postalCode: z.string().trim().regex(/^\d{6}$/).nullable().optional().or(z.literal("")),
  countryCode: z.string().trim().length(2).nullable().optional(),
  foreignCityName: nullableText(60),
});

/**
 * Datos del vendedor que exige el documento soporte (Res. 000167/2021):
 * marca de sujeto no obligado, documento, tipo de persona, dirección con
 * municipio DANE y código postal (residente) o país y ciudad (no residente).
 * Se guardan en el PROVEEDOR: sirven para todos sus gastos y compras.
 */
async function PATCHHandler(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return supportDocApi(async (ctx) => {
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new SupportDocError("supplier_incomplete", ["invalid"]);
    const b = parsed.data;
    const sup = await db.supplier.findFirst({ where: { id, restaurantId: ctx.restaurantId }, select: { id: true, name: true } });
    if (!sup) throw new SupportDocError("not_found");
    if (b.cityCode && !findMunicipioByCode(b.cityCode)) throw new SupportDocError("supplier_incomplete", ["city"]);
    const country = b.countryCode ? findDianCountry(b.countryCode) : null;
    if (b.countryCode && !country) throw new SupportDocError("supplier_incomplete", ["country"]);
    if (b.name !== undefined && b.name !== sup.name) {
      const dup = await db.supplier.findUnique({
        where: { restaurantId_name: { restaurantId: ctx.restaurantId, name: b.name } },
        select: { id: true },
      });
      if (dup) throw new SupportDocError("supplier_incomplete", ["name_taken"]);
    }
    const updated = await db.supplier.update({
      where: { id: sup.id },
      data: {
        ...(b.notObligatedToInvoice !== undefined ? { notObligatedToInvoice: b.notObligatedToInvoice } : {}),
        ...(b.name !== undefined ? { name: b.name } : {}),
        ...(b.taxId !== undefined ? { taxId: b.taxId || null } : {}),
        ...(b.taxIdType !== undefined ? { taxIdType: b.taxIdType } : {}),
        ...(b.personType !== undefined ? { personType: b.personType } : {}),
        ...(b.address !== undefined ? { address: b.address || null } : {}),
        ...(b.cityCode !== undefined ? { cityCode: b.cityCode || null } : {}),
        ...(b.postalCode !== undefined ? { postalCode: b.postalCode || null } : {}),
        // "CO" se guarda como null: residente es el caso de siempre.
        ...(b.countryCode !== undefined ? { countryCode: country && country.code !== "CO" ? country.code : null } : {}),
        ...(b.foreignCityName !== undefined ? { foreignCityName: b.foreignCityName || null } : {}),
      },
      select: SUPPLIER_DS_SELECT,
    });
    return { supplier: supplierView(updated) };
  });
}

export const PATCH = secureApi(PATCHHandler);
