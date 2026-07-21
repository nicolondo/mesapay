import type { MetadataRoute } from "next";
import { db } from "@/lib/db";

// Sitemap para Google (https://mesapay.co/sitemap.xml). Superficies públicas
// indexables: la landing + la página pública de reservas de cada comercio
// con reservas activas (/r/[slug] — sirve para búsquedas del nombre del
// restaurante). Las zonas privadas (operator/admin/api) ya están en Disallow
// de robots.txt; los menús QR (/t/[slug]) no se listan: son por-mesa y no
// aportan a búsqueda.
//
// Se regenera como mucho una vez al día; agregar un restaurante aparece acá
// sin redeploy.
export const revalidate = 86400;

const BASE = "https://mesapay.co";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  // .catch: si la BD no está disponible (build local), el sitemap igual
  // sale con la landing — nunca rompe el build.
  const restaurants = await db.restaurant
    .findMany({
      where: { reservationsEnabled: true },
      select: { slug: true, updatedAt: true },
    })
    .catch(() => [] as Array<{ slug: string; updatedAt: Date }>);

  return [
    {
      url: `${BASE}/`,
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 1,
    },
    ...restaurants.map((r) => ({
      url: `${BASE}/r/${r.slug}`,
      lastModified: r.updatedAt,
      changeFrequency: "weekly" as const,
      priority: 0.6,
    })),
  ];
}
