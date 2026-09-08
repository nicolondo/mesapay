import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireOperatorScope, isScopeError } from "@/lib/operatorScope";
import { resolveLoginIdentifier } from "@/lib/customerIdentity";
import { getCustomerOrigins } from "@/lib/customerLink";

/**
 * GET /api/operator/customers?q=<cédula o correo>
 *
 * Búsqueda EXACTA por cédula o correo, para identificar en la mesa a
 * alguien que quizá nunca comió acá. La identidad del comensal es global
 * (un correo = una persona en toda la plataforma), así que esta búsqueda
 * puede encontrar a cualquiera.
 *
 * Lo que NO devuelve es tan importante como lo que devuelve: solo campos de
 * identidad y el descuento pactado EN ESTE restaurante. Nada de dónde más
 * comió, cuánto gastó ni con quién. Esa información es del otro
 * restaurante, y filtrarla sería una fuga entre clientes de la plataforma.
 *
 * Búsqueda exacta y no "contiene": un `contains` sobre correos convertiría
 * este endpoint en un directorio de comensales de toda la plataforma.
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
    return NextResponse.json({ customer: null });
  }

  const user = await db.user.findUnique({
    where: ident.kind === "email" ? { email: ident.value } : { cedula: ident.value },
    select: {
      id: true,
      name: true,
      email: true,
      cedula: true,
      role: true,
      disabledAt: true,
    },
  });
  if (!user || user.role !== "customer" || user.disabledAt) {
    return NextResponse.json({ customer: null });
  }

  const [discount, origins] = await Promise.all([
    db.customerDiscount.findUnique({
      where: {
        restaurantId_userId: {
          restaurantId: scope.restaurantId,
          userId: user.id,
        },
      },
      select: { percent: true, active: true, note: true },
    }),
    // Para no ofrecer "agregar a mis clientes" a alguien que ya está en la
    // lista. También sale del restaurante de la sesión.
    getCustomerOrigins(scope.restaurantId, user.id),
  ]);

  return NextResponse.json({
    customer: {
      id: user.id,
      name: user.name,
      email: user.email,
      cedula: user.cedula,
      discount: discount?.active ? discount : null,
      /** true si ya aparece en la lista de clientes de este restaurante. */
      inList: origins.length > 0,
    },
  });
}
