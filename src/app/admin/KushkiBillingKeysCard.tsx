"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

/**
 * Card para configurar las credenciales Kushki de plataforma usadas
 * para cobrar suscripciones a los restaurantes.
 *
 * Patrones de seguridad:
 *   - La clave privada nunca regresa al cliente. El servidor sólo
 *     devuelve `hasBillingPrivateKey: boolean`.
 *   - El campo de clave privada empieza vacío. Si ya hay una clave
 *     configurada, muestra "configurada ✓". Para reemplazarla,
 *     el admin tipea la nueva — si lo deja vacío al guardar, la
 *     clave existente NO se borra (design: safe-by-default).
 *   - La clave pública sí se muestra porque es segura (va al browser
 *     del operador para tokenizar tarjetas).
 */
export function KushkiBillingKeysCard({
  initialPublicKey,
  initialHasPrivateKey,
}: {
  initialPublicKey: string | null;
  initialHasPrivateKey: boolean;
}) {
  const t = useTranslations("opAdmin");
  const router = useRouter();
  const [, startTransition] = useTransition();

  const [publicKey, setPublicKey] = useState(initialPublicKey ?? "");
  const [privateKey, setPrivateKey] = useState("");
  const [hasPrivateKey, setHasPrivateKey] = useState(initialHasPrivateKey);

  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  async function save() {
    setBusy(true);
    setMsg(null);

    const body: Record<string, string> = {};
    // Always send public key (may be empty string to clear)
    body.kushkiBillingPublicKey = publicKey.trim();
    // Only send private key if the admin typed something
    if (privateKey.length > 0) {
      body.kushkiBillingPrivateKey = privateKey;
    }

    const res = await fetch("/api/admin/platform-config", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusy(false);

    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setMsg({ kind: "error", text: (j.error as string | undefined) ?? t("saveError") });
      return;
    }

    const data = (await res.json()) as {
      kushkiBillingPublicKey: string | null;
      hasBillingPrivateKey: boolean;
    };

    setMsg({ kind: "ok", text: t("billingSaved") });
    // Update state from server response
    setPublicKey(data.kushkiBillingPublicKey ?? "");
    setHasPrivateKey(data.hasBillingPrivateKey);
    setPrivateKey(""); // never keep private key in form after save

    startTransition(() => router.refresh());
  }

  return (
    <div className="rounded-2xl border border-op-border bg-op-surface p-5">
      <div className="flex items-baseline justify-between mb-2">
        <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted">
          {t("billingTitle")}
        </div>
      </div>
      <p className="text-xs text-op-muted mb-4">{t("billingIntro")}</p>

      <div className="grid grid-cols-1 gap-3">
        {/* Public key */}
        <label className="block">
          <span className="font-mono text-[10px] tracking-wider uppercase text-op-muted">
            {t("billingPublicKeyLabel")}
          </span>
          <input
            type="text"
            value={publicKey}
            onChange={(e) => setPublicKey(e.target.value)}
            placeholder={t("billingPublicKeyPlaceholder")}
            className="mt-1 w-full h-10 px-3 rounded-lg border border-op-border bg-op-bg text-sm font-mono focus:outline-none focus:border-terracotta"
          />
          <p className="mt-1 text-[11px] text-op-muted">
            {t("billingPublicKeyHint")}
          </p>
        </label>

        {/* Private key — write-only */}
        <div>
          <label className="block">
            <span className="font-mono text-[10px] tracking-wider uppercase text-op-muted">
              {hasPrivateKey
                ? t("billingPrivateKeyLabelKeep")
                : t("billingPrivateKeyLabel")}
            </span>
            <input
              type="password"
              value={privateKey}
              onChange={(e) => setPrivateKey(e.target.value)}
              placeholder={
                hasPrivateKey
                  ? t("billingPrivateKeyPlaceholderSet")
                  : t("billingPrivateKeyPlaceholderEmpty")
              }
              className="mt-1 w-full h-10 px-3 rounded-lg border border-op-border bg-op-bg text-sm font-mono focus:outline-none focus:border-terracotta"
            />
          </label>
          <p className="mt-1 text-[11px] text-op-muted">
            {t("billingPrivateKeyHint")}
          </p>
        </div>
      </div>

      {msg && (
        <div
          className={
            "mt-3 text-sm " +
            (msg.kind === "ok" ? "text-ok" : "text-danger")
          }
        >
          {msg.text}
        </div>
      )}

      <div className="flex items-center gap-2 mt-4">
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="mp-btn mp-btn--primary mp-btn--sm px-4"
        >
          {busy ? t("saving") : t("save")}
        </button>
      </div>
    </div>
  );
}
