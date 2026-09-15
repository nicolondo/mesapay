"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useApplePaySupport } from "@/lib/browser/capabilities";
import { ApplePayButton } from "@/app/t/[slug]/pay/[orderId]/ApplePayButton";

/**
 * Cobro de un link de pago: selector de medio (según lo que el comercio
 * habilitó) + sub-flujo de Tarjeta (form), Apple Pay (sheet nativo) o
 * PSE (banco + redirect). Es el mismo flujo que el depósito de reserva
 * (ReservarClient) apuntando a /api/tenant/[slug]/pay-links/[token]; el
 * depósito sigue con su propia copia porque su formulario vive dentro de
 * la pantalla de reservar y moverlo es más riesgo que valor hoy.
 */
type KushkiMode = "mock" | "sandbox" | "production";
type Currency = "COP" | "MXN";

type Props = {
  tenantSlug: string;
  tenantName: string;
  token: string;
  amountCents: number;
  /** Ya formateado en el server (moneda del comercio, idioma del visitante). */
  amountLabel: string;
  methods: string[];
  kushkiPublicKey: string | null;
  kushkiMode: KushkiMode;
  currency: Currency;
  pseBanks: { code: string; name: string }[];
};

const METHOD_NAMES: Record<string, string> = {
  kushki_card: "methodCard",
  kushki_pse: "methodPse",
  kushki_apple_pay: "methodApplePay",
};

const inputCls =
  "mt-1 w-full h-11 rounded-xl border border-hairline bg-bone px-3 text-sm focus:outline-none focus:border-ink";
const labelCls = "font-mono text-[10px] tracking-[0.14em] uppercase text-muted";

export function PayLinkClient(props: Props) {
  const t = useTranslations("payLink");
  const router = useRouter();
  const appleOk = useApplePaySupport();
  const [selected, setSelected] = useState("");
  const [approved, setApproved] = useState(false);

  const known = props.methods.filter((m) => m in METHOD_NAMES);
  const available = known.filter((m) => m !== "kushki_apple_pay" || appleOk);
  const list = available.length > 0 ? available : known;
  const effective = selected || (list.length === 1 ? list[0] : "");

  function onApproved() {
    setApproved(true);
    router.refresh();
  }

  if (approved) {
    return (
      <div className="rounded-2xl border border-hairline bg-paper p-5 text-center">
        <div className="mx-auto w-12 h-12 rounded-full bg-[#2E6B4C]/15 text-[#1E5339] flex items-center justify-center text-xl mb-3">
          {"✓"}
        </div>
        <div className="font-display text-2xl mb-1">{t("titlePaid")}</div>
        <p className="text-sm text-muted">{t("paidBody", { amount: props.amountLabel })}</p>
      </div>
    );
  }

  if (list.length === 0) {
    return (
      <div className="rounded-2xl border border-hairline bg-paper p-5 text-sm text-muted">
        {t("noMethods")}
      </div>
    );
  }

  if (!effective) {
    return (
      <div className="rounded-2xl border border-hairline bg-paper p-5 space-y-2 text-left">
        <div className="text-sm font-medium text-ink mb-1">{t("howPay")}</div>
        {list.map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setSelected(m)}
            className="w-full h-12 rounded-xl border border-hairline bg-bone text-sm font-medium text-ink flex items-center justify-between px-4 hover:border-ink"
          >
            <span>{t(METHOD_NAMES[m])}</span>
            <span className="text-muted">{"→"}</span>
          </button>
        ))}
      </div>
    );
  }

  const backBtn =
    list.length > 1 ? (
      <button
        type="button"
        onClick={() => setSelected("")}
        className="mt-2 w-full text-center text-xs text-muted hover:text-ink"
      >
        {"← "}
        {t("chooseAnother")}
      </button>
    ) : null;

  if (effective === "kushki_pse") {
    return (
      <>
        <PseForm {...props} />
        {backBtn}
      </>
    );
  }
  if (effective === "kushki_apple_pay") {
    return (
      <>
        <ApplePayPay {...props} onApproved={onApproved} />
        {backBtn}
      </>
    );
  }
  return (
    <>
      <CardForm {...props} onApproved={onApproved} />
      {backBtn}
    </>
  );
}

/** Traduce el `reason` del server; si no lo conoce, el genérico. */
function useReason() {
  const t = useTranslations("payLink");
  return (reason: unknown, fallback: string) => {
    const key = typeof reason === "string" ? `reason_${reason}` : "";
    return key && t.has(key) ? t(key) : fallback;
  };
}

