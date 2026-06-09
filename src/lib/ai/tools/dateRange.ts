import { z } from "zod";

export type DateRange = { from: Date; to: Date };

const rangeObjectZod = z.union([
  z.object({ preset: z.enum(["7d", "30d", "90d", "mtd", "qtd"]) }),
  z.object({ from: z.string(), to: z.string() }),
]);

// Claude a veces serializa el argumento anidado `range` como STRING JSON
// (ej. '{"preset":"mtd"}') en vez de objeto. Lo toleramos: si llega string,
// lo parseamos antes de validar. Evita que el agente entre en bucle de
// reintentos por "input inválido".
export const rangeInputZod = z
  .preprocess((v) => {
    if (typeof v === "string") {
      try {
        return JSON.parse(v);
      } catch {
        return v;
      }
    }
    return v;
  }, rangeObjectZod)
  .default({ preset: "30d" });

export const rangeJsonSchema = {
  description: "Rango de fechas. Default últimos 30 días.",
  oneOf: [
    { type: "object", properties: { preset: { enum: ["7d", "30d", "90d", "mtd", "qtd"] } }, required: ["preset"] },
    { type: "object", properties: { from: { type: "string" }, to: { type: "string" } }, required: ["from", "to"] },
  ],
} as const;
export type RangeInput =
  | { preset: "7d" | "30d" | "90d" | "mtd" | "qtd" }
  | { from: string; to: string };

const MAX_DAYS = 400; // ~13 meses

export function timezoneForCountry(country: string | null | undefined): string {
  switch ((country || "").toUpperCase()) {
    case "MX":
      return "America/Mexico_City";
    case "CO":
      return "America/Bogota";
    default:
      return "America/Bogota";
  }
}

export function resolveRange(input: RangeInput, now = new Date()): DateRange {
  let to = now;
  let from: Date;
  if ("preset" in input) {
    const map: Record<string, number> = { "7d": 7, "30d": 30, "90d": 90 };
    if (input.preset === "mtd") {
      from = new Date(now.getFullYear(), now.getMonth(), 1);
    } else if (input.preset === "qtd") {
      const q = Math.floor(now.getMonth() / 3) * 3;
      from = new Date(now.getFullYear(), q, 1);
    } else {
      from = new Date(now.getTime() - (map[input.preset] ?? 30) * 86400000);
    }
  } else {
    from = new Date(input.from);
    to = new Date(input.to);
  }
  // clamp
  if ((to.getTime() - from.getTime()) / 86400000 > MAX_DAYS) {
    from = new Date(to.getTime() - MAX_DAYS * 86400000);
  }
  if (from.getTime() > to.getTime()) from = new Date(to.getTime() - 30 * 86400000);
  return { from, to };
}
