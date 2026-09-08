import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireOperatorScope, isScopeError } from "@/lib/operatorScope";
import { resolveLoginIdentifier } from "@/lib/customerIdentity";
import { findDinerByIdentifier } from "@/lib/dinerDiscount";

/**
 * GET /api/operator/diners?q=<cédula o correo>
 *
 * Búsqueda EXACTA por cédula o correo, entre los comensales DE ESTE
 * comercio, para identificar en la mesa a alguien que quizá nunca pidió
 * acá pero sí tiene cuenta acá.
 *
 * Desde que el registro es por comercio, este endpoint dejó de poder
 * encontrar a cualquiera de la plataforma: el lookup va contra
 * (restaurantId, correo|cédula) y el restaurantId sale de la sesión. Si la
 * persona no se registró en este restaurante, para este restaurante no
 * existe — y tiene que crear su cuenta acá.
 *
 * Se mantiene la búsqueda exacta (y no un "contiene") por la misma razón de
 * siempre: un `contains` sobre correos sería un volcado de la base de
 * comensales, ahora del propio local.
 */
export async function GET(req: Request) {
  const scope = await requireOperatorScope();
  if (isScopeError(scope)) {
    return NextResponse.json(
      { error: scope.error },
      { status: scope.error === "forbidden" ? 403 : 400 },
    );
  }

  const q = new URL(req.url).searchParams.get("q") ?? "";
  const ident = resolveLoginIdentifier(q);
  if (ident.kind === "invalid") {
    return NextResponse.json({ diner: null });
  }

  const diner = await findDinerByIdentifier({
    restaurantId: scope.restaurantId,
    ...(ident.kind === "email"
      ? { email: ident.value }
      : { cedula: ident.value }),
  });
  if (!diner || diner.disabledAt) {
    return NextResponse.json({ diner: null });
  }

  const discount = await db.dinerDiscount.findUnique({
    where: { dinerId: diner.id },
    select: { percent: true, active: true, note: true },
  });

  return NextResponse.json({
    diner: {
      id: diner.id,
      name: diner.name,
      email: diner.email,
      cedula: diner.cedula,
      discount: discount?.active ? discount : null,
    },
  });
}
