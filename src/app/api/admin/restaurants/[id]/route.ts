import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";

/**
 * Platform-admin edits to a restaurant's profile. Today only the name
 * is editable — the slug lives in every printed QR code and changing
 * it would silently break tables, so we keep that immutable from this
 * surface. If we ever need a "rebrand + reissue QRs" flow it deserves
 * its own UI with explicit confirmation, not an inline rename.
 */
const patchSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  tagline: z.string().trim().max(120).nullable().optional(),
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "platform_admin") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const existing = await db.restaurant.findUnique({
    where: { id },
    select: { id: true },
  });
  if (!existing) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  await db.restaurant.update({
    where: { id },
    data: {
      ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
      ...(parsed.data.tagline !== undefined
        ? { tagline: parsed.data.tagline }
        : {}),
    },
  });
  return NextResponse.json({ ok: true });
}
