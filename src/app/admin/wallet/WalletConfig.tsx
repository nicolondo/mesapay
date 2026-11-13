"use client";

import { useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { errorCode, fieldClass, primaryButton, secondaryButton, walletRequest, type WalletConfig as Config } from "./client";

export function WalletConfig({ config, onSaved, onCancel }: {
  config: Config; onSaved: (config: Config) => void; onCancel?: () => void;
}) {
  const t = useTranslations("platformWallet");
  const account = config.account;
  const [label, setLabel] = useState(account?.label ?? "MESAPAY");
  const [mode, setMode] = useState<"sandbox" | "production">(account?.mode ?? "sandbox");
  const [publicKey, setPublicKey] = useState(account?.publicKey ?? "");
  const [privateKey, setPrivateKey] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState("");
  const canKeepPrivate = account?.hasPrivateKey && account.publicKey === publicKey.trim() && account.mode === mode;
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError("");
    try {
      const next = await walletRequest<Config>("config", { method: "PUT", body: JSON.stringify({
        label: label.trim(), mode, publicKey: publicKey.trim(), ...(privateKey.trim() ? { privateKey: privateKey.trim() } : {}),
      }) });
      setPrivateKey(""); onSaved(next);
    } catch (e) { setError(errorCode(e)); }
    finally { busyRef.current = false; setBusy(false); }
  }
  return (
    <section className="rounded-2xl border border-op-border bg-op-surface p-5 md:p-6" aria-labelledby="wallet-config-title">
      <h2 id="wallet-config-title" className="font-display text-2xl">{t("configTitle")}</h2>
      <p className="mt-2 max-w-3xl text-sm leading-relaxed text-op-muted">{t("configHint")}</p>
      <p className="mt-2 text-sm text-op-muted">{t(config.billingConfigured ? "billingConfigured" : "billingMissing")} <Link className="text-terracotta underline underline-offset-4" href="/admin/configuracion">{t("billingLink")}</Link></p>
      <form onSubmit={save} className="mt-5 grid gap-4 sm:grid-cols-2">
        <label className="text-sm">{t("accountLabel")}<input className={fieldClass} value={label} onChange={(e) => setLabel(e.target.value)} required minLength={2} maxLength={80} disabled={busy} autoComplete="off" /></label>
        <label className="text-sm">{t("environment")}<select className={fieldClass} value={mode} onChange={(e) => setMode(e.target.value as typeof mode)} disabled={busy}><option value="sandbox">{t("mode_sandbox")}</option><option value="production">{t("mode_production")}</option></select></label>
        <label className="text-sm">{t("publicKey")}<input className={`${fieldClass} font-mono`} value={publicKey} onChange={(e) => setPublicKey(e.target.value)} required maxLength={500} disabled={busy} autoComplete="off" spellCheck={false} /></label>
        <label className="text-sm">{t("privateKey")}<input type="password" aria-label={t("privateKey")} className={`${fieldClass} font-mono`} value={privateKey} onChange={(e) => setPrivateKey(e.target.value)} required={!canKeepPrivate} maxLength={500} disabled={busy} autoComplete="new-password" placeholder={canKeepPrivate ? t("keepPrivateKey") : undefined} /><span className="mt-1 block text-xs text-op-muted">{t("privateKeyHint")}</span></label>
        {mode === "sandbox" && <p className="text-sm text-op-muted sm:col-span-2">{t("sandboxHint")}</p>}
        {error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-700 sm:col-span-2">{t(t.has(`errors.${error}`) ? `errors.${error}` : "errors.request_failed")}</p>}
        <div className="flex flex-wrap gap-2 sm:col-span-2">
          <button className={primaryButton} disabled={busy} type="submit">{t(busy ? "saving" : "saveAccount")}</button>
          {onCancel && <button type="button" className={secondaryButton} disabled={busy} onClick={onCancel}>{t("cancel")}</button>}
        </div>
      </form>
    </section>
  );
}
