import { readFileSync } from "node:fs";
import path from "node:path";

let cached: string | null = null;

/**
 * ID del build actual (.next/BUILD_ID, generado por `next build`).
 * En dev el archivo no existe → "dev" (el watchdog se desactiva).
 */
export function getBuildId(): string {
  if (cached) return cached;
  try {
    cached = readFileSync(
      path.join(process.cwd(), ".next", "BUILD_ID"),
      "utf8",
    ).trim();
  } catch {
    cached = "dev";
  }
  return cached;
}
