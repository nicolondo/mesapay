"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";

// KushkiMode importado como string-type desde platformConfig rompería el
// bundle del cliente (el módulo importa Prisma). Redefinimos localmente.
type KushkiMode = "mock" | "sandbox" | "production";

type Props = {
  kushkiPublicKey: string | null;
  kushkiMode: KushkiMode;
  currency: "COP" | "MXN";
  busy?: boolean;
  onToken: (token: string) => void;
  onCancel: () => void;
};

export function CardForm({ kushkiPublicKey, kushkiMode, currency, busy, onToken, onCancel }: Props) {
  const t = useTranslations("opSubscription");
  const [number, setNumber] = useState("");
  const [holderName, setHolderName] = useState("");
  const [expiry, setExpiry] = useState("");
  const [cvv, setCvv] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [tokenizing, setTokenizing] = useState(false);

  // Formateo del número de tarjeta: grupos de 4 con espacios
  function handleNumber(raw: string) {
    const digits = raw.replace(/\D/g, "").slice(0, 19);
    const grouped = digits.replace(/(.{4})/g, "$1 ").trimEnd();
    setNumber(grouped);
  }

  // Formateo MM/AA
  function handleExpiry(raw: string) {
    const digits = raw.replace(/\D/g, "").slice(0, 4);
    if (digits.length >= 3) {
      setExpiry(digits.slice(0, 2) + "/" + digits.slice(2));
    } else {
      setExpiry(digits);
    }
  }

  async function submit() {
    setErr(null);
    const digits = number.replace(/\s/g, "");
    if (digits.length < 13 || digits.length > 19) {
      setErr(t("errCardNumber"));
      return;
    }
    if (!holderName.trim() || holderName.trim().length < 3) {
      setErr(t("errCardName"));
      return;
    }
    const expiryMatch = /^(\d{2})\/(\d{2})$/.exec(expiry);
    if (!expiryMatch) {
      setErr(t("errExpiry"));
      return;
    }
    const expMonth = expiryMatch[1];
    const expYear = expiryMatch[2];
    if (Number(expMonth) < 1 || Number(expMonth) > 12) {
      setErr(t("errExpiryMonth"));
      return;
    }
    if (!cvv.match(/^\d{3,4}$/)) {
      setErr(t("errCvv"));
      return;
    }

    // Mock path: no llamada a Kushki — el mock provider acepta cualquier token.
    if (kushkiMode === "mock" || !kushkiPublicKey) {
      onToken(`mock-sub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
      return;
    }

    setTokenizing(true);
    try {
      const baseUrl =
        kushkiMode === "production"
          ? "https://api.kushkipagos.com"
          : "https://api-uat.kushkipagos.com";

      // El token DEBE llevar `currency` (igual que el cobro de comensales en
      // card/v1/tokens): si no, Kushki crea el token con una moneda por
      // defecto y al crear la suscripción en COP la rechaza con K055
      // ("Tipo de moneda no permitido").
      const body = {
        card: {
          number: digits,
          name: holderName.trim(),
          expiryMonth: expMonth,
          expiryYear: expYear,
          cvv,
        },
        currency,
      };

      console.log("[billing] CardForm: tokenize shape", {
        cardLast4: digits.slice(-4),
        expiryMonth: expMonth,
        expiryYear: expYear,
        currency,
        endpoint: "subscriptions/v1/card/tokens",
      });

      // VERIFY vs sandbox: el endpoint de token para suscripciones puede ser
      // /subscriptions/v1/card/tokens o el mismo /card/v1/tokens que usan pagos.
      // Intentamos el de suscripciones primero; si da 404, cae al de pagos.
      let res = await fetch(`${baseUrl}/subscriptions/v1/card/tokens`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Public-Merchant-Id": kushkiPublicKey,
        },
        body: JSON.stringify(body),
      });

      // Si 404 → intentar el endpoint genérico de tarjetas
      if (res.status === 404) {
        console.log("[billing] CardForm: subscriptions/v1/card/tokens gave 404, falling back to card/v1/tokens");
        // VERIFY vs sandbox: fallback al endpoint de tokenización de tarjetas normal
        res = await fetch(`${baseUrl}/card/v1/tokens`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Public-Merchant-Id": kushkiPublicKey,
          },
          body: JSON.stringify({ ...body, totalAmount: 0, isDeferred: false }),
        });
      }

      const json = await res.json().catch(() => ({})) as { token?: string; code?: string; message?: string };
      console.log("[billing] CardForm: token response", {
        status: res.status,
        hasToken: !!json.token,
        code: json.code,
      });

      if (!res.ok || json.code || !json.token) {
        setErr(json.message ?? t("errTokenize"));
        return;
      }

      onToken(json.token);
    } catch (e) {
      console.error("[billing] CardForm: tokenize error", e);
      setErr(t("errTokenize"));
    } finally {
      setTokenizing(false);
    }
  }

  const isBusy = busy || tokenizing;

  return (
    <div className="space-y-4">
      <div className="font-medium text-sm text-op-text">{t("cardFormTitle")}</div>

      <div className="space-y-3">
        <div>
          <label className="block text-xs text-op-muted mb-1">{t("cardNumber")}</label>
          <input
            type="text"
            inputMode="numeric"
            value={number}
            onChange={(e) => handleNumber(e.target.value)}
            placeholder="1234 5678 9012 3456"
            maxLength={23}
            disabled={isBusy}
            className="w-full border border-op-border rounded-lg px-3 py-2 text-sm font-mono bg-op-surface text-op-text placeholder:text-op-muted/50 focus:outline-none focus:ring-2 focus:ring-terracotta/40 disabled:opacity-50"
          />
        </div>

        <div>
          <label className="block text-xs text-op-muted mb-1">{t("cardName")}</label>
          <input
            type="text"
            value={holderName}
            onChange={(e) => setHolderName(e.target.value)}
            placeholder="JUAN PEREZ"
            maxLength={80}
            disabled={isBusy}
            className="w-full border border-op-border rounded-lg px-3 py-2 text-sm uppercase bg-op-surface text-op-text placeholder:text-op-muted/50 focus:outline-none focus:ring-2 focus:ring-terracotta/40 disabled:opacity-50"
          />
        </div>

        <div className="flex gap-3">
          <div className="flex-1">
            <label className="block text-xs text-op-muted mb-1">{t("cardExpiry")}</label>
            <input
              type="text"
              inputMode="numeric"
              value={expiry}
              onChange={(e) => handleExpiry(e.target.value)}
              placeholder="MM/AA"
              maxLength={5}
              disabled={isBusy}
              className="w-full border border-op-border rounded-lg px-3 py-2 text-sm font-mono bg-op-surface text-op-text placeholder:text-op-muted/50 focus:outline-none focus:ring-2 focus:ring-terracotta/40 disabled:opacity-50"
            />
          </div>
          <div className="w-28">
            <label className="block text-xs text-op-muted mb-1">{t("cardCvv")}</label>
            <input
              type="text"
              inputMode="numeric"
              value={cvv}
              onChange={(e) => setCvv(e.target.value.replace(/\D/g, "").slice(0, 4))}
              placeholder="123"
              maxLength={4}
              disabled={isBusy}
              className="w-full border border-op-border rounded-lg px-3 py-2 text-sm font-mono bg-op-surface text-op-text placeholder:text-op-muted/50 focus:outline-none focus:ring-2 focus:ring-terracotta/40 disabled:opacity-50"
            />
          </div>
        </div>
      </div>

      {err && (
        <div className="text-sm text-danger bg-danger/10 rounded-lg px-3 py-2">{err}</div>
      )}

      <div className="flex gap-2 pt-1">
        <button
          type="button"
          onClick={submit}
          disabled={isBusy}
          className="flex-1 bg-ink text-bone rounded-lg px-4 py-2.5 text-sm font-medium hover:bg-ink/90 disabled:opacity-50 transition-colors"
        >
          {isBusy ? "…" : t("cardSubmit")}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={isBusy}
          className="px-4 py-2.5 text-sm font-medium text-op-muted hover:text-op-text rounded-lg border border-op-border hover:bg-op-surface transition-colors disabled:opacity-50"
        >
          {t("cardCancel")}
        </button>
      </div>
    </div>
  );
}
