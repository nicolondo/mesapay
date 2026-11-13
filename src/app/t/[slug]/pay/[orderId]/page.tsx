import { PayFlow } from "./PayFlow";

export default async function PayPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; orderId: string }>;
  // `tip`: propina previsualizada en el estado del pedido (?tip=<pct>).
  // `reason`: código del motivo cuando vuelve de un cobro rechazado (3DS).
  searchParams: Promise<{ op?: string; declined?: string; tip?: string; reason?: string }>;
}) {
  const { slug, orderId } = await params;
  const sp = await searchParams;
  return (
    <PayFlow
      slug={slug}
      orderId={orderId}
      op={sp.op}
      declined={sp.declined}
      declineCode={sp.reason}
      tip={sp.tip}
    />
  );
}
