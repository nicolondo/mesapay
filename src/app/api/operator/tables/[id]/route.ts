import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { auth } from "@/auth";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";

const patchSchema = z.object({
  label: z.string().trim().max(40).nullable().optional(),
  // Número de la mesa. Editable por operator/admin (no mesero). Único
  // por comercio. NO afecta el QR (el QR usa qrToken, no el número).
  number: z.number().int().min(1).max(9999).optional(),
  // Atributos de reserva — los edita el operador desde la gestión de
  // mesas. Todos opcionales: un PATCH puede tocar sólo el label, sólo
  // la capacidad, etc. minConsumptionCents null limpia el mínimo.
  capacity: z.number().int().min(1).max(40).optional(),
  minConsumptionCents: z
    .number()
    .int()
    .min(0)
    .max(100_000_000)
    .nullable()
    .optional(),
  reservable: z.boolean().optional(),
  shape: z.enum(["square", "round", "bar"]).optional(),
  // Depósito para reservar la mesa (en centavos). null/0 = sin depósito.
  reservationDepositCents: z
    .number()
    .int()
    .min(0)
    .max(100_000_000)
    .nullable()
    .optional(),
});

async function guard(id: string, opts: { allowMesero?: boolean } = {}) {
  const session = await auth();
  const role = session?.user?.role;
  const allowed =
    role === "operator" ||
    role === "platform_admin" ||
    (opts.allowMesero === true && role === "mesero");
  if (!session?.user || !allowed) {
    return { error: "unauthorized" as const };
  }
  const table = await db.table.findUnique({ where: { id } });
  if (!table) return { error: "not found" as const };
  const activeId = await getActiveRestaurantId();
  if (table.restaurantId !== activeId) {
    return { error: "forbidden" as const };
  }
  return { table };
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  // PATCH solo cambia el label hoy — un mesero etiquetando una mesa
  // como "Terraza 3" o "Ventana" es legítimo. Borrado (DELETE) sigue
  // restringido al operador.
  const g = await guard(id, { allowMesero: true });
  if ("error" in g) return NextResponse.json({ error: g.error }, { status: 403 });

  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }

  // Los atributos de reserva (capacidad, consumo mínimo, etc.) son
  // config del local — solo operator/admin. El mesero solo puede
  // tocar el label (etiquetar una mesa). Si un mesero manda esos
  // campos, los ignoramos silenciosamente.
  const role = (await auth())?.user?.role;
  const canEditReservationAttrs =
    role === "operator" || role === "platform_admin";

  // Cambio de número (solo operator/admin). Validamos unicidad por
  // comercio antes de tocar nada; la constraint @@unique también lo
  // protege a nivel DB (catch P2002 más abajo por si hay carrera).
  const oldNumber = g.table.number;
  const wantsNumber =
    canEditReservationAttrs &&
    parsed.data.number !== undefined &&
    parsed.data.number !== oldNumber;
  const newNumber = parsed.data.number;
  if (wantsNumber) {
    const clash = await db.table.findFirst({
      where: {
        restaurantId: g.table.restaurantId,
        number: newNumber,
        NOT: { id },
      },
      select: { id: true },
    });
    if (clash) {
      return NextResponse.json({ error: "number_taken" }, { status: 409 });
    }
  }

  try {
    await db.$transaction(async (tx) => {
      await tx.table.update({
        where: { id },
        data: {
          label:
            parsed.data.label === undefined ? undefined : parsed.data.label,
          ...(canEditReservationAttrs && {
            ...(wantsNumber && { number: newNumber }),
            ...(parsed.data.capacity !== undefined && {
              capacity: parsed.data.capacity,
            }),
            ...(parsed.data.minConsumptionCents !== undefined && {
              minConsumptionCents: parsed.data.minConsumptionCents,
            }),
            ...(parsed.data.reservable !== undefined && {
              reservable: parsed.data.reservable,
            }),
            ...(parsed.data.shape !== undefined && {
              shape: parsed.data.shape,
            }),
            ...(parsed.data.reservationDepositCents !== undefined && {
              reservationDepositCents: parsed.data.reservationDepositCents,
            }),
          }),
        },
      });

      // Los meseros con mesas asignadas guardan NÚMEROS, no ids. Si el
      // número cambió, migramos esas asignaciones para que sigan
      // apuntando a la misma mesa.
      if (wantsNumber && newNumber !== undefined) {
        const affected = await tx.user.findMany({
          where: {
            restaurantId: g.table.restaurantId,
            assignedTableNumbers: { has: oldNumber },
          },
          select: { id: true, assignedTableNumbers: true },
        });
        for (const u of affected) {
          await tx.user.update({
            where: { id: u.id },
            data: {
              assignedTableNumbers: u.assignedTableNumbers.map((n) =>
                n === oldNumber ? newNumber : n,
              ),
            },
          });
        }
      }
    });
  } catch (err) {
    // Carrera contra la unique([restaurantId, number]).
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: string }).code === "P2002"
    ) {
      return NextResponse.json({ error: "number_taken" }, { status: 409 });
    }
    throw err;
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const g = await guard(id);
  if ("error" in g) return NextResponse.json({ error: g.error }, { status: 403 });

  const openOrders = await db.order.count({
    where: { tableId: id, status: { notIn: ["paid", "cancelled"] } },
  });
  if (openOrders > 0) {
    return NextResponse.json(
      { error: "open_order", message: "La mesa tiene un pedido abierto" },
      { status: 409 },
    );
  }
  const pastOrders = await db.order.count({ where: { tableId: id } });
  if (pastOrders > 0) {
    return NextResponse.json(
      {
        error: "has_history",
        message:
          "La mesa tiene historial de pedidos. Archívala en vez de borrarla.",
      },
      { status: 409 },
    );
  }

  await db.table.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
