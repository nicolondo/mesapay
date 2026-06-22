"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";

/**
 * Botón Apple Pay renderizado por el SDK de Kushki. Flow:
 *
 *   1. Detectamos si el browser soporta Apple Pay
 *      (ApplePaySession.canMakePayments). Safari en iOS/macOS sí,
 *      Chrome y otros no — el botón no se renderea fuera de esos.
 *
 *   2. Cargamos @kushki/js dinámicamente. Pide reflect-metadata +
 *      inversify que requieren window — no funciona en SSR.
 *
 *   3. Llamamos `initApplePayButton`. Internamente:
 *      a) valida que el dominio esté registrado en Kushki Console
 *         (GET /apple-pay/v1/validate con nuestra public key)
 *      b) inyecta un <apple-pay-button> web component dentro del
 *         div con id "kushki-apple-pay-button" (Kushki lo encuentra
 *         por ID — usamos ese exacto).
 *
 *   4. Cuando el diner toca el botón → `requestApplePayToken` abre el
 *      sheet nativo de Apple Pay → user autoriza con Face ID → SDK
 *      devuelve un token de Kushki que mandamos al backend.
 *
 *   5. Si el dominio no está validado, Kushki devuelve E020 y el SDK
 *      no renderea nada — `setReady(false)` mantiene el componente
 *      invisible para no mostrar un botón muerto.
 */
export function ApplePayButton({
  publicKey,
  kushkiMode,
  currency,
  amountCents,
  displayName,
  busy,
  onTokenized,
}: {
  publicKey: string;
  kushkiMode: "mock" | "sandbox" | "production";
  currency: "COP" | "MXN";
  amountCents: number;
  displayName: string;
  busy: boolean;
  onTokenized: (token: string) => void;
}) {
  const t = useTranslations("wait");
  const [supported, setSupported] = useState<boolean | null>(null);
  const [ready, setReady] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const kushkiRef = useRef<unknown>(null);

  // Detectar soporte Apple Pay en el browser. Solo Safari en
  // iOS/macOS expone ApplePaySession; otros browsers el componente
  // se mantiene oculto.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const win = window as unknown as {
      ApplePaySession?: { canMakePayments?: () => boolean };
    };
    const hasSession = !!win.ApplePaySession;
    const canMake = hasSession
      ? !!win.ApplePaySession?.canMakePayments?.()
      : false;
    // Log de diagnóstico — visible en DevTools del diner durante
    // setup. Removible cuando confirmemos que funciona en prod.
    console.log("[apple-pay] browser check", {
      hasApplePaySession: hasSession,
      canMakePayments: canMake,
      kushkiMode,
      hasPublicKey: !!publicKey,
    });
    setSupported(canMake);
  }, [kushkiMode, publicKey]);

  // Cargar el SDK + iniciar el botón cuando el browser sea
  // compatible y tengamos la public key del comercio.
  useEffect(() => {
    if (supported !== true || !publicKey) return;
    let alive = true;
    (async () => {
      try {
        const mod = await import("@kushki/js");
        const KushkiCtor =
          mod.Kushki ?? (mod as { default?: unknown }).default;
        if (typeof KushkiCtor !== "function") {
          throw new Error("@kushki/js no expone Kushki constructor");
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const KCtor = KushkiCtor as new (opts: {
          merchantId: string;
          inTestEnvironment: boolean;
        }) => unknown;
        const k = new KCtor({
          merchantId: publicKey,
          // Kushki SDK convention: true = UAT sandbox, false = prod.
          // Lo controla el admin desde /admin/configuracion.
          inTestEnvironment: kushkiMode !== "production",
        });
        if (!alive) return;
        kushkiRef.current = k;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (k as any).initApplePayButton(
          { style: "black", type: "pay", locale: "es-ES" },
          () => {
            // onInit — botón renderizado en el container
            console.log("[apple-pay] initApplePayButton: ready");
            if (alive) setReady(true);
          },
          () => {
            // onClick — el diner tocó Apple Pay. Disparamos el sheet.
            requestToken();
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (e: any) => {
            // E020 = Apple Pay no disponible (browser o dominio sin
            // validar contra Kushki Console); E019 = SDK no cargó.
            // Log explícito para que el operador entienda qué falta
            // chequear (lo más común: dominio no registrado en
            // Kushki Console). Cualquier error → no mostramos el botón.
            console.warn(
              "[apple-pay] init error — botón oculto. Revisar que el dominio esté validado en Kushki Console.",
              e,
            );
            if (!alive) return;
            setReady(false);
            setSupported(false);
          },
        );
      } catch (e) {
        console.error("[apple-pay] sdk load failed", e);
        if (alive) setSupported(false);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supported, publicKey, kushkiMode]);

  function requestToken() {
    if (!kushkiRef.current) return;
    setErr(null);
    // amount va en pesos enteros (43890), no en centavos. Kushki
    // arma el ApplePaySession con esto y muestra el total en el
    // sheet nativo.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (kushkiRef.current as any).requestApplePayToken(
      {
        countryCode: currency === "MXN" ? "MX" : "CO",
        currencyCode: currency,
        displayName,
        amount: Math.round(amountCents / 100),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (resp: any) => {
        if (resp && typeof resp.token === "string" && resp.token.length > 0) {
          onTokenized(resp.token);
        } else {
          console.error("[apple-pay] token error", resp);
          setErr(resp?.message ?? t("applePayError"));
        }
      },
      () => {
        // onCancel — el diner cerró el sheet. No hacemos nada.
      },
    );
  }

  // Mientras no sabemos soporte: nada. Si no hay soporte: nada.
  if (supported !== true) return null;

  return (
    <div className="w-full">
      <div
        id="kushki-apple-pay-button"
        // El SDK inyecta un <apple-pay-button> dentro. Lo estilizamos
        // para que ocupe todo el ancho — el web component soporta
        // estos CSS vars de Apple.
        style={
          {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ["--apple-pay-button-width" as any]: "100%",
            ["--apple-pay-button-height" as any]: "48px",
            ["--apple-pay-button-border-radius" as any]: "9999px",
            display: ready ? "block" : "none",
            opacity: busy ? 0.6 : 1,
            pointerEvents: busy ? "none" : "auto",
          } as React.CSSProperties
        }
      />
      {err && (
        <p className="mt-2 text-xs text-danger text-center">{err}</p>
      )}
    </div>
  );
}
