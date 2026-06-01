"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";

/**
 * Lee los query params que dejó Kushki después del challenge bancario
 * y completa el cobro:
 *
 *   ?success=true&token=<validated-token>   → POST charge
 *   ?success=false&message=...&token=...    → redirect a checkout con flag
 *
 * El amount/tip del diner los recuperamos de localStorage (set por el
 * CardSheet justo antes del redirect al banco). Si por algún motivo
 * está vacío, mostramos error y mandamos al checkout para reintentar.
 *
 * Key del localStorage: `mesapay:3ds:<orderId>` (scoped por orden
 * para no pisar pagos paralelos del mismo browser).
 */
export function ThreeDsReturnClient({
  tenantSlug,
  orderId,
}: {
  tenantSlug: string;
  orderId: string;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const t = useTranslations("wait");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const success = params.get("success");
    const token = params.get("token");
    const message = params.get("message");

    // El banco rechazó el OTP / el user canceló / no se autenticó.
    if (success === "false" || !token) {
      router.replace(
        `/t/${tenantSlug}/pay/${orderId}?declined=1${message ? `&reason=${encodeURIComponent(message)}` : ""}`,
      );
      return;
    }

    // success=true sin token tampoco sirve para cobrar.
    if (!token || token.trim().length === 0) {
      router.replace(`/t/${tenantSlug}/pay/${orderId}?declined=1`);
      return;
    }

    // Recuperamos lo que el CardSheet stasheó antes del redirect.
    const key = `mesapay:3ds:${orderId}`;
    let amountCents = 0;
    let tipCents = 0;
    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        const parsed = JSON.parse(raw) as {
          amountCents?: number;
          tipCents?: number;
        };
        amountCents = Number(parsed.amountCents) || 0;
        tipCents = Number(parsed.tipCents) || 0;
      }
    } catch (e) {
      console.error("[3ds-return] localStorage read failed", e);
    }
    if (amountCents <= 0) {
      setError(t("tdsErrNoAmount"));
      // Damos un segundo al user para leer y luego mandamos a checkout.
      const timer = setTimeout(() => {
        router.replace(`/t/${tenantSlug}/pay/${orderId}?declined=1`);
      }, 2500);
      return () => clearTimeout(timer);
    }

    // Limpiamos el stash inmediatamente — un retry del browser no
    // debería disparar un segundo charge con el mismo token.
    try {
      localStorage.removeItem(key);
    } catch {}

    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/tenant/${tenantSlug}/pay/kushki-charge`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              orderId,
              method: "kushki_card",
              token,
              amountCents,
              tipCents,
            }),
          },
        );
        if (cancelled) return;
        const j = await res.json().catch(() => ({}));
        if (!res.ok) {
          router.replace(
            `/t/${tenantSlug}/pay/${orderId}?declined=1${j.message ? `&reason=${encodeURIComponent(j.message)}` : ""}`,
          );
          return;
        }
        if (j.approved && j.paymentId) {
          router.replace(
            `/t/${tenantSlug}/pay/${orderId}/done?pid=${j.paymentId}`,
          );
        } else {
          router.replace(
            `/t/${tenantSlug}/pay/${orderId}?declined=1${j.message ? `&reason=${encodeURIComponent(j.message)}` : ""}`,
          );
        }
      } catch (e) {
        if (cancelled) return;
        console.error("[3ds-return] charge failed", e);
        setError(t("tdsErrCharge"));
        const timer = setTimeout(() => {
          router.replace(`/t/${tenantSlug}/pay/${orderId}?declined=1`);
        }, 2500);
        return () => clearTimeout(timer);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [params, router, tenantSlug, orderId]);

  return (
    <main className="min-h-dvh flex items-center justify-center px-6">
      <div className="text-center max-w-sm">
        <div className="mx-auto w-12 h-12 rounded-full bg-ink/10 flex items-center justify-center mb-4">
          <span
            aria-hidden
            className="block w-5 h-5 rounded-full border-2 border-ink border-t-transparent animate-spin"
          />
        </div>
        <div className="font-display text-xl">
          {error ? t("tdsError") : t("tdsVerifying")}
        </div>
        <p className="text-sm text-muted mt-2">
          {error ?? t("tdsConfirming")}
        </p>
      </div>
    </main>
  );
}
