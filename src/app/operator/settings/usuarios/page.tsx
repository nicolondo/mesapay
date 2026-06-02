import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { UsuariosClient } from "./UsuariosClient";

export const dynamic = "force-dynamic";

/**
 * Gestión de usuarios staff de un restaurante. Lista todos los
 * usuarios atados a `restaurantId` (excluyendo customer y
 * platform_admin — esos no se gestionan desde acá) y los pasa al
 * cliente para crear/editar/borrar.
 */
export default async function UsuariosPage() {
  const t = await getTranslations("opSettings");
  const session = await auth();
  if (!session?.user) redirect("/signin?callbackUrl=/operator/settings/usuarios");

  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return <div className="p-6">{t("noRestaurant")}</div>;
  }

  const dbUsers = await db.user.findMany({
    where: {
      restaurantId,
      role: { in: ["operator", "mesero", "kitchen", "bar", "terminal"] },
    },
    orderBy: [{ role: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      assignedTableNumbers: true,
      createdAt: true,
    },
  });
  // El where ya garantiza que role ∈ {operator, mesero, kitchen, bar,
  // terminal}, pero el tipo de Prisma sigue incluyendo customer /
  // platform_admin. Estrechamos para el cliente.
  const users = dbUsers as Array<
    Omit<(typeof dbUsers)[number], "role"> & {
      role: "operator" | "mesero" | "kitchen" | "bar" | "terminal";
    }
  >;

  return (
    <div className="p-6 max-w-3xl mx-auto w-full">
      <Link
        href="/operator/settings"
        className="text-sm text-op-muted hover:underline"
      >
        {t("backToSettings")}
      </Link>
      <div className="font-display text-3xl mt-2 mb-1">
        {t("usuariosTitle")}
      </div>
      <p className="text-sm text-op-muted mb-6">{t("usuariosIntro")}</p>

      <UsuariosClient initialUsers={users} currentUserId={session.user.id} />
    </div>
  );
}
