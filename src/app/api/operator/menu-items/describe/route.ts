import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { secureApi } from "@/lib/secureApi";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { db } from "@/lib/db";
import { generateMenuDescriptions } from "@/lib/menuDescribe";
import { MenuAiError } from "@/lib/menuAiConfig";
import { allowMenuAi } from "@/lib/menuAiLimit";

const schema = z.object({
  name: z.string().trim().min(1).max(200),
  categoryId: z.string().min(1).max(100),
  description: z.string().trim().max(500).optional(),
});
export const POST = secureApi(async (req: Request) => {
  const session = await auth();
  if (
    !session?.user ||
    !["operator", "platform_admin", "group_admin"].includes(session.user.role)
  )
    return NextResponse.json({ error: "unauthorized" }, { status: 403 });
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId)
    return NextResponse.json({ error: "no_restaurant" }, { status: 400 });
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  const category = await db.category.findFirst({
    where: { id: parsed.data.categoryId, restaurantId },
    select: { label: true, parent: { select: { label: true } } },
  });
  if (!category)
    return NextResponse.json({ error: "invalid_category" }, { status: 400 });
  if (!(await allowMenuAi(restaurantId)))
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  try {
    const result = await generateMenuDescriptions([
      {
        id: "draft",
        name: parsed.data.name,
        description: parsed.data.description,
        categoryLabel: category.label,
        parentCategoryLabel: category.parent?.label,
      },
    ]);
    return NextResponse.json({ description: result.get("draft") });
  } catch (error) {
    const code = error instanceof MenuAiError ? error.code : "ai_failed";
    return NextResponse.json(
      { error: code },
      { status: code === "ai_failed" ? 502 : 503 },
    );
  }
});
