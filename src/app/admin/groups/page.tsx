import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { fmtBogotaDateTime } from "@/lib/bogota";
import { NewGroupClient } from "./NewGroupClient";

export const dynamic = "force-dynamic";

/**
 * Admin platform: gestión de grupos de restaurantes. Sirve para
 * migrar clientes legacy (varios restaurantes sueltos del mismo
 * dueño) a un grupo nuevo. Auth via /admin/layout.tsx.
 */
export default async function AdminGroupsPage() {
  const t = await getTranslations("opAdminGroups");
  const [groups, ungroupedRestaurants] = await Promise.all([
    db.group.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        _count: {
          select: { restaurants: true, members: true, legalEntities: true },
        },
        // Cada grupo trae sus restaurantes (id+nombre+slug) para
        // listarlos inline en la card — antes sólo se veía el conteo
        // "N restaurantes" y había que entrar a /detalle para saber
        // cuáles eran. Esto es info chica y reduce el roundtrip.
        restaurants: {
          orderBy: { name: "asc" },
          select: { id: true, name: true, slug: true },
        },
      },
    }),
    // Restaurantes sin grupo — candidatos para agregar al crear/asignar.
    db.restaurant.findMany({
      where: { groupId: null },
      orderBy: { name: "asc" },
      select: { id: true, name: true, slug: true },
    }),
  ]);

  return (
    <div className="flex-1 p-4 md:p-6 max-w-4xl mx-auto w-full">
      <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted mb-1">
        {t("platformLabel")}
      </div>
      <div className="font-display text-3xl tracking-[-0.015em] mb-1">
        {t("title")}
      </div>
      <p className="text-sm text-op-muted mb-5">
        {t("intro")}
      </p>

      <NewGroupClient ungroupedRestaurants={ungroupedRestaurants} />

      <div className="mt-6 rounded-2xl border border-op-border bg-op-surface overflow-hidden">
        <div className="px-5 py-3 border-b border-op-border font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted">
          {t("existingGroups", { count: groups.length })}
        </div>
        {groups.length === 0 ? (
          <div className="p-6 text-sm text-op-muted text-center">
            {t("noGroups")}
          </div>
        ) : (
          <ul className="divide-y divide-op-border">
            {groups.map((g) => (
              <li key={g.id} className="p-4 flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <div className="font-display text-lg truncate">
                      {g.name}
                    </div>
                    <span className="font-mono text-[10px] text-op-muted">
                      /{g.slug}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-op-muted mt-1">
                    <span>{t("restaurantCount", { count: g._count.restaurants })}</span>
                    <span aria-hidden>{"·"}</span>
                    <span>{t("memberCount", { count: g._count.members })}</span>
                    <span aria-hidden>{"·"}</span>
                    <span>{t("legalEntityCount", { count: g._count.legalEntities })}</span>
                    <span aria-hidden>{"·"}</span>
                    <span>{t("createdOn", { date: fmtBogotaDateTime(g.createdAt).date })}</span>
                  </div>
                  {/* Chips con los restaurantes del grupo — cada uno
                      linkea a su ficha. Si el grupo está vacío
                      omitimos la fila para no agregar ruido visual. */}
                  {g.restaurants.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {g.restaurants.map((r) => (
                        <Link
                          key={r.id}
                          href={`/admin/restaurants/${r.id}`}
                          className="inline-flex items-center gap-1.5 h-6 px-2 rounded-full bg-op-bg border border-op-border text-[11px] hover:border-ink/40 hover:bg-ink/5"
                        >
                          <span className="truncate max-w-[180px]">
                            {r.name}
                          </span>
                          <span className="font-mono text-[9px] text-op-muted">
                            /{r.slug}
                          </span>
                        </Link>
                      ))}
                    </div>
                  )}
                </div>
                <Link
                  href={`/admin/groups/${g.id}`}
                  className="inline-flex items-center justify-center h-8 px-3 rounded-full border border-op-border text-xs font-medium hover:bg-op-bg shrink-0"
                >
                  {t("detail")}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
