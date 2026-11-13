"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

export type BreBAdminState = {
  configured: boolean;
  merchantId: string | null;
  merchantName: string | null;
  /** "••••1a2b": nunca llega una llave entera al navegador. */
  publicKeyTail: string | null;
  privateKeyTail: string | null;
  webhookSecretTail: string | null;
  /** El medio `kushki_bre_b` está prendido para este comercio. */
  enabled: boolean;
};

type VerifyResult =
  | { ok: true; mode: string; processor: string | null; channel: string | null }
  | { ok: false; mode: string; error: string };

/**
 * Credenciales del comercio Bre-B de Kushki (plataforma). Kushki entrega para
 * Bre-B un comercio DISTINTO al de tarjeta/PSE, así que van en su propio
 * panel y por su propia ruta: guardar el formulario de arriba no las toca.
 *
 * Las llaves son de sólo escritura: se muestran los últimos 4 y, para
 * cambiarlas, se vuelven a escribir. Bre-B está en BETA en Kushki: el medio
 * nace apagado y se prende por comercio (en la ficha del comercio) cuando
 * estas llaves ya están cargadas.
 */
export function AdminBreBConfig({
  restaurantId,
  initial,
  kushkiMode,
}: {
  restaurantId: string;
  initial: BreBAdminState;
  /** Modo Kushki efectivo del comercio (mock / sandbox / production). */
  kushkiMode: string;
}) {
  const t = useTranslations("opAdminBilling");
  const router = useRouter();
  const [, startTx] = useTransition();
  const [state, setState] = useState(initial);
  const [merchantId, setMerchantId] = useState(initial.merchantId ?? "");
  const [merchantName, setMerchantName] = useState(initial.merchantName ?? "");
  const [publicKey, setPublicKey] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [busy, setBusy] = useState<"save" | "clear" | "verify" | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const url = `/api/admin/restaurants/${restaurantId}/kushki/bre-b`;

  const errorText = (code: unknown) => {
    const key = typeof code === "string" ? `breBErr_${code}` : "";
    return key && t.has(key) ? t(key) : t("breBErr_generic");
  };

  async function save() {
    setBusy("save");
    setMsg(null);
    const body: Record<string, unknown> = {
      merchantId: merchantId.trim() || null,
      merchantName: merchantName.trim() || null,
    };
    // Una llave vacía = "no la cambies". Nunca se manda la guardada de vuelta.
    if (publicKey.trim()) body.publicKey = publicKey.trim();
    if (privateKey.trim()) body.privateKey = privateKey.trim();
    if (webhookSecret.trim()) body.webhookSecret = webhookSecret.trim();
    try {
      const res = await fetch(url, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg({ kind: "error", text: errorText(j.error) });
        return;
      }
      setState(j as BreBAdminState);
      // Nada escrito se queda en el formulario después de guardar.
      setPublicKey("");
      setPrivateKey("");
      setWebhookSecret("");
      setMsg({ kind: "ok", text: t("breBSaved") });
      startTx(() => router.refresh());
    } catch {
      setMsg({ kind: "error", text: t("breBErr_generic") });
    } finally {
      setBusy(null);
    }
  }

  async function clear() {
    if (!confirm(t("breBClearConfirm"))) return;
    setBusy("clear");
    setMsg(null);
    try {
      const res = await fetch(url, { method: "DELETE" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg({ kind: "error", text: errorText(j.error) });
        return;
      }
      setState(j as BreBAdminState);
      setMerchantId("");
      setMerchantName("");
      setMsg({ kind: "ok", text: t("breBCleared") });
      startTx(() => router.refresh());
    } catch {
      setMsg({ kind: "error", text: t("breBErr_generic") });
    } finally {
      setBusy(null);
    }
  }

  async function verify() {
    setBusy("verify");
    setMsg(null);
    try {
      const res = await fetch(url, { method: "POST" });
      const j = (await res.json().catch(() => ({}))) as Partial<VerifyResult> & { error?: string };
      if (!res.ok) {
        setMsg({ kind: "error", text: errorText(j.error) });
        return;
      }
      if (j.ok && j.mode === "mock") setMsg({ kind: "ok", text: t("breBVerifyMock") });
      else if (j.ok && "processor" in j && j.processor) {
        setMsg({ kind: "ok", text: t("breBVerifyOk", { name: j.processor, channel: j.channel ?? "" }) });
      } else if (j.ok) setMsg({ kind: "error", text: t("breBVerifyNoProcessor") });
      else setMsg({ kind: "error", text: errorText(j.error) });
    } catch {
      setMsg({ kind: "error", text: t("breBErr_generic") });
    } finally {
      setBusy(null);
    }
  }

  const keep = (tail: string | null) => (tail ? t("breBKeepPlaceholder", { tail }) : t("breBEmptyPlaceholder"));

  return (
    <div className="rounded-2xl border border-op-border bg-op-surface p-5">
      <div className="flex flex-wrap items-center gap-2 mb-1">
        <div className="font-display text-lg">{t("breBTitle")}</div>
        <span className="px-2 h-6 inline-flex items-center rounded-full bg-[#C98A2E]/20 text-[#8F6828] text-[11px] font-medium">
          {t("breBBetaBadge")}
        </span>
        <span
          className={
            "px-2 h-6 inline-flex items-center rounded-full text-[11px] font-medium " +
            (state.configured ? "bg-ok/15 text-ok" : "bg-op-bg text-op-muted")
          }
        >
          {state.configured ? t("breBConfigured") : t("breBNotConfigured")}
        </span>
      </div>
      <p className="text-xs text-op-muted mb-3">{t("breBIntro")}</p>
      <div className="rounded-xl border border-[#C98A2E]/40 bg-[#C98A2E]/10 p-3 text-xs text-op-text mb-4" role="note">
        {t("breBBetaNotice")}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Field label={t("breBFieldMerchantName")} value={merchantName} onChange={setMerchantName} />
        <Field label={t("breBFieldMerchantId")} value={merchantId} onChange={setMerchantId} mono />
        <Field
          label={t("breBFieldPublicKey")}
          value={publicKey}
          onChange={setPublicKey}
          type="password"
          mono
          placeholder={keep(state.publicKeyTail)}
        />
        <Field
          label={t("breBFieldPrivateKey")}
          value={privateKey}
          onChange={setPrivateKey}
          type="password"
          mono
          placeholder={keep(state.privateKeyTail)}
        />
        <div className="md:col-span-2">
          <Field
            label={t("breBFieldWebhookSecret")}
            value={webhookSecret}
            onChange={setWebhookSecret}
            type="password"
            mono
            placeholder={keep(state.webhookSecretTail)}
          />
          <p className="mt-1 text-[11px] text-op-muted">{t("breBWebhookHint")}</p>
        </div>
      </div>

      <p className="mt-3 text-[11px] text-op-muted">
        {t("breBModeNote", { mode: kushkiMode })}{" "}
        {state.enabled ? t("breBMethodOn") : t("breBMethodOff")}
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button type="button" onClick={save} disabled={busy !== null} className="mp-btn mp-btn--primary mp-btn--sm">
          {busy === "save" ? t("saving") : t("breBSave")}
        </button>
        {state.configured && (
          <button
            type="button"
            onClick={verify}
            disabled={busy !== null}
            className="mp-btn mp-btn--secondary mp-btn--sm"
          >
            {busy === "verify" ? t("breBVerifying") : t("breBVerify")}
          </button>
        )}
        {state.configured && (
          <button
            type="button"
            onClick={clear}
            disabled={busy !== null}
            className="text-[12px] text-danger hover:underline disabled:opacity-50"
          >
            {t("breBClear")}
          </button>
        )}
        {msg && (
          <span className={"text-sm " + (msg.kind === "ok" ? "text-ok" : "text-danger")} role="status">
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
      <span className="font-mono text-[10px] tracking-wider uppercase text-op-muted">{label}</span>
      <input
        type={type ?? "text"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        className={
          "mt-1 w-full h-10 px-3 rounded-lg border border-op-border bg-op-bg text-sm focus:outline-none focus:border-terracotta " +
          (mono ? "font-mono tabular" : "")
        }
      />
    </label>
  );
}
