import { notFound, redirect } from "next/navigation";
import { db } from "@/lib/db";
import { getDiner } from "@/lib/dinerSession";
import { DinerLogin } from "./DinerLogin";

export const dynamic = "force-dynamic";

/**
 * Login del COMENSAL — de ESTE comercio, y separado de /signin (el del
 * personal).
 *
 * El restaurante sale del slug de la URL: es la misma zona `/t/[slug]/*` a
 * la que el comensal llega escaneando el QR de la mesa o desde el flujo de
 * pago, y en producción es además su subdominio
 * (`restaurante.mesapay.co/cuenta/entrar`). Sin ese contexto la pantalla no
 * tiene sentido — una cuenta de comensal pertenece a un comercio — y por
 * eso `/cuenta/entrar` sin restaurante muestra una explicación, no un
 * formulario.
 *
 * Dos diferencias con /signin que justifican la página aparte:
 *   1. Acepta cédula O correo en un solo campo (el `@` decide cuál es).
 *   2. Abre una sesión permanente pero revocable (fila en DB), no el JWT
 *      de NextAuth. Ver lib/dinerSession.ts para el porqué.
 */
export default async function TenantDinerLoginPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const tenant = await db.restaurant.findUnique({
    where: { slug },
    select: { id: true, name: true },
  });
  if (!tenant) return notFound();

  // Ya tiene sesión en ESTE comercio: no hay nada que hacer acá.
  const diner = await getDiner(tenant.id);
  if (diner) redirect(`/t/${slug}/cuenta`);

  return <DinerLogin slug={slug} restaurantName={tenant.name} />;
}
