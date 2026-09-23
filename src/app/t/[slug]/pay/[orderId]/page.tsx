import { PayFlow } from "./PayFlow";

export default async function PayPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; orderId: string }>;
  // `tip`: propina previsualizada en el estado del pedido (?tip=<pct>).
  searchParams: Promise<{ op?: string; declined?: string; tip?: string }>;
}) {
  const { slug, orderId } = await params;
  const sp = await searchParams;
  return (
    <PayFlow
      slug={slug}
      orderId={orderId}
      op={sp.op}
      declined={sp.declined}
      tip={sp.tip}
    />
  );
}