function CardForm({
  tenantSlug,
  token,
  amountCents,
  amountLabel,
  kushkiPublicKey,
  kushkiMode,
  currency,
  onApproved,
}: Props & { onApproved: () => void }) {
  const t = useTranslations("payLink");
  const reasonText = useReason();
  const [number, setNumber] = useState("");
  const [holderName, setHolderName] = useState("");
  const [expiry, setExpiry] = useState("");
  const [cvv, setCvv] = useState("");
  const [email, setEmail] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isMock = kushkiMode === "mock";

  const formatCardNumber = (raw: string) =>
    raw.replace(/\D/g, "").slice(0, 19).replace(/(.{4})/g, "$1 ").trim();
  const formatExpiry = (raw: string) => {
    const digits = raw.replace(/\D/g, "").slice(0, 4);
    return digits.length < 3 ? digits : digits.slice(0, 2) + "/" + digits.slice(2);
  };

  async function pay() {
    setErr(null);
    const digits = number.replace(/\s/g, "");
    if (digits.length < 13 || digits.length > 19) return setErr(t("errCardNumber"));
    if (holderName.trim().length < 3) return setErr(t("errCardName"));
    const m = /^(\d{2})\/(\d{2})$/.exec(expiry);
    if (!m || Number(m[1]) < 1 || Number(m[1]) > 12) return setErr(t("errExpiry"));
    if (!cvv.match(/^\d{3,4}$/)) return setErr(t("errCvv"));
    if (!email.trim() || !email.includes("@")) return setErr(t("errEmail"));

    setBusy(true);
    try {
      let cardToken: string;
      if (isMock || !kushkiPublicKey) {
        cardToken = `mock-card-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      } else {
        const baseUrl =
          kushkiMode === "production"
            ? "https://api.kushkipagos.com"
            : "https://api-uat.kushkipagos.com";
        const res = await fetch(`${baseUrl}/card/v1/tokens`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Public-Merchant-Id": kushkiPublicKey,
          },
          body: JSON.stringify({
            card: {
              number: digits,
              name: holderName.trim(),
              expiryMonth: m[1],
              expiryYear: m[2],
              cvv,
            },
            totalAmount: amountCents / 100,
            currency,
            isDeferred: false,
            email: email.trim().toLowerCase(),
          }),
        });
        const json: { token?: string; code?: string; message?: string } = await res
          .json()
          .catch(() => ({}));
        if (!res.ok || json.code || !json.token) {
          setErr(`${json.message ?? t("errProcessPayment")}${json.code ? ` (${json.code})` : ""}`);
          setBusy(false);
          return;
        }
        cardToken = json.token;
      }

      const chargeRes = await fetch(`/api/tenant/${tenantSlug}/pay-links/${token}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token: cardToken,
          method: "kushki_card",
          email: email.trim().toLowerCase(),
        }),
      });
      const cj = await chargeRes.json().catch(() => ({}));
      if (!chargeRes.ok) {
        setErr(reasonText(cj.reason ?? cj.error, t("errChargeFailed")));
        setBusy(false);
        return;
      }
      if (!cj.approved) {
        setErr(reasonText(cj.reason, t("errDeclined")));
        setBusy(false);
        return;
      }
      onApproved();
    } catch (e) {
      console.error("[pay-link] card error", e);
      setErr(t("errProcessCard"));
      setBusy(false);
    }
  }

  return (
    <div className="rounded-2xl border border-hairline bg-paper p-5 space-y-3 text-left">
      <label className="block">
        <span className={labelCls}>{t("cardNumber")}</span>
        <input
          inputMode="numeric"
          autoComplete="cc-number"
          value={number}
          onChange={(e) => setNumber(formatCardNumber(e.target.value))}
          placeholder={t("cardNumberPlaceholder")}
          className={inputCls + " font-mono tabular"}
        />
      </label>
      <label className="block">
        <span className={labelCls}>{t("cardName")}</span>
        <input
          autoComplete="cc-name"
          value={holderName}
          onChange={(e) => setHolderName(e.target.value)}
          placeholder={t("cardNamePlaceholder")}
          className={inputCls}
        />
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className={labelCls}>{t("expiry")}</span>
          <input
            inputMode="numeric"
            autoComplete="cc-exp"
            value={expiry}
            onChange={(e) => setExpiry(formatExpiry(e.target.value))}
            placeholder={t("expiryPlaceholder")}
            className={inputCls + " font-mono tabular"}
          />
        </label>
        <label className="block">
          <span className={labelCls}>{t("cvv")}</span>
          <input
            inputMode="numeric"
            autoComplete="cc-csc"
            value={cvv}
            onChange={(e) => setCvv(e.target.value.replace(/\D/g, "").slice(0, 4))}
            placeholder={t("cvvPlaceholder")}
            className={inputCls + " font-mono tabular"}
          />
        </label>
      </div>
      <label className="block">
        <span className={labelCls}>{t("email")}</span>
        <input
          type="email"
          inputMode="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder={t("emailPlaceholder")}
          className={inputCls}
        />
      </label>
      {err && (
        <div className="text-sm text-danger bg-danger/5 border border-danger/30 rounded-lg px-3 py-2">
          {err}
        </div>
      )}
      <button
        type="button"
        disabled={busy}
        onClick={pay}
        className="w-full h-12 rounded-full bg-ink text-bone font-medium text-sm disabled:opacity-60"
      >
        {busy ? t("processing") : t("payButton", { amount: amountLabel })}
      </button>
      <p className="text-[10px] text-muted text-center">{t("cardSecureNote")}</p>
    </div>
  );
}

