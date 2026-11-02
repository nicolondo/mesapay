import type { MetadataRoute } from "next";
import { db } from "@/lib/db";
import { LEGAL_DOCUMENTS, LEGAL_PATHS, type LegalDocumentId } from "@/content/legal";

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
    // Documentos legales públicos (indexables; la fecha es la de su última versión).
    ...(Object.keys(LEGAL_PATHS) as LegalDocumentId[]).map((id) => ({
      url: `${BASE}${LEGAL_PATHS[id]}`,
      lastModified: new Date(`${LEGAL_DOCUMENTS[id].updatedAt}T12:00:00Z`),
      changeFrequency: "yearly" as const,
      priority: 0.3,
    })),
    // Presentación comercial (HTML estático en public/presentacion).
    {
      url: `${BASE}/presentacion`,
      lastModified: new Date(),
      changeFrequency: "monthly" as const,
      priority: 0.8,
    },
    ...restaurants.map((r) => ({
      url: `${BASE}/r/${r.slug}`,
      lastModified: r.updatedAt,
      changeFrequency: "weekly" as const,
      priority: 0.6,
    })),
  ];
}
