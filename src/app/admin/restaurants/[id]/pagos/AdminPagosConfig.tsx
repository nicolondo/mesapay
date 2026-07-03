"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

type Status =
  | "not_started"
  | "docs_uploaded"
  | "submitted"
  | "in_review"
  | "active"
  | "rejected"
  | "suspended";

// El estado mapea a su clave de traducción; la etiqueta se resuelve
// dentro del componente con t().
const STATUS_TKEYS: [Status, string][] = [
  ["not_started", "statusNotStarted"],
  ["docs_uploaded", "statusDocsUploaded"],
  ["submitted", "statusSubmitted"],
  ["in_review", "statusInReview"],
  ["active", "statusActive"],
  ["rejected", "statusRejected"],
  ["suspended", "statusSuspended"],
];

/**
 * Admin-only editor for a restaurant's payment-provider config. Reads
 * initial values from props; saves via PATCH. Private key is write-only —
 * we never echo the decrypted value back to the form, so if you want to
 * change it you have to retype it.
 */
export function AdminPagosConfig({
  restaurantId,
  initial,
}: {
  restaurantId: string;
  initial: {
    merchantId: string;
    publicKey: string;
    onboardingStatus: Status;
    notes: string;
    hasPrivateKey: boolean;
    hasWebhookSecret: boolean;
    // "" = heredar el modo global de plataforma.
    kushkiMode: string;
    // 3DS en pagos con tarjeta del comensal.
    card3ds: boolean;
  };
}) {
  const t = useTranslations("opAdminBilling");
  const statusOptions: [string, string][] = STATUS_TKEYS.map(([v, k]) => [
    v,
    t(k),
  ]);
  const router = useRouter();
  const [, startTx] = useTransition();
  const [merchantId, setMerchantId] = useState(initial.merchantId);
  const [publicKey, setPublicKey] = useState(initial.publicKey);
  const [privateKey, setPrivateKey] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [onboardingStatus, setOnboardingStatus] = useState<Status>(
    initial.onboardingStatus,
  );
  const [kushkiMode, setKushkiMode] = useState(initial.kushkiMode);
  const [card3ds, setCard3ds] = useState(initial.card3ds);
  const [notes, setNotes] = useState(initial.notes);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null,
  );

  async function save() {
    setBusy(true);
    setMsg(null);
    const body: Record<string, unknown> = {
      merchantId: merchantId.trim() || null,
      publicKey: publicKey.trim() || null,
      onboardingStatus,
      notes: notes.trim() || null,
      // "" → null = heredar el modo global de plataforma.
      kushkiMode: kushkiMode || null,
      card3ds,
    };
    // Only send privateKey if the admin typed something. An empty string
    // here means "clear the stored key"; undefined means "leave it alone".
    if (privateKey.length > 0) body.privateKey = privateKey;
    if (webhookSecret.length > 0) body.webhookSecret = webhookSecret;

    const res = await fetch(
      `/api/admin/restaurants/${restaurantId}/kushki`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setMsg({ kind: "error", text: j.error ?? t("configSaveFailed") });
      return;
    }
    setMsg({ kind: "ok", text: t("configSaved") });
    setPrivateKey(""); // never keep it in the form after save
    setWebhookSecret("");
    startTx(() => router.refresh());
  }

  async function clearWebhookSecret() {
    if (!confirm(t("clearWebhookConfirm"))) return;
    setBusy(true);
    const res = await fetch(`/api/admin/restaurants/${restaurantId}/kushki`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        merchantId: merchantId.trim() || null,
        publicKey: publicKey.trim() || null,
        webhookSecret: "",
        onboardingStatus,
        notes: notes.trim() || null,
      }),
    });
    setBusy(false);
    if (res.ok) {
      setMsg({ kind: "ok", text: t("webhookSecretCleared") });
      startTx(() => router.refresh());
    }
  }

  async function clearPrivateKey() {
    if (!confirm(t("clearPrivateKeyConfirm"))) return;
    setBusy(true);
    const res = await fetch(
      `/api/admin/restaurants/${restaurantId}/kushki`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          merchantId: merchantId.trim() || null,
          publicKey: publicKey.trim() || null,
          privateKey: "",
          onboardingStatus,
          notes: notes.trim() || null,
        }),
      },
    );
    setBusy(false);
    if (res.ok) {
      setMsg({ kind: "ok", text: t("privateKeyCleared") });
      startTx(() => router.refresh());
    }
  }

  return (
    <div className="rounded-2xl border border-op-border bg-op-surface p-5">
      <div className="font-display text-lg mb-1">{t("configTitle")}</div>
      <p className="text-xs text-op-muted mb-4">
        {t("configIntro")}
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Field label={t("fieldMerchantId")} value={merchantId} onChange={setMerchantId} />
        <Field label={t("fieldPublicKey")} value={publicKey} onChange={setPublicKey} mono />
        <div className="md:col-span-2">
          <Field
            label={
              initial.hasPrivateKey
                ? t("fieldPrivateKeyKeep")
                : t("fieldPrivateKey")
            }
            value={privateKey}
            onChange={setPrivateKey}
            type="password"
            mono
            placeholder={
              initial.hasPrivateKey
                ? t("privateKeyPlaceholderSet")
                : t("privateKeyPlaceholderEmpty")
            }
          />
          {initial.hasPrivateKey && (
            <button
              type="button"
              onClick={clearPrivateKey}
              disabled={busy}
              className="mt-1 text-[11px] text-danger hover:underline"
            >
              {t("clearPrivateKey")}
            </button>
          )}
        </div>
        <div className="md:col-span-2">
          <Field
            label={
              initial.hasWebhookSecret
                ? t("fieldWebhookSecretKeep")
                : t("fieldWebhookSecret")
            }
            value={webhookSecret}
            onChange={setWebhookSecret}
            type="password"
            mono
            placeholder={
              initial.hasWebhookSecret
                ? t("webhookSecretPlaceholderSet")
                : t("webhookSecretPlaceholderEmpty")
            }
          />
          <p className="mt-1 text-[11px] text-op-muted">
            {t("webhookSecretHint")}
          </p>
          {initial.hasWebhookSecret && (
            <button
              type="button"
              onClick={clearWebhookSecret}
              disabled={busy}
              className="mt-1 text-[11px] text-danger hover:underline"
            >
              {t("clearWebhookSecret")}
            </button>
          )}
        </div>
        <Select
          label={t("fieldOnboardingStatus")}
          value={onboardingStatus}
          options={statusOptions}
          onChange={(v) => setOnboardingStatus(v as Status)}
        />
        <div>
          <Select
            label={t("fieldKushkiMode")}
            value={kushkiMode}
            options={[
              ["", t("kushkiModeInherit")],
              ["mock", t("kushkiModeMock")],
              ["sandbox", t("kushkiModeSandbox")],
              ["production", t("kushkiModeProduction")],
            ]}
            onChange={setKushkiMode}
          />
          <p className="mt-1 text-[11px] text-op-muted">
            {t("kushkiModeHint")}
          </p>
        </div>
        <div>
          <Select
            label={t("fieldCard3ds")}
            value={card3ds ? "on" : "off"}
            options={[
              ["on", t("card3dsOn")],
              ["off", t("card3dsOff")],
            ]}
            onChange={(v) => setCard3ds(v === "on")}
          />
          <p className="mt-1 text-[11px] text-op-muted">{t("card3dsHint")}</p>
        </div>
        <div className="md:col-span-2">
          <label className="block">
            <span className="font-mono text-[10px] tracking-wider uppercase text-op-muted">
              {t("fieldInternalNotes")}
            </span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="mt-1 w-full px-3 py-2 rounded-lg border border-op-border bg-op-bg text-sm focus:outline-none focus:border-terracotta"
            />
          </label>
        </div>
      </div>
      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="h-10 px-5 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-50"
        >
          {busy ? t("saving") : t("save")}
        </button>
        {msg && (
          <span
            className={
              "text-sm " + (msg.kind === "ok" ? "text-ok" : "text-danger")
            }
          >
            {msg.text}
          </span>
        )}
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type,
  mono,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  mono?: boolean;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="font-mono text-[10px] tracking-wider uppercase text-op-muted">
        {label}
      </span>
      <input
        type={type ?? "text"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={
          "mt-1 w-full h-10 px-3 rounded-lg border border-op-border bg-op-bg text-sm focus:outline-none focus:border-terracotta " +
          (mono ? "font-mono tabular" : "")
        }
      />
    </label>
  );
}

function Select({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: [string, string][];
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <span className="font-mono text-[10px] tracking-wider uppercase text-op-muted">
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full h-10 px-3 rounded-lg border border-op-border bg-op-bg text-sm focus:outline-none focus:border-terracotta"
      >
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}