function ApplePayPay({
  tenantSlug,
  tenantName,
  token,
  amountCents,
  kushkiPublicKey,
  kushkiMode,
  currency,
  onApproved,
}: Props & { onApproved: () => void }) {
  const t = useTranslations("payLink");
  const reasonText = useReason();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function charge(walletToken: string) {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/tenant/${tenantSlug}/pay-links/${token}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: walletToken, method: "kushki_apple_pay" }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.approved) {
        setErr(reasonText(j.reason ?? j.error, t("errDeclined")));
        setBusy(false);
        return;
      }
      onApproved();
    } catch (e) {
      console.error("[pay-link] apple pay", e);
      setErr(t("errProcessPayment"));
      setBusy(false);
    }
  }

  return (
    <div className="rounded-2xl border border-hairline bg-paper p-5">
      {kushkiPublicKey ? (
        <ApplePayButton
          publicKey={kushkiPublicKey}
          kushkiMode={kushkiMode}
          currency={currency}
          amountCents={amountCents}
          displayName={t("displayName", { name: tenantName })}
          busy={busy}
          onTokenized={charge}
        />
      ) : (
        <p className="text-sm text-muted text-center">{t("appleUnavailable")}</p>
      )}
      {err && (
        <div className="mt-3 text-sm text-danger bg-danger/5 border border-danger/30 rounded-lg px-3 py-2">
          {err}
        </div>
      )}
      <p className="text-[10px] text-muted text-center mt-3">{t("appleSafariNote")}</p>
    </div>
  );
}

