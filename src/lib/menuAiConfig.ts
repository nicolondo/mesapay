import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { db } from "@/lib/db";
import { encrypt, decrypt } from "@/lib/crypto";
import { env } from "@/lib/env";

export class MenuAiError extends Error {
  constructor(public code: "ai_not_configured" | "ai_disabled" | "ai_failed") {
    super(code);
    this.name = "MenuAiError";
  }
}

export async function getMenuAiStatus() {
  const row = await db.platformConfig.findUnique({
    where: { id: "singleton" },
    select: { menuAiKeyEnc: true, menuAiEnabled: true },
  });
  return {
    enabled: row?.menuAiEnabled ?? true,
    source: row?.menuAiKeyEnc
      ? ("admin" as const)
      : env.ANTHROPIC_API_KEY
        ? ("server" as const)
        : ("none" as const),
  };
}

export async function setMenuAiConfig(
  input: { apiKey?: string; enabled: boolean },
  actorId: string,
) {
  const data = {
    menuAiEnabled: input.enabled,
    updatedById: actorId,
    ...(input.apiKey?.trim()
      ? { menuAiKeyEnc: encrypt(input.apiKey.trim()) }
      : {}),
  };
  await db.platformConfig.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", ...data },
    update: data,
  });
}

/** One credential for all restaurants; no tenant key or browser exposure. Read
 * per operation so key rotation / disable applies on the next generation. */
export async function getMenuAiClient() {
  const row = await db.platformConfig.findUnique({
    where: { id: "singleton" },
    select: { menuAiKeyEnc: true, menuAiEnabled: true },
  });
  if (row?.menuAiEnabled === false) throw new MenuAiError("ai_disabled");
  let key: string | undefined;
  try {
    key = row?.menuAiKeyEnc ? decrypt(row.menuAiKeyEnc) : env.ANTHROPIC_API_KEY;
  } catch {
    throw new MenuAiError("ai_failed");
  }
  if (!key) throw new MenuAiError("ai_not_configured");
  return new Anthropic({ apiKey: key, timeout: 25000, maxRetries: 0 });
}
