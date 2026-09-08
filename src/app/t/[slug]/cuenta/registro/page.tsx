import { notFound, redirect } from "next/navigation";
import { db } from "@/lib/db";
import { getDiner } from "@/lib/dinerSession";
import { DinerSignup } from "./DinerSignup";

export const dynamic = "force-dynamic";

/**
 * Alta de cuenta del comensal EN ESTE COMERCIO.
 *
 * El restaurante sale del slug de la URL — la cuenta que se crea es de él.
 * Que la misma persona tenga que registrarse otra vez en el restaurante de
 * al lado es la consecuencia asumida de la decisión de producto: cada
 * comercio con su propia base de comensales.
 */
export default async function TenantDinerSignupPage({
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

  const diner = await getDiner(tenant.id);
  if (diner) redirect(`/t/${slug}/cuenta`);

  return <DinerSignup slug={slug} restaurantName={tenant.name} />;
}