function PseForm({
  tenantSlug,
  token,
  amountCents,
  amountLabel,
  kushkiPublicKey,
  kushkiMode,
  pseBanks,
}: Props) {
  const t = useTranslations("payLink");
  const reasonText = useReason();
  const [banks, setBanks] = useState(pseBanks ?? []);
  const [banksLoading, setBanksLoading] = useState((pseBanks ?? []).length === 0);
  const [bankCode, setBankCode] = useState("");
  const [email, setEmail] = useState("");
  const [docType, setDocType] = useState<"CC" | "CE" | "NIT" | "PA" | "TI">("NIT");
  const [docNumber, setDocNumber] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const kushkiRef = useRef<unknown>(null);
  const isMock = kushkiMode === "mock";

  useEffect(() => {
    if (banks.length > 0) return;
    let alive = true;
    (async () => {
      setBanksLoading(true);
      try {
        const res = await fetch(`/api/tenant/${tenantSlug}/pay/pse-banks`);
        const j = await res.json();
        if (alive && res.ok && Array.isArray(j.banks)) setBanks(j.banks);
        else if (alive) setErr(t("errBanks"));
      } catch {
        if (alive) setErr(t("errBanks"));
      } finally {
        if (alive) setBanksLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantSlug]);

  async function pay() {
    if (!isMock && !bankCode) return setErr(t("errChooseBank"));
    if (!email.trim() || !email.includes("@")) return setErr(t("errEmail"));
    if (!docNumber.trim()) return setErr(t("errDocRequired"));
    setErr(null);
    setBusy(true);
    const buyer = {
      email: email.trim().toLowerCase(),
      docType,
      docNumber: docNumber.trim(),
      personType: docType === "NIT" ? ("juridica" as const) : ("natural" as const),
    };
    const endpoint = `/api/tenant/${tenantSlug}/pay-links/${token}/pse`;
    try {
      if (isMock || !kushkiPublicKey) {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ buyer, bankCode }),
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok || !j.redirectUrl) {
          setErr(reasonText(j.error, t("errPseInit")));
          setBusy(false);
          return;
        }
        window.location.href = j.redirectUrl;
        return;
      }
      if (!kushkiRef.current) {
        const mod = await import("@kushki/js");
        const Ctor = mod.Kushki ?? (mod as { default?: unknown }).default;
        if (typeof Ctor !== "function") throw new Error("@kushki/js sin Kushki");
        const K = Ctor as new (o: { merchantId: string; inTestEnvironment: boolean }) => unknown;
        kushkiRef.current = new K({
          merchantId: kushkiPublicKey,
          inTestEnvironment: kushkiMode !== "production",
        });
      }
      const callbackUrl = `${window.location.origin}/r/${tenantSlug}/pago/${token}/return`;
      const body = {
        amount: { subtotalIva: 0, subtotalIva0: amountCents / 100, iva: 0 },
        callbackUrl,
        userType: docType === "NIT" ? "1" : "0",
        documentNumber: docNumber.trim(),
        documentType: docType === "PA" ? "PP" : docType,
        email: buyer.email,
        currency: "COP",
        bankId: bankCode,
      };
      const response = await new Promise<{ token?: string; code?: string; message?: string; error?: string }>(
        (resolve) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (kushkiRef.current as any).requestTransferToken(body, (resp: any) => resolve(resp));
        },
      );
      if (response.code || !response.token) {
        setErr(
          `${response.message ?? response.error ?? t("errProcessPayment")}${response.code ? ` (${response.code})` : ""}`,
        );
        setBusy(false);
        return;
      }
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: response.token, buyer, bankCode }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.redirectUrl) {
        setErr(reasonText(j.error, t("errTransferInit")));
        setBusy(false);
        return;
      }
      window.location.href = j.redirectUrl;
    } catch (e) {
      console.error("[pay-link] pse", e);
      setErr(t("errPseRetry"));
      setBusy(false);
    }
  }

  return (
    <div className="rounded-2xl border border-hairline bg-paper p-5 space-y-3 text-left">
      {!isMock && (
        <label className="block">
          <span className={labelCls}>{t("bank")}</span>
          <select
            value={bankCode}
            onChange={(e) => setBankCode(e.target.value)}
            disabled={banksLoading}
            className={inputCls}
          >
            <option value="">{banksLoading ? t("loadingBanks") : t("chooseBank")}</option>
            {banks.map((b) => (
              <option key={b.code} value={b.code}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="grid grid-cols-[90px_1fr] gap-2">
        <label className="block">
          <span className={labelCls}>{t("docType")}</span>
          <select
            value={docType}
            onChange={(e) => setDocType(e.target.value as "CC" | "CE" | "NIT" | "PA" | "TI")}
            className={inputCls + " px-2"}
          >
            <option value="NIT">NIT</option>
            <option value="CC">CC</option>
            <option value="CE">CE</option>
            <option value="PA">PA</option>
            <option value="TI">TI</option>
          </select>
        </label>
        <label className="block">
          <span className={labelCls}>{t("document")}</span>
          <input
            inputMode="numeric"
            value={docNumber}
            onChange={(e) => setDocNumber(e.target.value)}
            placeholder={t("docNumberPlaceholder")}
            className={inputCls}
          />
        </label>
      </div>
      <label className="block">
        <span className={labelCls}>{t("email")}</span>
        <input
          type="email"
          inputMode="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder={t("emailPlaceholder")}
          className={inputCls}
        />
      </label>
      {err && (
        <div className="text-sm text-danger bg-danger/5 border border-danger/30 rounded-lg px-3 py-2">
          {err}
        </div>
      )}
      <button
        type="button"
        disabled={busy || banksLoading}
        onClick={pay}
        className="w-full h-12 rounded-full bg-ink text-bone font-medium text-sm disabled:opacity-60"
      >
        {busy ? t("connectingBank") : t("payPse", { amount: amountLabel })}
      </button>
      <p className="text-[10px] text-muted text-center">{t("pseSecureNote")}</p>
    </div>
  );
}
