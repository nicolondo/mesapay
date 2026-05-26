import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";

const putBody = z.object({
  logoUrl: z.string().max(500).nullable().optional(),
  legalName: z.string().trim().max(200).nullable().optional(),
  // NIT: solo dígitos (con o sin DV). Sanitizamos al guardar.
  taxId: z
    .string()
    .trim()
    .max(40)
    .nullable()
    .optional(),
  legalAddress: z.string().trim().max(200).nullable().optional(),
  legalPhone: z.string().trim().max(60).nullable().optional(),
  dianResolution: z.string().trim().max(200).nullable().optional(),
  dianResolutionFrom: z.number().int().nonnegative().max(99_999_999).nullable().optional(),
  dianResolutionTo: z.number().int().nonnegative().max(99_999_999).nullable().optional(),
  dianResolutionDate: z
    .string()
    .nullable()
    .optional(), // ISO yyyy-mm-dd
  invoicePrefix: z.string().trim().toUpperCase().max(10).nullable().optional(),
  // Próximo consecutivo a emitir. El operador lo setea cuando ya
  // venía emitiendo en otra plataforma y necesita continuar desde
  // un número específico (ej. dianResolutionFrom + N facturas ya
  // emitidas externamente). Si lo bajan por error, no validamos
  // contra ya-emitidos en MESAPAY — confiamos en el operador.
  invoiceNextNumber: z.number().int().min(1).max(99_999_999).optional(),
});

/**
 * Identidad legal + branding del comercio. Operador puede editar
 * todos los campos; el panel rendea solo si ambos roles operator y
 * platform_admin están autorizados.
 *
 * Nada acá es PCI / Kushki — eso vive aparte en /api/operator/onboarding.
 */
export async function PUT(req: Request) {
  const session = await auth();
  if (
    !session?.user ||
    (session.user.role !== "operator" && session.user.role !== "platform_admin")
  ) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return NextResponse.json({ error: "no_restaurant" }, { status: 400 });
  }

  const body = await req.json().catch(() => null);
  const parsed = putBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const d = parsed.data;
  await db.restaurant.update({
    where: { id: restaurantId },
    data: {
      ...(d.logoUrl !== undefined && { logoUrl: d.logoUrl || null }),
      ...(d.legalName !== undefined && { legalName: d.legalName || null }),
      ...(d.taxId !== undefined && {
        // Sanitizamos NIT: dejamos solo dígitos y guión (separador DV).
        taxId: d.taxId ? d.taxId.replace(/[^\d-]/g, "") || null : null,
      }),
      ...(d.legalAddress !== undefined && {
        legalAddress: d.legalAddress || null,
      }),
      ...(d.legalPhone !== undefined && { legalPhone: d.legalPhone || null }),
      ...(d.dianResolution !== undefined && {
        dianResolution: d.dianResolution || null,
      }),
      ...(d.dianResolutionFrom !== undefined && {
        dianResolutionFrom: d.dianResolutionFrom,
      }),
      ...(d.dianResolutionTo !== undefined && {
        dianResolutionTo: d.dianResolutionTo,
      }),
      ...(d.dianResolutionDate !== undefined && {
        dianResolutionDate: d.dianResolutionDate
          ? new Date(d.dianResolutionDate)
          : null,
      }),
      ...(d.invoicePrefix !== undefined && {
        invoicePrefix: d.invoicePrefix || null,
      }),
      ...(d.invoiceNextNumber !== undefined && {
        invoiceNextNumber: d.invoiceNextNumber,
      }),
    },
  });

  return NextResponse.json({ ok: true });
}
