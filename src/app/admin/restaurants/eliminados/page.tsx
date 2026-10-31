import Link from "next/link";
import { redirect } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { auth } from "@/auth";
import { formatDate, localeTag } from "@/lib/format";
import type { Locale } from "@/i18n/config";
import { listDeletedRestaurants } from "@/lib/restaurantDeletion";

export const dynamic = "force-dynamic";

/**
 * Comercios eliminados: el archivo final de cada uno (ZIP con los datos, los
 * documentos fiscales DIAN y los archivos a conservar) para descargar. Sin
 * restauración automática. Ver src/lib/restaurantDeletion.
 */
const SUMMARY_KEYS = ["orders", "dianInvoices", "creditNotes", "users", "files"] as const;

export default async function DeletedRestaurantsPage({
  searchParams,
}: {
  searchParams: Promise<{ deleted?: string }>;
}) {
  // El layout ya exige platform_admin; se repite acá porque la lista expone
  // datos de comercios que ya no existen y el layout no se re-renderiza en
  // cada navegación.
  const session = await auth();
  if (session?.user?.role !== "platform_admin") redirect("/");

  const sp = await searchParams;
  const t = await getTranslations("adminDelete");
  const locale = (await getLocale()) as Locale;
  const numberFmt = new Intl.NumberFormat(localeTag(locale), { maximumFractionDigits: 1 });
  const size = (bytes: number) =>
    bytes < 1024 * 1024
      ? t("sizeKb", { n: numberFmt.format(bytes / 1024) })
      : t("sizeMb", { n: numberFmt.format(bytes / (1024 * 1024)) });
  const rows = await listDeletedRestaurants();

  return (
    <div className="flex-1 p-4 md:p-6 max-w-5xl mx-auto w-full">
      <Link
        href="/admin/restaurants"
        className="font-mono text-[10px] tracking-wider uppercase text-op-muted hover:text-op-text"
      >
        {t("backToRestaurants")}
      </Link>
      <h1 className="font-display text-2xl md:text-3xl mt-4">{t("listTitle")}</h1>
      <p className="text-sm text-op-muted mt-1 mb-6">{t("listIntro")}</p>

      {sp.deleted && (
        <div className="mb-4 rounded-lg border border-ok/30 bg-ok/10 text-[#1E5339] px-3 py-2 text-sm" role="status">
          {t("deletedBanner", { slug: sp.deleted })}
        </div>
      )}

      {rows.length === 0 ? (
        <div className="rounded-2xl border border-op-border bg-op-surface p-6 text-sm text-op-muted">
          {t("listEmpty")}
        </div>
      ) : (
        <ul className="space-y-3">
          {rows.map((row) => {
            const summary = ((row.counts as { summary?: Record<string, number> } | null)?.summary ?? {}) as Record<
              string,
              number
            >;
            return (
              <li key={row.id} className="rounded-2xl border border-op-border bg-op-surface p-4">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <div className="font-display text-lg leading-tight">{row.name}</div>
                    <div className="font-mono text-[11px] text-op-muted">
                      {"/"}
                      {row.slug}
                      {row.taxId ? (
                        <>
                          {" · "}
                          {t("colTaxId", { taxId: row.taxId })}
                        </>
                      ) : null}
                    </div>
                    <div className="text-[11px] text-op-muted mt-1">
                      {t("deletedOn", { date: formatDate(row.deletedAt, { locale }), email: row.deletedByEmail })}
                    </div>
                  </div>
                  <a
                    href={`/api/admin/deleted-restaurants/${row.id}/archive`}
                    className="h-9 px-4 rounded-full bg-ink text-bone text-sm font-medium inline-flex items-center shrink-0"
                    download
                  >
                    {t("download")}
                    <span className="ml-2 font-mono text-[11px] opacity-80">{size(row.archiveBytes)}</span>
                  </a>
                </div>
                <dl className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs">
                  {SUMMARY_KEYS.map((key) => (
                    <div key={key} className="flex gap-1">
                      <dt className="text-op-muted">{t(`count_${key}`)}</dt>
                      <dd className="font-mono tabular">{numberFmt.format(summary[key] ?? 0)}</dd>
                    </div>
                  ))}
                </dl>
                <div className="mt-2 font-mono text-[10px] text-op-muted break-all">
                  {t("checksum", { hash: row.archiveSha256 })}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
