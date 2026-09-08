import { NextResponse } from "next/server";
import { computeNitDv } from "@/lib/erp/exogena";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { findMunicipioByCode, type DaneMunicipio } from "@/lib/dane/municipios";

const putBody = z.object({
  // Nombre comercial del restaurante (display, distinto de razón
  // social). Required en el schema (no se permite vaciar) pero
  // optional acá para permitir que el operador edite solo otros
  // campos. Si llega vacío lo ignoramos.
  name: z.string().trim().min(1).max(120).optional(),
  logoUrl: z.string().max(500).nullable().optional(),
  legalName: z.string().trim().max(200).nullable().optional(),
  // NIT con su dígito de verificación: "901944469-1".
  //
  // El DV dejó de ser opcional porque la factura electrónica lo exige (la
  // DIAN rechaza con FAJ24/FAJ24a/FAJ47 si no viaja) y, sobre todo, porque
  // es un dígito VERIFICADOR: contrastarlo contra el calculado detecta un
  // NIT mal tecleado antes de que salga en una factura. Se valida abajo, no
  // sólo se exige el formato.
  taxId: z
    .string()
    .trim()
    .max(40)
    .nullable()
    .optional(),
  legalAddress: z.string().trim().max(200).nullable().optional(),
  legalCity: z.string().trim().max(100).nullable().optional(),
  // Código DANE del municipio (DIVIPOLA, 5 dígitos). El cliente manda
  // SOLO el municipio: el departamento y el nombre legible los deriva
  // el server del catálogo, así nunca quedan en desacuerdo (y el
  // navegador no puede inventarse un departamento que no corresponde).
  legalCityCode: z
    .string()
    .trim()
    .regex(/^\d{5}$/)
    .nullable()
    .optional(),
  legalPhone: z.string().trim().max(60).nullable().optional(),
  // NO acepta datos de la resolución de numeración (número, rango, fecha,
  // prefijo, consecutivo). Se movieron enteros a
  // PATCH /api/operator/dian/resolution, que es la única superficie que
  // los escribe. Estaban duplicados con esa pantalla y los dos números
  // podían divergir sin que el operador lo notara. Si un cliente viejo
  // los sigue mandando, zod los descarta en silencio (schema estricto por
  // omisión de esas claves) en vez de pisar el dato bueno.
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

  // El NIT sigue siendo opcional (un comercio puede no haberlo cargado aún),
  // pero SI viene tiene que traer un DV correcto.
  if (d.taxId != null && d.taxId.trim() !== "") {
    const raw = d.taxId.replace(/[^\d-]/g, "");
    const [digits, dv] = raw.split("-");
    if (!digits || dv == null || dv === "") {
      return NextResponse.json({ error: "tax_id_dv_required" }, { status: 400 });
    }
    if (computeNitDv(digits) !== dv) {
      return NextResponse.json({ error: "tax_id_dv_mismatch" }, { status: 400 });
    }
  }

  // Municipio DANE: si mandaron código, tiene que existir en DIVIPOLA.
  // Rechazamos en vez de guardar basura — un código inválido llega a la
  // DIAN como rechazo de la factura, mucho más tarde y sin pistas.
  let municipio: DaneMunicipio | null = null;
  if (d.legalCityCode) {
    municipio = findMunicipioByCode(d.legalCityCode);
    if (!municipio) {
      return NextResponse.json({ error: "invalid_city_code" }, { status: 400 });
    }
  }

  await db.restaurant.update({
    where: { id: restaurantId },
    data: {
      ...(d.name !== undefined && { name: d.name }),
      ...(d.logoUrl !== undefined && { logoUrl: d.logoUrl || null }),
      ...(d.legalName !== undefined && { legalName: d.legalName || null }),
      ...(d.taxId !== undefined && {
        // Sanitizamos NIT: dejamos solo dígitos y guión (separador DV).
        taxId: d.taxId ? d.taxId.replace(/[^\d-]/g, "") || null : null,
      }),
      ...(d.legalAddress !== undefined && {
        legalAddress: d.legalAddress || null,
      }),
      // Con municipio elegido, legalCity se DERIVA del nombre oficial
      // DANE ("Santiago de Cali", no "cali") para que el nombre impreso
      // y el código de la factura digan lo mismo. Sin municipio (país
      // sin DIVIPOLA, o comercio que todavía no lo eligió) legalCity
      // sigue siendo texto libre y los códigos quedan en null.
      ...(municipio
        ? {
            legalCity: municipio.name,
            legalCityCode: municipio.code,
            legalDeptCode: municipio.deptCode,
          }
        : {
            ...(d.legalCity !== undefined && { legalCity: d.legalCity || null }),
            ...(d.legalCityCode === null && {
              legalCityCode: null,
              legalDeptCode: null,
            }),
          }),
      ...(d.legalPhone !== undefined && { legalPhone: d.legalPhone || null }),
    },
  });

  return NextResponse.json({ ok: true });
}
