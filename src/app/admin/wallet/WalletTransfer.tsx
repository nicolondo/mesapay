"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useLocale, useTranslations } from "next-intl";
import { MoneyInput } from "@/components/MoneyInput";
import { formatMoney } from "@/lib/format";
import type { Locale } from "@/i18n/config";
import { errorCode, fieldClass, primaryButton, secondaryButton, walletRequest, type Payout, type PayoutInput, type WalletAccount, type WalletBalance, type WalletBank } from "./client";

const STORAGE_KEY = "mesapay:platform-wallet:pending";
type Pending = { key: string; accountId: string };
const emptyDestination: PayoutInput["destination"] = { bankId: "", accountType: "ahorros", accountNumber: "", docType: "NIT", docNumber: "", holderName: "" };

export function WalletTransfer({ account, balance, banks, banksError, reloadBanks, onPayout, blocked, payouts }: {
  account: WalletAccount; balance: WalletBalance | null; banks: WalletBank[];
  banksError: string; reloadBanks: () => void; onPayout: (payout: Payout) => void; blocked: boolean; payouts: Payout[];
}) {
  const t = useTranslations("platformWallet");
  const locale = useLocale() as Locale;
  const [amount, setAmount] = useState("");
  const [destination, setDestination] = useState(emptyDestination);
  const [description, setDescription] = useState("");
  const [review, setReview] = useState<PayoutInput | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [recoveryReady, setRecoveryReady] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const [error, setError] = useState("");
  const [lastResult, setResult] = useState<Payout | null>(null);
  // The history owns the latest provider status. Keep only a fallback for the
  // first render after submission, so later reconciliation updates this banner.
  const result = payouts.find((payout) => payout.id === lastResult?.id) ?? lastResult;
  const money = (cents: number) => formatMoney(cents, { currency: "COP", locale });

  const clearPending = useCallback(() => {
    setPending(null);
    try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* Memory state remains sufficient for this page. */ }
  }, []);
  const acceptPayout = useCallback((payout: Payout) => {
    clearPending(); setReview(null); setResult(payout); setAmount(""); setDescription(""); setDestination(emptyDestination); setError("");
    onPayout(payout);
  }, [clearPending, onPayout]);
  // This storage only retains an opaque operation key. Never store bank details or credentials.
  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
    if (!active) return;
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (raw) {
        const value = JSON.parse(raw) as Pending;
        if (typeof value.key === "string" && /^[0-9a-f-]{36}$/i.test(value.key) && typeof value.accountId === "string") setPending(value);
      }
    } catch { /* Storage can be unavailable; the server still enforces idempotency. */ }
    setRecoveryReady(true);
    });
    return () => { active = false; };
  }, []);

  const pendingKey = pending?.key;
  useEffect(() => {
    if (!pendingKey) return;
    let active = true;
    walletRequest<{ payouts: Payout[] }>(`payouts?idempotencyKey=${encodeURIComponent(pendingKey)}`)
      .then((value) => { if (active && value.payouts[0]) acceptPayout(value.payouts[0]); })
      .catch((error) => { if (active) setError(errorCode(error)); });
    return () => { active = false; };
  }, [pendingKey, acceptPayout]);

  async function recover() {
    if (!pending || recovering || sending.current) return;
    setRecovering(true); setError("");
    try {
      const found = await walletRequest<{ payouts: Payout[] }>(`payouts?idempotencyKey=${encodeURIComponent(pending.key)}`);
      if (found.payouts[0]) acceptPayout(found.payouts[0]);
      else setError("payout_not_visible");
    } catch (e) { setError(errorCode(e)); }
    finally { setRecovering(false); }
  }
  function prepare(event: FormEvent) {
    event.preventDefault(); setError("");
    if (sending.current || !recoveryReady || (blocked && !pending)) return;
    const amountCents = Number(amount) * 100;
    if (!Number.isSafeInteger(amountCents) || amountCents < 100000 || amountCents > 1390000000000) { setError("invalid_amount"); return; }
    if (balance?.accountId !== account.id || amountCents > balance.availableCents) { setError(balance ? "insufficient_funds" : "balance_failed"); return; }
    const key = pending?.key ?? crypto.randomUUID();
    setReview({ accountId: account.id, idempotencyKey: key, amountCents, confirmed: true,
      destination: { ...destination, accountNumber: destination.accountNumber.trim(), docNumber: destination.docNumber.trim(), holderName: destination.holderName.trim() }, description: description.trim() });
  }
  async function send() {
    if (!review || sending.current || review.accountId !== account.id) return;
    sending.current = true; setBusy(true); setError("");
    const attempt = { key: review.idempotencyKey, accountId: review.accountId };
    setPending(attempt);
    try {
      // Persistence must succeed before starting a transfer, so reload never loses its identity.
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(attempt));
    } catch {
      sending.current = false; setBusy(false); setPending(null); setError("storage_unavailable"); return;
    }
    try {
      const response = await walletRequest<{ payout: Payout }>("payouts", { method: "POST", body: JSON.stringify(review) });
      acceptPayout(response.payout);
    } catch (e) {
      const code = errorCode(e);
      setError(code);
      // A structured preflight rejection is editable, but keeps the original
      // operation key. A lost response keeps the exact confirmed payload.
      if (["invalid_payload", "invalid_bank", "insufficient_funds", "account_changed", "private_key_required", "wallet_not_configured", "credentials_unavailable"].includes(code)) setReview(null);
      // No new key or automatic retry: the server may already have sent the payment.
    } finally { sending.current = false; setBusy(false); }
  }
  const formDisabled = busy || recovering || !recoveryReady || Boolean(blocked && !pending);
  const selectedBank = banks.find((bank) => bank.id === (review?.destination.bankId ?? destination.bankId));
  return <section className="rounded-2xl border border-op-border bg-op-surface p-5 md:p-6" aria-labelledby="wallet-transfer-title">
    <h2 id="wallet-transfer-title" className="font-display text-2xl">{t("transferTitle")}</h2>
    <p className="mt-2 text-sm leading-relaxed text-op-muted">{t("transferHint")}</p>
    {blocked && !pending && <p role="status" className="mt-4 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">{t("errors.payout_in_progress")}</p>}
    {result && <div role="status" className="mt-4 rounded-xl border border-op-border bg-op-bg p-4"><p className="font-medium">{t(`status_${result.status}`)} · {money(result.amountCents)}</p><p className="mt-1 text-sm">{t(result.status === "unknown" ? "unknownHint" : "recordedHint")}</p></div>}
    {pending && <div role="status" className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"><p>{t("pendingHint")}</p><button type="button" className={`${secondaryButton} mt-3`} onClick={recover} disabled={busy || recovering}>{t(recovering ? "checking" : "recoverAttempt")}</button>{!review && <p className="mt-2 text-xs">{t("recoverSameKeyHint")}</p>}</div>}
    {error && <p role="alert" className="mt-4 rounded-xl bg-red-50 p-3 text-sm text-red-700">{t(t.has(`errors.${error}`) ? `errors.${error}` : "errors.request_failed")}</p>}
    {review ? <div className="mt-5 space-y-4" aria-labelledby="wallet-review-title">
      <h3 id="wallet-review-title" className="font-medium">{t("reviewTitle")}</h3>
      <dl className="grid gap-3 rounded-xl bg-op-bg p-4 text-sm sm:grid-cols-2">
        <div><dt className="text-op-muted">{t("amount")}</dt><dd className="mt-1 text-2xl font-mono">{money(review.amountCents)}</dd></div>
        <div><dt className="text-op-muted">{t("sourceAccount")}</dt><dd className="mt-1 break-words">{account.label} · {t(`mode_${account.mode}`)}</dd></div>
        <div><dt className="text-op-muted">{t("holderName")}</dt><dd className="mt-1 break-words">{review.destination.holderName}</dd></div>
        <div><dt className="text-op-muted">{t("destinationAccount")}</dt><dd className="mt-1 break-all">{selectedBank?.name} · {t(`account_${review.destination.accountType}`)} · {review.destination.accountNumber}</dd></div>
        <div><dt className="text-op-muted">{t("docNumber")}</dt><dd className="mt-1 break-all">{review.destination.docType} · {review.destination.docNumber}</dd></div>
        {review.description && <div><dt className="text-op-muted">{t("description")}</dt><dd className="mt-1 break-words">{review.description}</dd></div>}
      </dl>
      <p className="text-sm text-op-muted">{t(account.mode === "sandbox" ? "sandboxConfirm" : "productionConfirm")}</p>
      <div className="flex flex-wrap gap-2"><button type="button" className={primaryButton} onClick={send} disabled={busy || recovering}>{t(busy ? "sending" : pending ? "retrySameAttempt" : "confirmTransfer")}</button><button type="button" className={secondaryButton} onClick={() => setReview(null)} disabled={busy || Boolean(pending)}>{t("editDetails")}</button></div>
    </div> : <form onSubmit={prepare} className="mt-5 grid gap-4 sm:grid-cols-2">
      <label className="text-sm">{t("amount")}<MoneyInput ariaLabel={t("amount")} className={`${fieldClass} font-mono`} value={amount} onChange={setAmount} required disabled={formDisabled} aria-describedby="wallet-amount-hint" /><span id="wallet-amount-hint" className="mt-1 block text-xs text-op-muted">{t("amountHint", { minimum: money(100000) })}</span></label>
      <label className="text-sm">{t("bank")}<select className={fieldClass} value={destination.bankId} onChange={(e) => setDestination({ ...destination, bankId: e.target.value })} required disabled={formDisabled || banks.length === 0}><option value="">{t("selectBank")}</option>{banks.map((bank) => <option key={bank.id} value={bank.id}>{bank.name}</option>)}</select></label>
      {banksError && <div className="text-sm sm:col-span-2"><p role="alert" className="text-red-700">{t("errors.banks_failed")}</p><button type="button" className={`${secondaryButton} mt-2`} onClick={reloadBanks}>{t("retry")}</button></div>}
      <label className="text-sm">{t("accountType")}<select className={fieldClass} value={destination.accountType} onChange={(e) => setDestination({ ...destination, accountType: e.target.value as "ahorros" | "corriente" })} disabled={formDisabled}><option value="ahorros">{t("account_ahorros")}</option><option value="corriente">{t("account_corriente")}</option></select></label>
      <label className="text-sm">{t("accountNumber")}<input className={fieldClass} value={destination.accountNumber} onChange={(e) => setDestination({ ...destination, accountNumber: e.target.value })} inputMode="numeric" autoComplete="off" pattern="[0-9]{4,34}" required disabled={formDisabled} /></label>
      <label className="text-sm">{t("docType")}<select className={fieldClass} value={destination.docType} onChange={(e) => setDestination({ ...destination, docType: e.target.value as PayoutInput["destination"]["docType"] })} disabled={formDisabled}>{(["CC", "CE", "NIT", "PA"] as const).map((type) => <option key={type} value={type}>{t(`doc_${type}`)}</option>)}</select></label>
      <label className="text-sm">{t("docNumber")}<input className={fieldClass} value={destination.docNumber} onChange={(e) => setDestination({ ...destination, docNumber: e.target.value })} autoComplete="off" pattern="[A-Za-z0-9\-]{4,20}" required minLength={4} maxLength={20} disabled={formDisabled} /></label>
      <label className="text-sm sm:col-span-2">{t("holderName")}<input className={fieldClass} value={destination.holderName} onChange={(e) => setDestination({ ...destination, holderName: e.target.value })} autoComplete="off" required minLength={3} maxLength={120} disabled={formDisabled} /></label>
      <label className="text-sm sm:col-span-2">{t("description")}<input className={fieldClass} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={200} disabled={formDisabled} /></label>
      <div className="sm:col-span-2"><button type="submit" className={primaryButton} disabled={formDisabled || !balance || banks.length === 0}>{t("reviewTransfer")}</button></div>
    </form>}
  </section>;
}
