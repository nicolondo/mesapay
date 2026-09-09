import Link from "next/link";
import { getTranslations } from "next-intl/server";

/**
 * Ingreso del comensal SIN contexto de restaurante.
 *
 * Desde que el registro es por comercio, esta pantalla no puede pedir
 * credenciales: no hay a qué cuenta entrar. Una cuenta de comensal
 * pertenece a un restaurante, y el restaurante sale del `slug` de la URL
 * (`/t/<slug>/cuenta/entrar`, que en producción es
 * `restaurante.mesapay.co/cuenta/entrar`).
 *
 * La ruta se conserva en vez de borrarse porque hay enlaces viejos, correos
 * ya enviados y marcadores que apuntan acá: es mejor explicar qué pasó y
 * mandar a escanear el QR que devolver un 404.
 */
export default async function DinerLoginWithoutTenant() {
  const t = await getTranslations("customerAuth");

  return (
    <main className="flex flex-1 items-center justify-center px-6 py-16 bg-bone">
      <div className="w-full max-w-sm bg-paper rounded-2xl p-7 border border-hairline text-center">
        <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-muted mb-2">
          {"MESAPAY"}
        </div>
        <h1 className="font-display text-3xl tracking-[-0.015em] mb-2">
          {t("noTenantTitle")}
        </h1>
        <p className="text-sm text-muted mb-6 leading-relaxed">
          {t("noTenantBody")}
        </p>
        <Link
          href="/"
          className="inline-flex items-center justify-center w-full h-11 rounded-lg bg-ink text-bone font-medium"
        >
          {t("noTenantHome")}
        </Link>
        <p className="text-xs text-muted-2 mt-5 leading-snug">
          {t("noTenantStaffHint")}{" "}
          <Link href="/signin" className="text-terracotta underline">
            {t("noTenantStaffLink")}
          </Link>
        </p>
      </div>
    </main>
  );
}
