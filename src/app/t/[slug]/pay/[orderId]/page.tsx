import { PayFlow } from "./PayFlow";
import { PayLinkOpenedBeacon } from "@/components/manualInvoice/PayLinkOpenedBeacon";

export default async function PayPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; orderId: string }>;
  // `tip`: propina previsualizada en el estado del pedido (?tip=<pct>).
  // `reason`: código del motivo cuando vuelve de un cobro rechazado (3DS).
  // `l=1`: llegó por el link de pago de una factura manual
  // (/r/[slug]/cuenta/[token]); la página avisa que el cliente lo abrió.
  searchParams: Promise<{ op?: string; declined?: string; tip?: string; reason?: string; l?: string }>;
}) {
  const { slug, orderId } = await params;
  const sp = await searchParams;
  return (
    <>
      {sp.l === "1" && sp.op !== "1" && <PayLinkOpenedBeacon slug={slug} orderId={orderId} />}
      <PayFlow
        slug={slug}
        orderId={orderId}
        op={sp.op}
        declined={sp.declined}
        declineCode={sp.reason}
        tip={sp.tip}
      />
    </>
  );
}
