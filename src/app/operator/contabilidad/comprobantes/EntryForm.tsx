"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { MoneyInput } from "@/components/MoneyInput";
import { formatMoney } from "@/lib/format";
import type { Locale } from "@/i18n/config";
import {
  centsToMajor,
  entryYmd,
  fractionDigitsFor,
  LIST_PATH,
  majorToCents,
  todayYmd,
  voucherLabel,
  type EntryDetail,
} from "./shared";

type Account = { code: string; name: string; postable: boolean };
type Center = { id: string; name: string; active: boolean };
type ThirdParty = { name: string; taxId: string | null; kind: "supplier" | "customer" };

type FormLine = {
  key: number;
  accountCode: string;
  /** Texto del combobox (código · nombre cuando hay cuenta elegida). */
  query: string;
  debit: string;
  credit: string;
  costCenterId: string;
  memo: string;
};

const inputCls =
  "w-full min-h-[44px] px-3 rounded-lg border border-op-border bg-op-bg text-sm focus:outline-none focus:border-op-text/40";
const smallInputCls =
  "w-full min-h-[38px] px-2 rounded-lg border border-op-border bg-op-bg text-sm focus:outline-none focus:border-op-text/40";
const labelCls = "block text-[10px] uppercase tracking-wider text-op-muted mb-1";

let nextKey = 1;
const blankLine = (): FormLine => ({
  key: nextKey++,
  accountCode: "",
  query: "",
  debit: "",
  credit: "",
  costCenterId: "",
  memo: "",
});

/**
 * Formulario de comprobante manual (nuevo / editar). Cuenta con combobox
 * sobre las cuentas imputables del plan, centro de costos opcional, un solo
 * lado por línea (escribir en débito limpia el crédito y viceversa), totales
 * en vivo y guardar deshabilitado mientras no cuadre. Los errores del
 * servidor llegan por código y se traducen acá (`err_<código>`).
 */
