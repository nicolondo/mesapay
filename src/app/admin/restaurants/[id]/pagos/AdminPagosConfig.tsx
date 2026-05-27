"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type Status =
  | "not_started"
  | "docs_uploaded"
  | "submitted"
  | "in_review"
  | "active"
  | "rejected"
  | "suspended";

const STATUS_OPTIONS: [Status, string][] = [
  ["not_started", "No iniciado"],
  ["docs_uploaded", "Documentos cargados"],
  ["submitted", "Enviado"],
  ["in_review", "En revisión"],
  ["active", "Activo"],
  ["rejected", "Rechazado"],
  ["suspended", "Suspendido"],
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
  };
}) {
  const router = useRouter();
  const [, startTx] = useTransition();
  const [merchantId, setMerchantId] = useState(initial.merchantId);
  const [publicKey, setPublicKey] = useState(initial.publicKey);
  const [privateKey, setPrivateKey] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [onboardingStatus, setOnboardingStatus] = useState<Status>(
    initial.onboardingStatus,
  );
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
      setMsg({ kind: "error", text: j.error ?? "No pudimos guardar." });
      return;
    }
    setMsg({ kind: "ok", text: "Guardado." });
    setPrivateKey(""); // never keep it in the form after save
    setWebhookSecret("");
    startTx(() => router.refresh());
  }

  async function clearWebhookSecret() {
    if (
      !confirm(
        "¿Borrar el webhook signing secret? Los webhooks de este comercio van a usar el secret global del partner.",
      )
    )
      return;
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
      setMsg({ kind: "ok", text: "Webhook secret borrado." });
      startTx(() => router.refresh());
    }
  }

  async function clearPrivateKey() {
    if (!confirm("¿Borrar la llave privada almacenada? El comercio no podrá cobrar hasta que se vuelva a configurar."))
      return;
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
      setMsg({ kind: "ok", text: "Llave privada borrada." });
      startTx(() => router.refresh());
    }
  }

  return (
    <div className="rounded-2xl border border-op-border bg-op-surface p-5">
      <div className="font-display text-lg mb-1">Editar configuración</div>
      <p className="text-xs text-op-muted mb-4">
        Override manual. Lo que pongas aquí sobrescribe lo que reportó el flujo
        automático del comercio.
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Field label="Merchant ID" value={merchantId} onChange={setMerchantId} />
        <Field label="Public key" value={publicKey} onChange={setPublicKey} mono />
        <div className="md:col-span-2">
          <Field
            label={
              initial.hasPrivateKey
                ? "Private key (deja vacío para no cambiar)"
                : "Private key"
            }
            value={privateKey}
            onChange={setPrivateKey}
            type="password"
            mono
            placeholder={initial.hasPrivateKey ? "•••••••• (cifrada en DB)" : "—"}
          />
          {initial.hasPrivateKey && (
            <button
              type="button"
              onClick={clearPrivateKey}
              disabled={busy}
              className="mt-1 text-[11px] text-danger hover:underline"
            >
              Borrar llave privada
            </button>
          )}
        </div>
        <div className="md:col-span-2">
          <Field
            label={
              initial.hasWebhookSecret
                ? "Webhook signing secret (deja vacío para no cambiar)"
                : "Webhook signing secret"
            }
            value={webhookSecret}
            onChange={setWebhookSecret}
            type="password"
            mono
            placeholder={
              initial.hasWebhookSecret
                ? "•••••••• (cifrado en DB)"
                : "Si está vacío, se usa el secret global del partner"
            }
          />
          <p className="mt-1 text-[11px] text-op-muted">
            HMAC-SHA256. Lo configurás en el dashboard del comercio en
            Kushki. Si lo dejás vacío, MESAPAY verifica los webhooks con
            el secret global del partner (variable de entorno).
          </p>
          {initial.hasWebhookSecret && (
            <button
              type="button"
              onClick={clearWebhookSecret}
              disabled={busy}
              className="mt-1 text-[11px] text-danger hover:underline"
            >
              Borrar webhook secret
            </button>
          )}
        </div>
        <Select
          label="Estado de onboarding"
          value={onboardingStatus}
          options={STATUS_OPTIONS as [string, string][]}
          onChange={(v) => setOnboardingStatus(v as Status)}
        />
        <div className="md:col-span-2">
          <label className="block">
            <span className="font-mono text-[10px] tracking-wider uppercase text-op-muted">
              Notas internas
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
          {busy ? "Guardando…" : "Guardar"}
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
