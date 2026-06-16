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
    // Diagnóstico: vuelca la estructura de modificadores (id, tipo, opciones)
    // de cada producto para entender un cruce de selección. Filtrable por
    // nombre (case-insensitive, p.ej. "clásica").
    inspect: z.boolean().optional(),
    nameContains: z.string().min(1).optional(),
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
  const inspect = parsed.data?.inspect === true;
  const nameContains = parsed.data?.nameContains;

  const items = await db.menuItem.findMany({
    where: {
      modifiers: { not: Prisma.DbNull },
      ...(restaurantId ? { restaurantId } : {}),
      ...(nameContains
        ? { name: { contains: nameContains, mode: "insensitive" } }
        : {}),
    },
    select: { id: true, name: true, modifiers: true },
  });

  // Modo diagnóstico: devolvemos la estructura cruda de cada modificador para
  // ver tipos, ids y etiquetas de opciones (y si hay opciones repetidas).
  if (inspect) {
    const report = items
      .filter((it) => Array.isArray(it.modifiers))
      .map((it) => {
        const mods = (it.modifiers as Array<Record<string, unknown>>).map(
          (m) => {
            const opts = Array.isArray(m.opts)
              ? (m.opts as unknown[]).map((o) =>
                  o && typeof o === "object"
                    ? String((o as Record<string, unknown>).label ?? "")
                    : String(o),
                )
              : [];
            const dupOpts = opts.filter((l, i) => opts.indexOf(l) !== i);
            return {
              id: typeof m.id === "string" ? m.id : null,
              type: typeof m.type === "string" ? m.type : null,
              label: typeof m.label === "string" ? m.label : null,
              optCount: opts.length,
              opts,
              dupOpts: [...new Set(dupOpts)],
            };
          },
        );
        const ids = mods.map((m) => m.id).filter(Boolean) as string[];
        const dupIds = ids.filter((id, i) => ids.indexOf(id) !== i);
        return {
          itemId: it.id,
          name: it.name,
          modifierCount: mods.length,
          dupModifierIds: [...new Set(dupIds)],
          modifiers: mods,
        };
      });
    return NextResponse.json({ ok: true, mode: "inspect", count: report.length, report });
  }

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
