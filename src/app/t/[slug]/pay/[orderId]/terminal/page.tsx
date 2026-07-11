import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { TerminalWait } from "./TerminalWait";

export const dynamic = "force-dynamic";

export default async function TerminalPendingPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; orderId: string }>;
  searchParams: Promise<{ pid?: string; op?: string }>;
}) {
  const { slug, orderId } = await params;
  const { pid, op } = await searchParams;

  // Al aprobar el datáfono, a dónde ir: el comensal a su "done"; el staff a
  // la pantalla de "listo" DENTRO de su scope (mesero → PWA con bottom nav).
  let doneHref = `/t/${slug}/pay/${orderId}/done?pid=${pid ?? ""}`;
  if (op === "1") {
    const session = await auth();
    doneHref =
      session?.user?.role === "mesero"
        ? `/mesero/cobrar/${orderId}/done`
        : `/t/${slug}/pay/${orderId}/done?op=1`;
  }

  const order = await db.order.findUnique({
    where: { id: orderId },
    include: { restaurant: true, table: true },
  });
  if (!order || order.restaurant.slug !== slug) notFound();

  const payment = pid
    ? await db.payment.findUnique({ where: { id: pid } })
    : null;
  if (!payment || payment.orderId !== order.id) notFound();
  // Aceptamos ambos métodos de datáfono: el cloud-pushed de Kushki
  // (kushki_card_terminal) y el datáfono propio del comercio
  // (external_terminal). El waiting screen es el mismo en ambos —
  // sólo cambia quién settlea (Kushki webhook vs mesero manualmente
  // desde Salón).
  if (
    payment.method !== "kushki_card_terminal" &&
    payment.method !== "external_terminal"
  ) {
    notFound();
  }

  const tMenu = await getTranslations("menu");

  return (
    <TerminalWait
      tenantSlug={slug}
      tenantName={order.restaurant.name}
      locationLabel={
        order.restaurant.serviceMode === "counter"
          ? tMenu("counter")
          : tMenu("tableLabel", { number: order.table.number })
      }
      orderId={order.id}
      paymentId={payment.id}
      // payment.amountCents ya es el TOTAL (food + tip) — no hay que
      // sumar tipCents de nuevo o se duplica la propina en pantalla.
      amountCents={payment.amountCents}
      initialStatus={payment.status}
      doneHref={doneHref}
    />
  );
}
