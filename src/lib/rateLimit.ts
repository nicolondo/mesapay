import { createHash } from "node:crypto";
import { db } from "./db";

export async function rateLimit(subject: string, limit: number, seconds: number): Promise<boolean> {
  const bucket = Math.floor(Date.now() / (seconds * 1000));
  const key = createHash("sha256").update(`${subject}:${bucket}`).digest("hex");
  const expiresAt = new Date((bucket + 2) * seconds * 1000);
  const result = await db.rateLimitBucket.upsert({ where: { key }, create: { key, expiresAt, hits: 1 }, update: { hits: { increment: 1 } }, select: { hits: true } });
  return result.hits <= limit;
}