export function EntryForm({
  mode,
  entryId,
  currency,
}: {
  mode: "create" | "edit";
  entryId?: string;
  currency: string;
}) {
  const t = useTranslations("opComprobantes");
  const locale = useLocale() as Locale;
  const router = useRouter();
  const fractionDigits = fractionDigitsFor(currency);

  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [centers, setCenters] = useState<Center[]>([]);
  const [loaded, setLoaded] = useState(mode === "create");
  const [voucherNumber, setVoucherNumber] = useState<number | null>(null);
  const [date, setDate] = useState(todayYmd());
  const [memo, setMemo] = useState("");
  const [tpName, setTpName] = useState("");
  const [tpTaxId, setTpTaxId] = useState("");
  const [lines, setLines] = useState<FormLine[]>(() => [blankLine(), blankLine()]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<{ code: string; line?: number } | null>(null);

  // Catálogos + (en edición) el comprobante.
  useEffect(() => {
    let alive = true;
    const loads: Promise<unknown>[] = [
      fetch("/api/operator/accounting/chart")
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error("chart"))))
        .then((j) => {
          if (alive) {
            setAccounts((j.accounts as Account[]).filter((a) => a.postable));
          }
        }),
      fetch("/api/operator/accounting/centros")
        .then((r) => (r.ok ? r.json() : { centers: [] }))
        .then((j) => {
          if (alive) setCenters((j.centers as Center[]).filter((c) => c.active));
        }),
    ];
    if (mode === "edit" && entryId) {
      loads.push(
        fetch(`/api/operator/accounting/entries/${entryId}`)
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error("entry"))))
          .then((j) => {
            if (!alive) return;
            const e = j.entry as EntryDetail;
            setVoucherNumber(e.voucherNumber);
            setDate(entryYmd(e.date));
            setMemo(e.memo ?? "");
            setTpName(e.thirdPartyName ?? "");
            setTpTaxId(e.thirdPartyTaxId ?? "");
            setLines(
              e.lines.map((l) => ({
                key: nextKey++,
                accountCode: l.accountCode,
                query: `${l.accountCode} · ${l.accountName}`,
                debit: centsToMajor(l.debitCents, fractionDigits),
                credit: centsToMajor(l.creditCents, fractionDigits),
                costCenterId: l.costCenterId ?? "",
                memo: l.memo ?? "",
              })),
            );
            setLoaded(true);
          }),
      );
    }
    Promise.all(loads).catch(() => {
      if (alive) setErr({ code: "err_generic" });
    });
    return () => {
      alive = false;
    };
  }, [mode, entryId, fractionDigits]);

  const accountByCode = useMemo(
    () => new Map((accounts ?? []).map((a) => [a.code, a])),
    [accounts],
  );

  const totalDebit = lines.reduce((s, l) => s + majorToCents(l.debit), 0);
  const totalCredit = lines.reduce((s, l) => s + majorToCents(l.credit), 0);
  const diff = totalDebit - totalCredit;
  const validLines = lines.filter(
    (l) => l.accountCode && (majorToCents(l.debit) > 0 || majorToCents(l.credit) > 0),
  ).length;
  const balanced = diff === 0 && totalDebit > 0;
  const canSave =
    !saving && loaded && accounts !== null && balanced && validLines >= 2 && memo.trim().length > 0 && !!date;

  const money = (c: number) => formatMoney(c, { currency, locale });

  function patchLine(key: number, patch: Partial<FormLine>) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function removeLine(key: number) {
    setLines((prev) => (prev.length <= 2 ? prev : prev.filter((l) => l.key !== key)));
  }

  async function submit(ev: React.FormEvent) {
    ev.preventDefault();
    if (!canSave) return;
    setSaving(true);
    setErr(null);
    const body = {
      date,
      memo: memo.trim(),
      thirdPartyName: tpName.trim() || null,
      thirdPartyTaxId: tpTaxId.trim() || null,
      lines: lines
        .filter((l) => l.accountCode || l.debit || l.credit)
        .map((l) => ({
          accountCode: l.accountCode,
          debitCents: majorToCents(l.debit),
          creditCents: majorToCents(l.credit),
          costCenterId: l.costCenterId || null,
          memo: l.memo.trim() || null,
        })),
    };
    const url =
      mode === "edit" ? `/api/operator/accounting/entries/${entryId}` : "/api/operator/accounting/entries";
    const r = await fetch(url, {
      method: mode === "edit" ? "PUT" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      setErr({ code: `err_${j.error ?? "generic"}`, line: j.line });
      setSaving(false);
      return;
    }
    router.push(`${LIST_PATH}/${j.entry.id}`);
  }

  const errText = err
    ? (() => {
        const msg = t.has(err.code) ? t(err.code) : t("err_generic");
        return err.line != null ? t("lineErr", { n: err.line, msg }) : msg;
      })()
    : null;

  const backHref = mode === "edit" && entryId ? `${LIST_PATH}/${entryId}` : LIST_PATH;

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link href={backHref} className="text-xs text-op-muted hover:text-op-accent hover:underline">
            {t("backToList")}
          </Link>
          <div className="font-display text-3xl mt-1">
            {mode === "edit"
              ? t("formTitleEdit", { n: voucherLabel(voucherNumber) || "" })
              : t("formTitleNew")}
          </div>
          <p className="text-sm text-op-muted mt-1">{t("formIntro")}</p>
        </div>
      </div>

      {errText && <div className="text-sm text-danger">{errText}</div>}

      <div className="rounded-2xl border border-op-border bg-op-surface p-4 space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label className={labelCls} htmlFor="entry-date">
              {t("fDate")}
            </label>
            <input
              id="entry-date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              required
              className={inputCls}
            />
          </div>
          <div className="sm:col-span-2">
            <label className={labelCls} htmlFor="entry-memo">
              {t("fMemo")}
            </label>
            <input
              id="entry-memo"
              type="text"
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              placeholder={t("fMemoPlaceholder")}
              maxLength={300}
              required
              className={inputCls}
            />
          </div>
        </div>
        <ThirdPartyFields
          name={tpName}
          taxId={tpTaxId}
          onChange={(n, id) => {
            setTpName(n);
            setTpTaxId(id);
          }}
        />
      </div>

      <div className="rounded-2xl border border-op-border bg-op-surface overflow-hidden">
        <div className="border-b border-op-border bg-op-bg px-4 py-2 text-sm font-medium">
          {t("linesTitle")}
        </div>
        {!loaded || accounts === null ? (
          <div className="p-4 text-sm text-op-muted">{t("loading")}</div>
        ) : (
          <div className="divide-y divide-op-border/50">
            {lines.map((l, i) => (
              <div key={l.key} className="grid grid-cols-12 gap-2 px-3 py-2 items-start">
                <div className="col-span-12 md:col-span-4">
                  <AccountCombobox
                    accounts={accounts}
                    value={l.accountCode}
                    query={l.query}
                    onQuery={(q) => patchLine(l.key, { query: q, accountCode: "" })}
                    onPick={(a) =>
                      patchLine(l.key, { accountCode: a.code, query: `${a.code} · ${a.name}` })
                    }
                    onBlur={() => {
                      // Código exacto tecleado sin elegir de la lista → se acepta.
                      const exact = accountByCode.get(l.query.trim());
                      if (!l.accountCode && exact) {
                        patchLine(l.key, {
                          accountCode: exact.code,
                          query: `${exact.code} · ${exact.name}`,
                        });
                      }
                    }}
                    placeholder={t("accountPlaceholder")}
                    noMatch={t("accountNoMatch")}
                    ariaLabel={`${t("lAccount")} ${i + 1}`}
                  />
                </div>
                <div className="col-span-6 md:col-span-2">
                  <select
                    value={l.costCenterId}
                    onChange={(e) => patchLine(l.key, { costCenterId: e.target.value })}
                    aria-label={`${t("fCostCenter")} ${i + 1}`}
                    className={smallInputCls}
                  >
                    <option value="">{t("noCostCenter")}</option>
                    {centers.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="col-span-6 md:col-span-2">
                  <MoneyInput
                    value={l.debit}
                    onChange={(raw) =>
                      patchLine(l.key, { debit: raw, ...(raw && majorToCents(raw) > 0 ? { credit: "" } : {}) })
                    }
                    fractionDigits={fractionDigits}
                    placeholder={t("lDebit")}
                    ariaLabel={`${t("lDebit")} ${i + 1}`}
                    className={smallInputCls + " text-right font-mono tabular-nums"}
                  />
                </div>
                <div className="col-span-6 md:col-span-2">
                  <MoneyInput
                    value={l.credit}
                    onChange={(raw) =>
                      patchLine(l.key, { credit: raw, ...(raw && majorToCents(raw) > 0 ? { debit: "" } : {}) })
                    }
                    fractionDigits={fractionDigits}
                    placeholder={t("lCredit")}
                    ariaLabel={`${t("lCredit")} ${i + 1}`}
                    className={smallInputCls + " text-right font-mono tabular-nums"}
                  />
                </div>
                <div className="col-span-5 md:col-span-1">
                  <input
                    type="text"
                    value={l.memo}
                    onChange={(e) => patchLine(l.key, { memo: e.target.value })}
                    placeholder={t("lineMemoPlaceholder")}
                    maxLength={300}
                    aria-label={`${t("lMemo")} ${i + 1}`}
                    className={smallInputCls}
                  />
                </div>
                <div className="col-span-1 flex justify-end">
                  <button
                    type="button"
                    onClick={() => removeLine(l.key)}
                    disabled={lines.length <= 2}
                    aria-label={t("removeLine")}
                    title={t("removeLine")}
                    className="mp-btn mp-btn--ghost mp-btn--sm px-2 min-h-[38px]"
                  >
                    {"✕"}
                  </button>
                </div>
              </div>
            ))}
            <div className="px-3 py-2">
              <button
                type="button"
                onClick={() => setLines((prev) => [...prev, blankLine()])}
                className="mp-btn mp-btn--ghost mp-btn--sm px-3"
              >
                {t("addLine")}
              </button>
            </div>
          </div>
        )}
        <div className="flex flex-wrap items-baseline justify-end gap-x-6 gap-y-1 border-t border-op-border bg-op-bg px-4 py-2 text-sm">
          <span>
            {t("totalDebits")}
            {": "}
            <span className="font-mono tabular-nums font-medium">{money(totalDebit)}</span>
          </span>
          <span>
            {t("totalCredits")}
            {": "}
            <span className="font-mono tabular-nums font-medium">{money(totalCredit)}</span>
          </span>
          {balanced ? (
            <span className="px-2 h-5 inline-flex items-center rounded-full bg-ok/10 text-ok text-[10px] font-medium">
              {t("balancedOk")}
            </span>
          ) : (
            <span className="px-2 h-5 inline-flex items-center rounded-full bg-danger/10 text-danger text-[10px] font-medium">
              {t("difference")}
              {": "}
              <span className="font-mono tabular-nums ml-1">{money(Math.abs(diff))}</span>
            </span>
          )}
        </div>
      </div>

      {!balanced && totalDebit + totalCredit > 0 && (
        <p className="text-xs text-danger">{t("unbalancedHint", { amount: money(Math.abs(diff)) })}</p>
      )}
      {validLines < 2 && <p className="text-xs text-op-muted">{t("minLinesHint")}</p>}

      <div className="flex gap-2 justify-end">
        <Link href={backHref} className="mp-btn mp-btn--ghost px-4">
          {t("cancel")}
        </Link>
        <button type="submit" disabled={!canSave} className="mp-btn mp-btn--primary px-5">
          {saving ? t("saving") : t("save")}
        </button>
      </div>
    </form>
  );
}

