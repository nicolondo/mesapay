import Link from "next/link";

export default async function PayDone({
  params,
}: {
  params: Promise<{ slug: string; orderId: string }>;
}) {
  const { slug } = await params;
  return (
    <main className="flex flex-1 items-center justify-center px-6 py-16 bg-bone">
      <div className="text-center max-w-sm">
        <div className="w-14 h-14 rounded-full bg-ok/20 text-ok mx-auto flex items-center justify-center font-display text-3xl check-pop">
          ✓
        </div>
        <h1 className="font-display text-4xl tracking-[-0.015em] mt-5">
          ¡Pago recibido!
        </h1>
        <p className="text-muted mt-3">
          Gracias por visitarnos. Esperamos verte pronto.
        </p>
        <Link
          href={`/t/${slug}`}
          className="mt-8 inline-flex h-11 px-5 rounded-full bg-ink text-bone font-medium items-center"
        >
          Volver al inicio
        </Link>
      </div>
    </main>
  );
}
