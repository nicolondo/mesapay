"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import Link from "next/link";

export function PendingPayment({ slug, orderId, paymentId, pickup }: { pickup: boolean; slug: string; orderId: string; paymentId: string }) {
  const t = useTranslations("paymentPending");
  const router = useRouter();
  const [declined, setDeclined] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const res = await fetch(`/api/tenant/${slug}/payment/${paymentId}`, { signal: controller.signal, cache: "no-store" });
        if (res.ok) {
          const result = await res.json();
          if (result.status === "approved") { router.replace(pickup ? `/p/${slug}/${orderId}/status` : `/t/${slug}/pay/${orderId}/done?pid=${paymentId}`); return; }
          if (["declined", "refunded"].includes(result.status)) { setDeclined(true); return; }
        }
      } catch { /* A network failure never establishes a declined charge. */ }
      if (!controller.signal.aborted) timer = setTimeout(poll, 4000);
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [slug, orderId, paymentId, router, pickup]);
  return <main className="mx-auto max-w-lg px-6 py-16" aria-live="polite">
    <h1 className="font-display text-3xl">{t(declined ? "failed" : "title")}</h1>
    {!declined && <p className="mt-5 text-muted">{t("body")}</p>}
    <Link className="mt-8 inline-block underline" href={`/t/${slug}/order/${orderId}`}>{t("back")}</Link>
  </main>;
}
