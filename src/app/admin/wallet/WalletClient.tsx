"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { formatDate, formatMoney } from "@/lib/format";
import type { Locale } from "@/i18n/config";
import { WalletPendingBalance } from "@/components/WalletPendingBalance";
import { WalletConfig } from "./WalletConfig";
import { WalletHistory } from "./WalletHistory";
import { WalletTransfer } from "./WalletTransfer";
import { errorCode, secondaryButton, walletRequest, type Payout, type WalletAccount, type WalletBalance, type WalletBank, type WalletConfig as Config } from "./client";

export function WalletClient() {
  const t = useTranslations("platformWallet");
  const locale = useLocale() as Locale;
  const [config, setConfig] = useState<Config | null>(null);
  const [configError, setConfigError] = useState("");
  const [configOpen, setConfigOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const [balance, setBalance] = useState<WalletBalance | null>(null);
  const [balanceError, setBalanceError] = useState("");
  const [balanceBusy, setBalanceBusy] = useState(false);
  const [banks, setBanks] = useState<WalletBank[]>([]);
  const [banksError, setBanksError] = useState("");
  const [payouts, setPayouts] = useState<Payout[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const activeAccount = useRef<string | null>(null);
  const historyRequest = useRef(0);
  const [configReload, setConfigReload] = useState(0);

  useEffect(() => {
    let active = true;
    walletRequest<Config>("config").then((value) => { if (active) setConfig(value); }).catch((error) => { if (active) setConfigError(errorCode(error)); });
    return () => { active = false; };
  }, [configReload]);

  const loadBalance = useCallback(async (account: WalletAccount) => {
    setBalanceBusy(true); setBalanceError("");
    try {
      const value = await walletRequest<WalletBalance>("balance");
      if (activeAccount.current === account.id) {
        if (value.accountId !== account.id) { setBalance(null); setBalanceError("account_changed"); }
        else setBalance(value);
      }
    } catch (error) { if (activeAccount.current === account.id) { setBalance(null); setBalanceError(errorCode(error)); } }
    finally { if (activeAccount.current === account.id) setBalanceBusy(false); }
  }, []);
  const loadBanks = useCallback(async (account: WalletAccount) => {
    setBanksError("");
    try {
      const value = await walletRequest<{ accountId: string; banks: WalletBank[] }>("banks");
      if (activeAccount.current === account.id) {
        if (value.accountId !== account.id) { setBanks([]); setBanksError("account_changed"); }
        else setBanks(value.banks);
      }
    } catch (error) { if (activeAccount.current === account.id) { setBanks([]); setBanksError(errorCode(error)); } }
  }, []);
  useEffect(() => {
    activeAccount.current = config?.account?.id ?? null;
    let active = true;
    queueMicrotask(() => {
      if (active && config?.account) { void loadBalance(config.account); void loadBanks(config.account); }
    });
    return () => { active = false; activeAccount.current = null; };
  }, [config?.account, loadBalance, loadBanks]);

  const loadHistory = useCallback(async (cursor?: string) => {
    const request = ++historyRequest.current;
    setHistoryBusy(true); setHistoryError("");
    try {
      const value = await walletRequest<{ payouts: Payout[]; nextCursor: string | null }>(`payouts${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
      if (historyRequest.current !== request) return;
      setPayouts((old) => cursor ? [...old, ...value.payouts.filter((next) => !old.some((existing) => existing.id === next.id))] : value.payouts);
      setNextCursor(value.nextCursor);
    } catch (error) { if (historyRequest.current === request) setHistoryError(errorCode(error)); }
    finally { if (historyRequest.current === request) setHistoryBusy(false); }
  }, []);
  useEffect(() => {
    let active = true;
    queueMicrotask(() => { if (active) void loadHistory(); });
    return () => { active = false; };
  }, [loadHistory]);
  const updatePayout = useCallback((payout: Payout) => {
    historyRequest.current++;
    setHistoryBusy(false);
    setPayouts((current) => current.some((item) => item.id === payout.id) ? current.map((item) => item.id === payout.id ? payout : item) : [payout, ...current]);
    if (config?.account) void loadBalance(config.account);
  }, [config, loadBalance]);
  const account = config?.account;
  return <div className="mp-page space-y-6">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="max-w-3xl"><p className="mp-eyebrow">{t("eyebrow")}</p><h1 className="mp-page-title mt-2">{t("title")}</h1><p className="mt-3 text-sm leading-relaxed text-op-muted">{t("intro")}</p></div>
      {account && <button className={secondaryButton} type="button" onClick={() => { setSaved(false); setConfigOpen((value) => !value); }}>{t(configOpen ? "hideConfig" : "configureAccount")}</button>}
    </header>
    {saved && <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">{t("accountSaved")}</p>}
    {configError && <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700"><p>{t(t.has(`errors.${configError}`) ? `errors.${configError}` : "errors.request_failed")}</p><button type="button" className={`${secondaryButton} mt-3`} onClick={() => { setConfigError(""); setConfigReload((value) => value + 1); }}>{t("retry")}</button></div>}
    {!config && !configError && <p role="status" className="rounded-2xl border border-op-border bg-op-surface p-6 text-sm text-op-muted">{t("loading")}</p>}
    {config && (!account || configOpen) && <WalletConfig key={account?.id ?? "new"} config={config} onSaved={(next) => { setBalance(null); setBanks([]); setConfig(next); setConfigOpen(false); setSaved(true); }} onCancel={account ? () => setConfigOpen(false) : undefined} />}
    {account && <>
      <section className="overflow-hidden rounded-2xl border border-op-border bg-op-surface" aria-labelledby="wallet-balance-title">
        <div className="grid items-start gap-5 p-5 sm:grid-cols-2 md:p-7">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2"><p className="font-mono text-[10px] uppercase tracking-wider text-op-muted">{account.label}</p><span className={`rounded-full px-2 py-1 text-xs ${account.mode === "production" ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-800"}`}>{t(`mode_${account.mode}`)}</span></div>
            <h2 id="wallet-balance-title" className="mt-4 text-sm text-op-muted">{t("balanceTitle")}</h2>
            <p className="mt-2 break-words font-display text-4xl leading-tight sm:text-5xl" aria-live="polite">{balance ? formatMoney(balance.availableCents, { currency: "COP", locale }) : t(balanceBusy ? "loadingBalance" : "balanceUnavailable")}</p>
            <p className="mt-2 font-mono text-xs text-op-muted">{t("currencyLabel")}</p>
          </div>
          <WalletPendingBalance balance={balance} currency="COP" loading={balanceBusy} failed={Boolean(balanceError)} onRetry={() => loadBalance(account)} />
        </div>
        <div className="flex flex-wrap items-start justify-between gap-4 border-t border-op-border p-5 md:px-7">
          <div className="max-w-3xl"><p className="text-sm leading-relaxed text-op-muted">{t("balanceHint")}</p>{balance && <p className="mt-3 text-xs text-op-muted">{t("queriedAt", { date: formatDate(balance.queriedAt, { locale, timeZone: "America/Bogota" }) })}</p>}{balance?.balanceDate && <p className="mt-1 text-xs text-op-muted">{t("balanceDate", { date: formatDate(balance.balanceDate, { locale, timeZone: "America/Bogota" }) })}</p>}{balanceError && <p role="alert" className="mt-3 text-sm text-red-700">{t(t.has(`errors.${balanceError}`) ? `errors.${balanceError}` : "errors.balance_failed")}</p>}</div>
          <button type="button" className={secondaryButton} disabled={balanceBusy} onClick={() => loadBalance(account)}>{t(balanceBusy ? "checking" : "refreshBalance")}</button>
        </div>
      </section>
      <WalletTransfer key={account.id} account={account} balance={balance} banks={banks} banksError={banksError} reloadBanks={() => loadBanks(account)} onPayout={updatePayout} payouts={payouts} blocked={payouts.some((payout) => payout.status === "submitting" || payout.status === "unknown")} />
    </>}
    {config && <WalletHistory payouts={payouts} loading={historyBusy} error={historyError} hasMore={Boolean(nextCursor)} onLoadMore={() => { if (nextCursor) void loadHistory(nextCursor); }} onReload={() => loadHistory()} onUpdate={updatePayout} />}
  </div>;
}
