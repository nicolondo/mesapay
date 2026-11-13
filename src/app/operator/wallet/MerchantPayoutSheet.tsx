"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useLocale, useTranslations } from "next-intl";
import { AppDialog } from "@/components/ui/AppDialog";
import { MoneyInput } from "@/components/MoneyInput";
import { parseTrackingAmount } from "@/components/walletTracking/client";
import { formatMoney } from "@/lib/format";
import type { Locale } from "@/i18n/config";
import type { MerchantPayoutController, MerchantPayoutInput } from "./useMerchantPayout";

const field = "mt-1 min-h-11 w-full min-w-0 rounded-xl border border-op-border bg-op-bg px-3 py-2 text-sm";
const button = "min-h-11 rounded-full border border-op-border px-4 py-2 text-sm disabled:opacity-50";
export function MerchantPayoutNotice({ payout }: { payout: MerchantPayoutController }) {
  const t = useTranslations("opWallet");
  const tp = useTranslations("platformWallet");
  if (!payout.pending && !payout.result && !payout.error) return null;
  const error = payout.error ?? payout.result?.responseText;
  return <div role="status" className="mb-6 space-y-3 rounded-xl border border-op-border bg-op-surface p-4 text-sm">
    {payout.result && <p className="font-medium">{t(({ submitting: "payoutSubmitting", initialized: "payoutInitialized", approved: "payoutApproved", declined: "payoutDeclined", unknown: "payoutUnknown", failed: "payoutFailed" } as const)[payout.result.status])}</p>}
    {payout.pending && <p>{t(payout.canRebuild ? "payoutRebuildHint" : "payoutUncertainHint")}</p>}
    {payout.result?.status === "initialized" && <p>{t("transferInitiated")}</p>}
    {error && <p className="text-amber-900">{t.has("payoutErrors." + error) ? t("payoutErrors." + error) : tp.has("errors." + error) ? tp("errors." + error) : t("disperseError")}</p>}
    {(payout.pending || payout.result?.status === "initialized") && <div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={payout.busy} onClick={() => void payout.recover(payout.result?.idempotencyKey)}>{t(payout.busy ? "processing" : "payoutCheck")}</button>{payout.canRetry && <button type="button" className={button} disabled={payout.busy} onClick={() => void payout.retry()}>{t("payoutRetrySame")}</button>}</div>}
  </div>;
}
export function MerchantPayoutSheet({ payout, maxCents, currency, bankLabel, ownDestinationFingerprint, onClose }: { payout: MerchantPayoutController; maxCents: number; currency: string; bankLabel?: string; ownDestinationFingerprint?: string | null; onClose: () => void }) {
  const t = useTranslations("opWallet");
  const locale = useLocale() as Locale;
  const [banks, setBanks] = useState<Array<{ id: string; name: string }> | null>(null);
  const [banksErr, setBanksErr] = useState(false);
  const [bankId, setBankId] = useState("");
  const [accountType, setAccountType] = useState<"ahorros" | "corriente">("ahorros");
  const [accountNumber, setAccountNumber] = useState("");
  const [docType, setDocType] = useState<"CC" | "CE" | "NIT" | "PA">("CC");
  const [docNumber, setDocNumber] = useState("");
  const [holderName, setHolderName] = useState("");
  const [amount, setAmount] = useState("");
  const [review, setReview] = useState<MerchantPayoutInput | null>(null);
  const [error, setError] = useState(false);
  const money = (cents: number) => formatMoney(cents, { locale, currency, fractionDigits: 2 }) + " " + currency;
  const cap = Math.min(maxCents, 2_147_483_647);
  useEffect(() => {
    if (bankLabel) return;
    const controller = new AbortController(); let active = true;
    fetch("/api/operator/wallet/banks", { cache: "no-store", signal: controller.signal }).then(async response => {
      const data = await response.json();
      if (!response.ok || !Array.isArray(data.banks) || !data.banks.every((b: { id?: unknown; name?: unknown }) => typeof b.id === "string" && typeof b.name === "string")) throw new Error("banks_failed");
      if (active) setBanks(data.banks);
    }).catch(() => { if (active) setBanksErr(true); });
    return () => { active = false; controller.abort(); };
  }, [bankLabel]);
  function prepare(event: FormEvent) {
    event.preventDefault(); setError(false);
    const cents = parseTrackingAmount(amount); const bank = banks?.find(value => value.id === bankId);
    if (cents === null || cents < 100 || cents > cap || (bankLabel && !ownDestinationFingerprint) || (!bankLabel && (!bank || !/^[a-zA-Z0-9_-]{1,20}$/.test(bank.id) || bank.name.trim().length < 2 || !/^\d{4,34}$/.test(accountNumber.trim()) || !/^[A-Za-z0-9-]{4,20}$/.test(docNumber.trim()) || holderName.trim().length < 3))) { setError(true); return; }
    setReview({ amountCents: cents, ...(bankLabel ? { ownDestinationFingerprint: ownDestinationFingerprint! } : { destination: { bankId, bankName: bank!.name, accountType, accountNumber: accountNumber.trim(), docType, docNumber: docNumber.trim(), holderName: holderName.trim() } }) });
  }
  const title = t(bankLabel ? "toBank" : "toOther");
  const locked = payout.busy || Boolean(payout.pending && !payout.canRebuild) || Boolean(payout.result);
  return <AppDialog label={title} placement="center" onClose={() => { if (!payout.busy) onClose(); }} dismissOnBackdrop={false} className="rounded-2xl bg-op-surface text-op-text"><div className="p-5 md:p-6">
    <header className="mb-4 flex items-start justify-between gap-4"><h2 className="font-display text-2xl">{title}</h2><button type="button" onClick={onClose} disabled={payout.busy} className="min-h-11 px-2 text-sm text-op-muted">{t("close")}</button></header>
    <MerchantPayoutNotice payout={payout} />
    {review ? <div className="space-y-4">
      <h3 className="font-medium">{t("payoutReview")}</h3>
      <dl className="space-y-3 rounded-xl bg-op-bg p-4 text-sm"><div><dt className="text-op-muted">{t("amount")}</dt><dd className="mt-1 font-mono text-xl">{money(review.amountCents)}</dd></div><div><dt className="text-op-muted">{t("transferBank")}</dt><dd className="mt-1 break-words">{review.destination?.bankName ?? bankLabel}</dd></div>{review.destination && <><div><dt className="text-op-muted">{t("transferHolder")}</dt><dd className="mt-1 break-words">{review.destination.holderName}</dd></div><div><dt className="text-op-muted">{t("transferAccountNumber")}</dt><dd className="mt-1 break-all">{t(review.destination.accountType === "ahorros" ? "accountSavings" : "accountChecking")} {" · "}{review.destination.accountNumber}</dd></div><div><dt className="text-op-muted">{t("transferDocNumber")}</dt><dd className="mt-1 break-all">{review.destination.docType}{" · "}{review.destination.docNumber}</dd></div></>}</dl>
      <p className="text-xs leading-relaxed text-op-muted">{t("transferNote")}</p>
      {(!payout.pending || payout.canRebuild) && !payout.result && <div className="flex flex-wrap gap-2"><button type="button" className="min-h-11 rounded-full bg-ink px-5 py-2 text-sm text-bone disabled:opacity-50" disabled={payout.busy} onClick={() => void payout.send(review)}>{t(payout.busy ? "processing" : "payoutConfirm")}</button><button type="button" className={button} disabled={locked} onClick={() => setReview(null)}>{t("payoutEdit")}</button></div>}
    </div> : <form onSubmit={prepare} className="space-y-4"><fieldset disabled={locked} className="min-w-0 space-y-3">
      {bankLabel ? <p className="text-sm">{t("destination", { bank: bankLabel })}</p> : <>
        <label className="block text-sm">{t("transferBank")}<select value={bankId} onChange={event => setBankId(event.target.value)} required className={field}><option value="">{t(banks === null ? "loadingBanks" : "chooseBank")}</option>{banks?.map(bank => <option key={bank.id} value={bank.id}>{bank.name}</option>)}</select></label>{banksErr && <p role="alert" className="text-sm text-danger">{t("banksError")}</p>}
        <label className="block text-sm">{t("transferAccountType")}<select value={accountType} onChange={event => setAccountType(event.target.value as typeof accountType)} className={field}><option value="ahorros">{t("accountSavings")}</option><option value="corriente">{t("accountChecking")}</option></select></label>
        <label className="block text-sm">{t("transferAccountNumber")}<input value={accountNumber} onChange={event => setAccountNumber(event.target.value)} className={field} inputMode="numeric" pattern="[0-9]{4,34}" maxLength={34} required /></label>
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-3"><label className="block text-sm">{t("transferDocType")}<select value={docType} onChange={event => setDocType(event.target.value as typeof docType)} className={field}>{(["CC", "CE", "NIT", "PA"] as const).map(type => <option key={type} value={type}>{type === "PA" ? t("docPassport") : type}</option>)}</select></label><label className="block text-sm">{t("transferDocNumber")}<input value={docNumber} onChange={event => setDocNumber(event.target.value)} className={field} pattern={"[A-Za-z0-9\\-]{4,20}"} maxLength={20} required /></label></div>
        <label className="block text-sm">{t("transferHolder")}<input value={holderName} onChange={event => setHolderName(event.target.value)} className={field} minLength={3} maxLength={120} required /></label>
      </>}
      <label className="block text-sm">{t("amount")}<MoneyInput value={amount} onChange={setAmount} fractionDigits={2} className={field} required ariaLabel={t("amount")} /><span className="mt-1 block text-xs text-op-muted">{t("max", { amount: money(cap) })}</span></label>
      {error && <p role="alert" className="text-sm text-danger">{t("invalidAmount")}</p>}
      <button type="submit" disabled={locked} className="min-h-11 w-full rounded-full bg-ink px-5 py-2 text-sm text-bone disabled:opacity-50">{t("payoutReview")}</button>
    </fieldset></form>}
  </div></AppDialog>;
}
