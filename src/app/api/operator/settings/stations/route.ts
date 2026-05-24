import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";

/**
 * Patch shapes (discriminated by which key is present):
 *  - { hasBar }                                  → restaurant-level toggle
 *  - { kitchenPrintEnabled / barPrintEnabled / printPaperWidthMm }
 *                                                → printing config
 *  - { barSubStations }                          → list of bar sub-station
 *                                                  labels for the whole
 *                                                  restaurant
 *  - { categoryId, prepStation }                 → re-route a category
 *  - { categoryId, barSubStation }               → assign sub-station
 *                                                  to a bar category
 */
// Each branch has a unique discriminator key so the client and the
// server narrow without ambiguity. The client just sends one branch
// per request.
const schema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("hasBar"), hasBar: z.boolean() }),
  z.object({
    kind: z.literal("print"),
    kitchenPrintEnabled: z.boolean().optional(),
    barPrintEnabled: z.boolean().optional(),
    printPaperWidthMm: z.union([z.literal(58), z.literal(80)]).optional(),
  }),
  z.object({
    kind: z.literal("subStations"),
    barSubStations: z.array(z.string().trim().min(1).max(40)).max(8),
  }),
  z.object({
    kind: z.literal("categoryStation"),
    categoryId: z.string().min(1),
    prepStation: z.enum(["kitchen", "bar", "counter"]),
  }),
  z.object({
    kind: z.literal("categorySub"),
    categoryId: z.string().min(1),
    barSubStation: z.string().trim().min(1).max(40).nullable(),
  }),
]);

export async function PATCH(req: Request) {
  const session = await auth();
  if (
    !session?.user ||
    (session.user.role !== "operator" &&
      session.user.role !== "platform_admin")
  ) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return NextResponse.json({ error: "no_restaurant" }, { status: 400 });
  }

  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const data = parsed.data;

  if (data.kind === "hasBar") {
    await db.restaurant.update({
      where: { id: restaurantId },
      data: { hasBar: data.hasBar },
    });
    return NextResponse.json({ ok: true });
  }

  if (data.kind === "print") {
    const update: {
      kitchenPrintEnabled?: boolean;
      barPrintEnabled?: boolean;
      printPaperWidthMm?: number;
    } = {};
    if (data.kitchenPrintEnabled !== undefined)
      update.kitchenPrintEnabled = data.kitchenPrintEnabled;
    if (data.barPrintEnabled !== undefined)
      update.barPrintEnabled = data.barPrintEnabled;
    if (data.printPaperWidthMm !== undefined)
      update.printPaperWidthMm = data.printPaperWidthMm;
    await db.restaurant.update({ where: { id: restaurantId }, data: update });
    return NextResponse.json({ ok: true });
  }

  if (data.kind === "subStations") {
    // Dedupe + normalize. We don't enforce a particular order beyond
    // what the operator typed — they edit the list as a whole.
    const cleaned = Array.from(
      new Set(
        data.barSubStations
          .map((s) => s.trim())
          .filter((s) => s.length > 0),
      ),
    );
    await db.restaurant.update({
      where: { id: restaurantId },
      data: { barSubStations: cleaned },
    });
    // If we removed a sub-station that some categories still point to,
    // clear those references so we don't end up with orphan labels.
    if (cleaned.length === 0) {
      await db.category.updateMany({
        where: { restaurantId, barSubStation: { not: null } },
        data: { barSubStation: null },
      });
    } else {
      await db.category.updateMany({
        where: {
          restaurantId,
          barSubStation: { not: null, notIn: cleaned },
        },
        data: { barSubStation: null },
      });
    }
    return NextResponse.json({ ok: true });
  }

  // Category-level updates — scope to the active restaurant so an
  // operator can't reroute another tenant's category by guessing IDs.
  const cat = await db.category.findUnique({
    where: { id: data.categoryId },
    select: { restaurantId: true },
  });
  if (!cat || cat.restaurantId !== restaurantId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  if (data.kind === "categoryStation") {
    await db.category.update({
      where: { id: data.categoryId },
      data: { prepStation: data.prepStation },
    });
    return NextResponse.json({ ok: true });
  }

  // categorySub branch — must be one of the configured sub-stations.
  if (data.barSubStation !== null) {
    const rest = await db.restaurant.findUnique({
      where: { id: restaurantId },
      select: { barSubStations: true },
    });
    if (!rest?.barSubStations.includes(data.barSubStation)) {
      return NextResponse.json(
        { error: "unknown_sub_station" },
        { status: 400 },
      );
    }
  }
  await db.category.update({
    where: { id: data.categoryId },
    data: { barSubStation: data.barSubStation },
  });
  return NextResponse.json({ ok: true });
}
