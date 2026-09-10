import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { secureApi } from "@/lib/secureApi";
import { getMenuAiStatus, setMenuAiConfig } from "@/lib/menuAiConfig";
import { recordAuditEvent } from "@/lib/auditLog";

const schema = z
  .object({
    enabled: z.boolean(),
    apiKey: z.string().trim().max(500).optional(),
  })
  .strict();
export const PATCH = secureApi(async (req: Request) => {
  const session = await auth();
  if (session?.user?.role !== "platform_admin")
    return NextResponse.json({ error: "unauthorized" }, { status: 403 });
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (
    !parsed.success ||
    (parsed.data.apiKey && !/^sk-ant-[A-Za-z0-9_-]+$/.test(parsed.data.apiKey))
  )
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  await setMenuAiConfig(parsed.data, session.user.id);
  await recordAuditEvent({
    kind: "platform.menu_ai.update",
    restaurantId: null,
    target: { type: "platform_config" },
    summary: "Updated shared menu AI configuration",
  });
  return NextResponse.json({ ok: true, ...(await getMenuAiStatus()) });
});