/** Tercero (nombre + NIT) con selector sobre proveedores y clientes. */
function ThirdPartyFields({
  name,
  taxId,
  onChange,
}: {
  name: string;
  taxId: string;
  onChange: (name: string, taxId: string) => void;
}) {
  const t = useTranslations("opComprobantes");
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<ThirdParty[] | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      fetch(`/api/operator/accounting/entries/third-parties?q=${encodeURIComponent(q)}`)
        .then((r) => (r.ok ? r.json() : { items: [] }))
        .then((j) => {
          if (alive) setHits(j.items as ThirdParty[]);
        })
        .catch(() => {
          if (alive) setHits([]);
        });
    }, 250);
    return () => {
      alive = false;
    };
  }, [open, q]);

  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
      <div className="sm:col-span-2">
        <label className={labelCls} htmlFor="entry-tp-name">
          {t("fThirdPartyName")}
        </label>
        <div className="flex gap-2">
          <input
            id="entry-tp-name"
            type="text"
            value={name}
            onChange={(e) => onChange(e.target.value, taxId)}
            maxLength={160}
            className={inputCls}
          />
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="mp-btn mp-btn--secondary px-3 shrink-0"
          >
            {open ? t("closePicker") : t("pickThirdParty")}
          </button>
        </div>
      </div>
      <div>
        <label className={labelCls} htmlFor="entry-tp-taxid">
          {t("fThirdPartyTaxId")}
        </label>
        <input
          id="entry-tp-taxid"
          type="text"
          value={taxId}
          onChange={(e) => onChange(name, e.target.value)}
          maxLength={20}
          inputMode="numeric"
          className={inputCls + " font-mono"}
        />
      </div>
      {open && (
        <div className="sm:col-span-3 rounded-xl border border-op-border bg-op-bg p-2 space-y-2">
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("thirdPartySearchPlaceholder")}
            autoFocus
            className={smallInputCls}
          />
          {hits === null ? (
            <div className="text-xs text-op-muted px-1">{t("loading")}</div>
          ) : hits.length === 0 ? (
            <div className="text-xs text-op-muted px-1">{t("thirdPartyNone")}</div>
          ) : (
            <ul className="max-h-56 overflow-y-auto divide-y divide-op-border/50">
              {hits.map((h, i) => (
                <li key={`${h.kind}-${h.name}-${i}`}>
                  <button
                    type="button"
                    onClick={() => {
                      onChange(h.name, h.taxId ?? "");
                      setOpen(false);
                    }}
                    className="w-full text-left px-2 py-1.5 text-sm hover:bg-op-surface flex items-center gap-2"
                  >
                    <span className="min-w-0 truncate flex-1">{h.name}</span>
                    {h.taxId && (
                      <span className="font-mono text-xs text-op-muted">{h.taxId}</span>
                    )}
                    <span className="px-2 h-5 inline-flex items-center rounded-full bg-paper text-op-muted text-[10px] font-medium shrink-0">
                      {h.kind === "supplier" ? t("kindSupplier") : t("kindCustomer")}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** Combobox de cuenta: filtra por código (prefijo) o nombre sobre las imputables. */
function AccountCombobox({
  accounts,
  value,
  query,
  onQuery,
  onPick,
  onBlur,
  placeholder,
  noMatch,
  ariaLabel,
}: {
  accounts: Account[];
  value: string;
  query: string;
  onQuery: (q: string) => void;
  onPick: (a: Account) => void;
  onBlur: () => void;
  placeholder: string;
  noMatch: string;
  ariaLabel: string;
}) {
  const [focus, setFocus] = useState(false);
  const q = query.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!q) return accounts.slice(0, 8);
    return accounts
      .filter((a) => a.code.startsWith(q) || a.name.toLowerCase().includes(q))
      .slice(0, 8);
  }, [accounts, q]);
  const showList = focus && !value;

  return (
    <div className="relative">
      <input
        type="text"
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        onFocus={() => setFocus(true)}
        onBlur={() => {
          // Deja pasar el click de la lista antes de cerrarla.
          setTimeout(() => {
            setFocus(false);
            onBlur();
          }, 120);
        }}
        placeholder={placeholder}
        aria-label={ariaLabel}
        autoComplete="off"
        className={smallInputCls + (value ? "" : " border-danger/40")}
      />
      {showList && (
        <ul className="absolute z-20 left-0 right-0 mt-1 max-h-56 overflow-y-auto rounded-lg border border-op-border bg-op-surface shadow-lg text-sm">
          {matches.length === 0 ? (
            <li className="px-2 py-1.5 text-xs text-op-muted">{noMatch}</li>
          ) : (
            matches.map((a) => (
              <li key={a.code}>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    onPick(a);
                    setFocus(false);
                  }}
                  className="w-full text-left px-2 py-1.5 hover:bg-op-bg flex gap-2"
                >
                  <span className="font-mono text-xs text-op-muted tabular-nums shrink-0">{a.code}</span>
                  <span className="min-w-0 truncate">{a.name}</span>
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
