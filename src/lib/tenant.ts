import { headers } from "next/headers";
import { db } from "./db";

// Resolved tenant context — set by middleware via header
export async function getTenantSlug(): Promise<string | null> {
  const h = await headers();
  return h.get("x-tenant-slug");
}

export async function getTenant() {
  const slug = await getTenantSlug();
  if (!slug) return null;
  return db.restaurant.findUnique({ where: { slug } });
}

export async function requireTenant() {
  const t = await getTenant();
  if (!t) throw new Error("Tenant not found");
  return t;
}
