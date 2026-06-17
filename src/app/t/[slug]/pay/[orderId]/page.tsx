import { PayFlow } from "./PayFlow";

export default async function PayPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; orderId: string }>;
  searchParams: Promise<{ op?: string; declined?: string }>;
}) {
  const { slug, orderId } = await params;
  const sp = await searchParams;
  return (
    <PayFlow slug={slug} orderId={orderId} op={sp.op} declined={sp.declined} />
  );
}
