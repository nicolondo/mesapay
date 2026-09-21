import { Prisma } from "@prisma/client";
import type { DmmfField } from "./tables";

/**
 * Una fila de Prisma ↔ JSON puro, guiado por el tipo de cada campo en el
 * DMMF (no por `instanceof`, que se rompe con Decimal/Bytes entre runtimes).
 *
 *   DateTime → ISO 8601        Decimal → string        BigInt → string
 *   Bytes    → base64          Json    → tal cual      listas → elemento a elemento
 *
 * Al volver, `null` en un campo Json se escribe como `Prisma.DbNull`
 * (Prisma no acepta `null` pelado ahí). Se pierde la diferencia entre un
 * NULL de la base y un `null` JSON guardado como valor: al leer, Prisma
 * devuelve `null` en los dos casos, así que ya venía perdida.
 */
export type SnapshotRow = Record<string, unknown>;

function toJson(field: DmmfField, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  switch (field.type) {
    case "DateTime":
      return value instanceof Date ? value.toISOString() : String(value);
    case "Decimal":
    case "BigInt":
      return String(value);
    case "Bytes":
      return Buffer.from(value as Uint8Array).toString("base64");
    default:
      return value;
  }
}

function fromJson(field: DmmfField, value: unknown): unknown {
  if (value === null || value === undefined) {
    if (field.type === "Json") return field.isRequired ? Prisma.JsonNull : Prisma.DbNull;
    return null;
  }
  switch (field.type) {
    case "DateTime":
      return new Date(value as string);
    case "Decimal":
      return new Prisma.Decimal(value as string);
    case "BigInt":
      return BigInt(value as string);
    case "Bytes":
      return Buffer.from(value as string, "base64");
    default:
      return value;
  }
}

export function serializeRow(fields: DmmfField[], row: SnapshotRow): SnapshotRow {
  const out: SnapshotRow = {};
  for (const f of fields) {
    if (f.kind === "object" || !(f.name in row)) continue;
    const v = row[f.name];
    out[f.name] = f.isList && Array.isArray(v) ? v.map((x) => toJson(f, x)) : toJson(f, v);
  }
  return out;
}

export function deserializeRow(fields: DmmfField[], row: SnapshotRow): SnapshotRow {
  const out: SnapshotRow = {};
  for (const f of fields) {
    if (f.kind === "object") continue;
    if (!(f.name in row)) continue; // columna nueva desde la copia: queda con su default
    const v = row[f.name];
    out[f.name] = f.isList && Array.isArray(v) ? v.map((x) => fromJson(f, x)) : fromJson(f, v);
  }
  return out;
}
