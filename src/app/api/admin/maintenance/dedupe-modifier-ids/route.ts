import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { auth } from "@/auth";
import { dedupeModifierIds } from "@/lib/modifiers";

/**
 * Mantenimiento (solo platform_admin): reasigna ids de modificador repetidos
 * en TODOS los productos (o de un comercio si se pasa restaurantId).
 *
 * Antecedente: algunos productos quedaron con dos modificadores que comparten
 * id (datos importados / ediciones viejas). Como la selección del comensal y la
 * comanda se resuelven por `selections[m.id]`, eso cruzaba la selección entre
 * modificadores. Hoy normalizeModifiers deduplica al leer y cada escritura
 * blinda los ids, pero esto deja los DATOS limpios de una vez para todos los
 * consumidores y versiones de cliente.
 *
 * Determinista e idempotente: usa el mismo algoritmo que normalizeModifiers
 * (mantiene el primero, sufija los repetidos), así que correrlo dos veces no
 * cambia nada la segunda vez. Solo reescribe los productos que cambian.
 */

const bodySchema = z
  .object({
    // Opcional: limitar a un comercio. Sin él, recorre todos.
    restaurantId: z.string().min(1).optional(),
    // Por defecto solo informa (dry run). Hay que mandar apply:true para escribir.
    apply: z.boolean().optional(),
  })
  .optional();

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user || session.user.role !== "platform_admin") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const raw = await req.json().catch(() => ({}));
  const parsed = bodySchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const restaurantId = parsed.data?.restaurantId;
  const apply = parsed.data?.apply === true;

  const items = await db.menuItem.findMany({
    where: {
      modifiers: { not: Prisma.DbNull },
      ...(restaurantId ? { restaurantId } : {}),
    },
    select: { id: true, name: true, modifiers: true },
  });

  let scanned = 0;
  const changed: { id: string; name: string; remaps: string[] }[] = [];

  for (const it of items) {
    if (!Array.isArray(it.modifiers)) continue;
    scanned += 1;
    // Solo participan en el dedupe los objetos con id string; los demás se
    // dejan intactos (no colisionan). dedupeModifierIds muta el id in situ
    // sobre estas mismas referencias, así que el array original queda corregido.
    const arr = it.modifiers as Array<Record<string, unknown>>;
    const withId = arr.filter(
      (m): m is Record<string, unknown> & { id: string } =>
        !!m && typeof m === "object" && typeof m.id === "string",
    );
    const before = withId.map((m) => m.id);
    dedupeModifierIds(withId);
    const remaps: string[] = [];
    withId.forEach((m, i) => {
      if (m.id !== before[i]) remaps.push(`${before[i]} → ${m.id}`);
    });
    if (remaps.length > 0) {
      changed.push({ id: it.id, name: it.name, remaps });
      if (apply) {
        await db.menuItem.update({
          where: { id: it.id },
          data: { modifiers: arr as unknown as Prisma.InputJsonValue },
        });
      }
    }
  }

  return NextResponse.json({
    ok: true,
    applied: apply,
    scanned,
    changedCount: changed.length,
    // Detalle acotado para no devolver payloads enormes.
    changed: changed.slice(0, 200),
  });
}
