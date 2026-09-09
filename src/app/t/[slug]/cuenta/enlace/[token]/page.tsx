import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { headers } from "next/headers";
import { getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { hashMagicLinkToken, isMagicLinkUsable } from "@/lib/magicLink";
import { createDinerSession } from "@/lib/dinerSession";

export const dynamic = "force-dynamic";

/**
 * Canje del enlace de acceso directo, DENTRO del comercio que lo emitió.
 *
 * El enlace no puede abrir sesión en otro restaurante: además de colgar de
 * un `Diner` (que pertenece a un solo local), acá se compara el restaurante
 * del token contra el slug de la URL. Un enlace del restaurante A pegado en
 * `/t/b/cuenta/enlace/...` cae en "enlace inválido".
 *
 * El GET solo VALIDA y muestra un botón; el canje ocurre en el POST de la
 * server action. El toque extra es a propósito: los antivirus de correo y
 * los pre-fetchers corporativos abren los links de un correo antes que el
 * humano, y si consumiéramos el token en el GET, el comensal recibiría
 * "enlace vencido" sin haberlo tocado. Con el botón, el único que canjea
 * es quien realmente está ahí.
 *
 * Al canjear se abre una DinerSession PERMANENTE: lo que vencía era el
 * enlace, no la sesión.
 */
export default async function MagicLinkPage({
  params,
}: {
  params: Promise<{ slug: string; token: string }>;
}) {
  const { slug, token } = await params;
  const t = await getTranslations("customerAuth");

  const tenant = await db.restaurant.findUnique({
    where: { slug },
    select: { id: true, name: true },
  });
  if (!tenant) return notFound();
  const tenantId = tenant.id;

  const record = await db.dinerMagicLink.findUnique({
    where: { tokenHash: hashMagicLinkToken(token) },
    select: {
      id: true,
      usedAt: true,
      expiresAt: true,
      diner: {
        select: { id: true, email: true, restaurantId: true, disabledAt: true },
      },
    },
  });

  const usable =
    isMagicLinkUsable(record) &&
    !record?.diner.disabledAt &&
    record?.diner.restaurantId === tenantId;

  if (!usable || !record) {
    return (
      <main className="flex flex-1 items-center justify-center px-6 py-16 bg-bone">
        <div className="w-full max-w-sm bg-paper rounded-2xl p-7 border border-hairline text-center">
          <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-muted mb-2">
            {tenant.name}
          </div>
          <h1 className="font-display text-3xl tracking-[-0.015em] mb-2">
            {t("linkInvalidTitle")}
          </h1>
          <p className="text-sm text-muted mb-6">{t("linkInvalidBody")}</p>
          <Link
            href={`/t/${slug}/cuenta/entrar`}
            className="inline-flex items-center justify-center w-full h-11 rounded-lg bg-ink text-bone font-medium"
          >
            {t("linkRequestNew")}
          </Link>
        </div>
      </main>
    );
  }

  async function consume() {
    "use server";
    // Se vuelve a leer y se reclama con updateMany({ usedAt: null }): esa
    // condición es la que hace el "un solo uso" a prueba de dobles clics /
    // dos pestañas. Si otro request ya lo canjeó, count = 0 y no seguimos.
    const claimed = await db.dinerMagicLink.updateMany({
      where: {
        tokenHash: hashMagicLinkToken(token),
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
      data: { usedAt: new Date() },
    });
    if (claimed.count === 0) redirect(`/t/${slug}/cuenta/entrar`);

    const fresh = await db.dinerMagicLink.findUnique({
      where: { tokenHash: hashMagicLinkToken(token) },
      select: {
        diner: { select: { id: true, restaurantId: true, disabledAt: true } },
      },
    });
    // Se revalida el comercio también acá: entre el GET y el POST el enlace
    // sigue siendo del restaurante que lo emitió, y de ningún otro.
    if (
      !fresh ||
      fresh.diner.disabledAt ||
      fresh.diner.restaurantId !== tenantId
    ) {
      redirect(`/t/${slug}/cuenta/entrar`);
    }

    const h = await headers();
    await createDinerSession(fresh.diner, h.get("user-agent"));
    redirect(`/t/${slug}/cuenta`);
  }

  return (
    <main className="flex flex-1 items-center justify-center px-6 py-16 bg-bone">
      <div className="w-full max-w-sm bg-paper rounded-2xl p-7 border border-hairline text-center">
        <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-muted mb-2">
          {tenant.name}
        </div>
        <h1 className="font-display text-3xl tracking-[-0.015em] mb-2">
          {t("linkTitle")}
        </h1>
        <p className="text-sm text-muted mb-6">
          {t("linkBody", { email: record.diner.email })}
        </p>
        <form action={consume}>
          <button
            type="submit"
            className="w-full h-11 rounded-lg bg-ink text-bone font-medium"
          >
            {t("linkSubmit")}
          </button>
        </form>
        <p className="text-xs text-muted-2 mt-4">{t("linkWhy")}</p>
        <p className="text-xs text-muted-2 mt-2">{t("sessionNote")}</p>
      </div>
    </main>
  );
}
