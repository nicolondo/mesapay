import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import {
  MODULE_SLUGS,
  resolveEnabledModules,
  type ModuleSlug,
} from "@/lib/modules";
import { recordAuditEvent } from "@/lib/auditLog";

export const dynamic = "force-dynamic";

const slugSchema = z.enum(MODULE_SLUGS as [ModuleSlug, ...ModuleSlug[]]);

const putBody = z.object({
  // Whole-list replace — matches the toggle UX on the admin card.
  modules: z.array(slugSchema),
});

function guard(role?: string) {
  return role === "platform_admin";
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!guard(session?.user?.role)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;
  const r = await db.restaurant.findUnique({
    where: { id },
    select: { enabledModules: true },
  });
  if (!r) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({
    modules: resolveEnabledModules(r.enabledModules),
  });
}

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!guard(session?.user?.role)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;

  const body = await req.json().catch(() => null);
  const parsed = putBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }

  const existing = await db.restaurant.findUnique({
    where: { id },
    select: { name: true, enabledModules: true },
  });
  if (!existing) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // De-dupe defensively in case the client sends repeats.
  const modules = Array.from(new Set(parsed.data.modules));

  const updated = await db.restaurant.update({
    where: { id },
    data: { enabledModules: modules as unknown as object },
    select: { enabledModules: true },
  });

  await recordAuditEvent({
    kind: "restaurant.modules.update",
    restaurantId: id,
    target: { type: "restaurant", id },
    summary: `Módulos ERP de ${existing.name}: [${modules.join(", ") || "ninguno"}]`,
    diff: {
      before: { modules: resolveEnabledModules(existing.enabledModules) },
      after: { modules },
    },
  });

  return NextResponse.json({
    ok: true,
    modules: resolveEnabledModules(updated.enabledModules),
  });
}
