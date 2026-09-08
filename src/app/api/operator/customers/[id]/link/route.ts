import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireOperatorScope, isScopeError } from "@/lib/operatorScope";
import { getCustomerOrigins } from "@/lib/customerLink";

/**
 * Agregar / quitar a un comensal de la lista de clientes de ESTE
 * restaurante.
 *
 * ── Por qué es un acto explícito y no automático ──────────────────────
 * La cuenta del comensal es global, así que no se puede listar a todos los
 * `role = customer`: sería mostrarle a cada restaurante la base de los
 * demás. Este endpoint es la puerta para los comensales que ya existían
 * antes de que empezáramos a guardar de dónde venían (se registraron sin
 * que nadie anotara el restaurante y nunca pidieron nada).
 *
 * El operador ya tuvo que identificarlos: para llegar acá los buscó por
 * cédula o correo EXACTOS en `GET /api/operator/customers`. Agregar no
 * revela a nadie que el operador no conociera ya — solo hace persistente
 * un vínculo que él mismo afirma.
 *
 * El `restaurantId` sale de la sesión, nunca del body: un restaurante no
 * puede meter comensales en la lista de otro.
 */

const ALLOWED_ROLES = ["operator", "platform_admin", "group_admin"] as const;

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  // Mismos roles que el descuento: agregar a alguien a la lista de clientes
  // es una decisión comercial, no una tarea de servicio de mesa.
  const scope = await requireOperatorScope([...ALLOWED_ROLES]);
  if (isScopeError(scope)) {
    return NextResponse.json(
      { error: scope.error },
      { status: scope.error === "forbidden" ? 403 : 400 },
    );
  }

  const { id: userId } = await params;
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true, disabledAt: true },
  });
  if (!user || user.role !== "customer" || user.disabledAt) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // Upsert y no create: agregar dos veces (dos pestañas, doble clic) tiene
  // que ser inofensivo. Si ya venía de un registro hecho desde acá, se
  // respeta ese origen — es el más informativo de los dos.
  await db.restaurantCustomer.upsert({
    where: {
      restaurantId_userId: { restaurantId: scope.restaurantId, userId },
    },
    create: { restaurantId: scope.restaurantId, userId, source: "added" },
    update: {},
  });

  return NextResponse.json({
    ok: true,
    origins: await getCustomerOrigins(scope.restaurantId, userId),
  });
}

/**
 * DELETE — deshace el "agregar".
 *
 * Solo borra el vínculo explícito. Si además consumió acá o tiene un
 * descuento pactado, sigue en la lista por esos otros orígenes: ninguna
 * pantalla puede borrar facturas ni acuerdos comerciales. Por eso la UI
 * solo ofrece este botón cuando el vínculo explícito es el único motivo
 * por el que aparece.
 */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const scope = await requireOperatorScope([...ALLOWED_ROLES]);
  if (isScopeError(scope)) {
    return NextResponse.json(
      { error: scope.error },
      { status: scope.error === "forbidden" ? 403 : 400 },
    );
  }

  const { id: userId } = await params;
  // deleteMany y no delete: el par (restaurante, comensal) puede no existir
  // y eso no es un error — el resultado deseado ya se cumple.
  await db.restaurantCustomer.deleteMany({
    where: { restaurantId: scope.restaurantId, userId },
  });

  return NextResponse.json({ ok: true });
}
