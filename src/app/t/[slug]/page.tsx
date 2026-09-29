import Link from "next/link";
import { db } from "@/lib/db";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

export default async function TenantLanding({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const tenant = await db.restaurant.findUnique({
    where: { slug },
    include: { tables: { orderBy: { number: "asc" } } },
  });
  if (!tenant) return notFound();

  const counter = tenant.serviceMode === "counter" ? tenant.tables[0] : null;

  const t = await getTranslations("landing");

  return (
    <main className="flex flex-1 flex-col items-center justify-center px-6 py-20">
      <div className="w-full max-w-md text-center">
        <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-muted mb-4">
          {t("welcomeTo")}
        </div>
        <h1 className="font-display text-5xl tracking-[-0.02em] leading-[1.05]">
          {tenant.name}
        </h1>
        {tenant.tagline && (
          <p className="mt-2 text-muted">{tenant.tagline}</p>
        )}

        <div className="mt-8 flex flex-col gap-3">
          <Link
            href={`/t/${slug}/menu?browse=1`}
            className="rounded-full bg-ink px-6 py-3 font-medium text-bone"
          >
            {t("viewMenu")}
          </Link>
          {counter && (
            <Link
              href={`/t/${slug}/menu?table=${counter.qrToken}`}
              className="rounded-full border border-hairline px-6 py-3 font-medium"
            >
              {t("startOrder")}
            </Link>
          )}
        </div>

        {!counter && <div className="mt-10">
          <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-muted mb-3">
            {t(process.env.NODE_ENV === "production" ? "scanTable" : "chooseTable")}
          </div>
          <div className="grid grid-cols-5 gap-2">
            {(process.env.NODE_ENV === "production" ? [] : tenant.tables).map((t) => (
              <Link
                key={t.id}
                href={`/t/${slug}/menu?table=${t.qrToken}`}
                className="h-14 rounded-xl bg-paper border border-hairline flex items-center justify-center font-display text-2xl hover:bg-ivory hover:border-terracotta transition-colors"
              >
                {t.number}
              </Link>
            ))}
          </div>
          {process.env.NODE_ENV !== "production" && <p className="mt-4 text-xs text-muted-2">{t("devTableHint")}</p>}
        </div>}

        <div className="mt-10 pt-6 border-t border-hairline">
          <Link
            href={`/operator?r=${slug}`}
            className="font-mono text-[11px] tracking-[0.12em] uppercase text-muted hover:text-terracotta"
          >
            → {t("operatorAccess")}
          </Link>
        </div>
      </div>
    </main>
  );
}
