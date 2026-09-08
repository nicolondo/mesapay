import Link from "next/link";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { hashMagicLinkToken, isMagicLinkUsable } from "@/lib/magicLink";
import { createCustomerSession } from "@/lib/customerSession";

export const dynamic = "force-dynamic";

/**
 * Canje del enlace de acceso directo.
 *
 * El GET solo VALIDA y muestra un botón; el canje ocurre en el POST de la
 * server action. El toque extra es a propósito: los antivirus de correo y
 * los pre-fetchers corporativos abren los links de un correo antes que el
 * humano, y si consumiéramos el token en el GET, el comensal recibiría
 * "enlace vencido" sin haberlo tocado. Con el botón, el único que canjea
 * es quien realmente está ahí.
 *
 * Al canjear se abre una CustomerSession PERMANENTE: lo que vencía era el
 * enlace, no la sesión.
 */
export default async function MagicLinkPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const t = await getTranslations("customerAuth");

  const record = await db.magicLinkToken.findUnique({
    where: { tokenHash: hashMagicLinkToken(token) },
    select: {
      id: true,
      usedAt: true,
      expiresAt: true,
      user: { select: { id: true, email: true, role: true, disabledAt: true } },
    },
  });

  const usable =
    isMagicLinkUsable(record) &&
    record?.user.role === "customer" &&
    !record?.user.disabledAt;

  if (!usable || !record) {
    return (
      <main className="flex flex-1 items-center justify-center px-6 py-16 bg-bone">
        <div className="w-full max-w-sm bg-paper rounded-2xl p-7 border border-hairline text-center">
          <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-muted mb-2">
            {"MESAPAY"}
          </div>
          <h1 className="font-display text-3xl tracking-[-0.015em] mb-2">
            {t("linkInvalidTitle")}
          </h1>
          <p className="text-sm text-muted mb-6">{t("linkInvalidBody")}</p>
          <Link
            href="/cuenta/entrar"
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
    const claimed = await db.magicLinkToken.updateMany({
      where: {
        tokenHash: hashMagicLinkToken(token),
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
      data: { usedAt: new Date() },
    });
    if (claimed.count === 0) redirect("/cuenta/entrar");

    const fresh = await db.magicLinkToken.findUnique({
      where: { tokenHash: hashMagicLinkToken(token) },
      select: { user: { select: { id: true, role: true, disabledAt: true } } },
    });
    if (!fresh || fresh.user.role !== "customer" || fresh.user.disabledAt) {
      redirect("/cuenta/entrar");
    }

    const h = await headers();
    await createCustomerSession(fresh.user.id, h.get("user-agent"));
    redirect("/me");
  }

  return (
    <main className="flex flex-1 items-center justify-center px-6 py-16 bg-bone">
      <div className="w-full max-w-sm bg-paper rounded-2xl p-7 border border-hairline text-center">
        <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-muted mb-2">
          {"MESAPAY"}
        </div>
        <h1 className="font-display text-3xl tracking-[-0.015em] mb-2">
          {t("linkTitle")}
        </h1>
        <p className="text-sm text-muted mb-6">
          {t("linkBody", { email: record.user.email })}
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
