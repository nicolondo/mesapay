"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { fmtCOP } from "@/lib/format";

// Estado DIAN por factura. `simpleInvoiceId` null ⇒ el cliente aún no
// generó la tirilla electrónica de la orden (no hay nada que emitir).
// `state` null ⇒ hay tirilla pero nunca se emitió a la DIAN.
type DianInfo = {
  simpleInvoiceId: string | null;
  state: string | null;
  cufe: string | null;
  errors: string[];
};

type Req = {
  id: string;
  customerName: string;
  docType: "CC" | "CE" | "NIT" | "PA";
  docNumber: string;
  address: string;
  city: string;
  department: string;
  email: string;
  notes: string | null;
  createdAt: string;
  order: {
    shortCode: string;
    totalCents: number;
    paidAt: string | null;
  };
  dian: DianInfo | null;
};

type GeneratedReq = Req & {
  generatedAt: string | null;
  generatedByEmail: string | null;
};

type Tab = "pending" | "generated";

export function FacturasClient({
  tab,
  einvoicingOn,
  pending,
  generated,
}: {
  tab: Tab;
  einvoicingOn: boolean;
  pending: Req[];
  generated: GeneratedReq[];
}) {
  const t = useTranslations("opFacturas");
  const router = useRouter();
  const [, startTx] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);

  async function mark(
    id: string,
    status: "generated" | "rejected" | "pending",
  ) {
    setBusyId(id);
    const res = await fetch(`/api/operator/invoice-requests/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status }),
    });
    setBusyId(null);
    if (res.ok) startTx(() => router.refresh());
  }

  function setTab(next: Tab) {
    router.push(`/operator/facturas?status=${next}`);
  }

  return (
    <div className="p-6 max-w-5xl mx-auto w-full">
      <div className="font-display text-3xl mb-1">{t("title")}</div>
      <p className="text-sm text-op-muted mb-6">{t("intro")}</p>

      <div className="flex gap-2 border-b border-op-border mb-4">
        <TabButton
          active={tab === "pending"}
          onClick={() => setTab("pending")}
          label={t("tabPending")}
          count={pending.length}
        />
        <TabButton
          active={tab === "generated"}
          onClick={() => setTab("generated")}
          label={t("tabGenerated")}
          count={generated.length}
        />
      </div>

      {tab === "pending" ? (
        pending.length === 0 ? (
          <Empty text={t("emptyPending")} />
        ) : (
          <ul className="space-y-3">
            {pending.map((r) => (
              <RequestCard
                key={r.id}
                req={r}
                busy={busyId === r.id}
                onMark={mark}
                einvoicingOn={einvoicingOn}
              />
            ))}
          </ul>
        )
      ) : generated.length === 0 ? (
        <Empty text={t("emptyGenerated")} />
      ) : (
        <ul className="space-y-3">
          {generated.map((r) => (
            <GeneratedCard
              key={r.id}
              req={r}
              busy={busyId === r.id}
              onReopen={() => mark(r.id, "pending")}
              einvoicingOn={einvoicingOn}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "h-9 px-4 -mb-px border-b-2 text-sm font-medium " +
        (active
          ? "border-ink text-ink"
          : "border-transparent text-op-muted hover:text-op-text")
      }
    >
      {label}
      <span className="ml-1.5 text-[11px] font-mono tabular opacity-70">
        {count}
      </span>
    </button>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="text-sm text-op-muted py-12 text-center border border-dashed border-op-border rounded-2xl">
      {text}
    </div>
  );
}

function RequestCard({
  req,
  busy,
  onMark,
  einvoicingOn,
}: {
  req: Req;
  busy: boolean;
  onMark: (id: string, status: "generated" | "rejected") => void;
  einvoicingOn: boolean;
}) {
  const t = useTranslations("opFacturas");
  function copyAll() {
    const text = [
      `${req.customerName}`,
      `${req.docType}: ${req.docNumber}`,
      `${req.address}, ${req.city}, ${req.department}`,
      `${t("copyEmail")}: ${req.email}`,
      `${t("copyOrder")}: ${req.order.shortCode} · ${fmtCOP(req.order.totalCents)}`,
    ].join("\n");
    navigator.clipboard.writeText(text).catch(() => {});
  }

  return (
    <li className="rounded-2xl border border-op-border bg-op-surface p-5">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <div className="font-display text-xl">{req.customerName}</div>
          <div className="font-mono text-[11px] tracking-wider uppercase text-op-muted mt-0.5">
            {t("orderPrefix")} {req.order.shortCode} ·{" "}
            {fmtCOP(req.order.totalCents)} · {hoursAgo(req.createdAt, t)}
          </div>
        </div>
        <span className="px-2 h-6 inline-flex items-center rounded-full text-[10px] font-medium bg-[#C98A2E]/20 text-[#7F5A1F] shrink-0">
          {t("badgePending")}
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-2 text-sm">
        <Row label={req.docType}>
          <span className="font-mono tabular">{req.docNumber}</span>
        </Row>
        <Row label={t("fieldEmail")}>
          <a
            href={`mailto:${req.email}`}
            className="text-terracotta hover:underline truncate"
          >
            {req.email}
          </a>
        </Row>
        <Row label={t("fieldAddress")}>{req.address}</Row>
        <Row label={t("fieldCityDept")}>
          {req.city}, {req.department}
        </Row>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => onMark(req.id, "generated")}
          disabled={busy}
          className="h-10 px-5 rounded-full bg-ok text-bone text-sm font-medium disabled:opacity-50"
        >
          {t("markGenerated")}
        </button>
        <button
          type="button"
          onClick={copyAll}
          className="h-10 px-4 rounded-full border border-op-border text-sm font-medium hover:bg-op-bg"
        >
          {t("copyData")}
        </button>
        <button
          type="button"
          onClick={() => {
            if (confirm(t("rejectConfirm"))) onMark(req.id, "rejected");
          }}
          disabled={busy}
          className="h-10 px-4 rounded-full border border-danger/40 text-danger text-sm font-medium hover:bg-danger/5 disabled:opacity-50"
        >
          {t("reject")}
        </button>
      </div>

      {einvoicingOn && req.dian && <DianBlock dian={req.dian} />}
    </li>
  );
}

function GeneratedCard({
  req,
  busy,
  onReopen,
  einvoicingOn,
}: {
  req: GeneratedReq;
  busy: boolean;
  onReopen: () => void;
  einvoicingOn: boolean;
}) {
  const t = useTranslations("opFacturas");
  return (
    <li className="rounded-2xl border border-op-border bg-op-surface p-5">
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="min-w-0">
          <div className="font-display text-lg truncate">
            {req.customerName}{" "}
            <span className="text-op-muted text-sm font-sans">
              · {req.docType} {req.docNumber}
            </span>
          </div>
          <div className="font-mono text-[11px] tracking-wider uppercase text-op-muted mt-0.5">
            {t("orderPrefix")} {req.order.shortCode} ·{" "}
            {fmtCOP(req.order.totalCents)}
          </div>
        </div>
        <span className="px-2 h-6 inline-flex items-center rounded-full text-[10px] font-medium bg-ok/15 text-ok shrink-0">
          {t("badgeGenerated")}
        </span>
      </div>
      <div className="text-xs text-op-muted">
        {req.email} · {req.city}, {req.department}
      </div>
      {req.generatedAt && (
        <div className="text-[11px] text-op-muted mt-1">
          {t("markedBy", {
            email: req.generatedByEmail ?? t("dash"),
            date: new Date(req.generatedAt).toLocaleString("es-CO"),
          })}
        </div>
      )}
      <button
        type="button"
        onClick={onReopen}
        disabled={busy}
        className="mt-3 text-[11px] text-op-muted hover:text-op-text underline disabled:opacity-50"
      >
        {t("markPendingAgain")}
      </button>

      {einvoicingOn && req.dian && <DianBlock dian={req.dian} />}
    </li>
  );
}

/**
 * Bloque de facturación electrónica DIAN por factura. Solo se renderea
 * con el módulo `einvoicing` activo. Reacciona sobre la SimpleInvoice de
 * la orden (dian.simpleInvoiceId):
 *   - sin tirilla generada ⇒ nota "el cliente aún no generó la factura".
 *   - sin documento o en error/rejected ⇒ botón Emitir / Reintentar.
 *   - accepted ⇒ badge verde + CUFE copiable.
 * El estado se refresca localmente tras el POST (router.refresh reevalúa
 * el server component, pero mantenemos el resultado optimista para el
 * feedback inmediato del CUFE/errores).
 */
function DianBlock({ dian }: { dian: DianInfo }) {
  const t = useTranslations("opFacturas");
  const router = useRouter();
  const [, startTx] = useTransition();
  const [emitting, setEmitting] = useState(false);
  const [state, setState] = useState<string | null>(dian.state);
  const [cufe, setCufe] = useState<string | null>(dian.cufe);
  const [errors, setErrors] = useState<string[]>(dian.errors);
  const [copied, setCopied] = useState(false);

  const inFlight =
    state === "to_send" || state === "sent" || state === "pending";
  const accepted = state === "accepted";
  const failed = state === "error" || state === "rejected";
  const canEmit = !accepted && !inFlight && !emitting;

  async function emit() {
    if (!dian.simpleInvoiceId) return;
    setEmitting(true);
    setErrors([]);
    try {
      const res = await fetch(
        `/api/operator/dian/emit/${dian.simpleInvoiceId}`,
        { method: "POST" },
      );
      const data = (await res.json().catch(() => null)) as {
        document?: {
          state: string;
          cufe: string | null;
          errors?: string[];
        };
        error?: string;
      } | null;
      if (res.ok && data?.document) {
        setState(data.document.state);
        setCufe(data.document.cufe);
        setErrors(data.document.errors ?? []);
      } else {
        setState("error");
        setErrors([data?.error ?? "dianErrorGeneric"]);
      }
      startTx(() => router.refresh());
    } catch {
      setState("error");
      setErrors(["dianErrorGeneric"]);
    } finally {
      setEmitting(false);
    }
  }

  function copyCufe() {
    if (!cufe) return;
    navigator.clipboard
      .writeText(cufe)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      })
      .catch(() => {});
  }

  return (
    <div className="mt-4 pt-3 border-t border-dashed border-op-border">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] tracking-wider uppercase text-op-muted">
            {t("dianSectionLabel")}
          </span>
          <DianBadge state={state} />
        </div>

        {dian.simpleInvoiceId && !accepted && (
          <button
            type="button"
            onClick={emit}
            disabled={!canEmit}
            className="h-9 px-4 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-50"
          >
            {emitting || inFlight
              ? t("dianEmitting")
              : failed
                ? t("dianRetry")
                : t("dianEmit")}
          </button>
        )}
      </div>

      {!dian.simpleInvoiceId && (
        <p className="mt-2 text-[11px] text-op-muted">{t("dianNoInvoiceYet")}</p>
      )}

      {accepted && cufe && (
        <div className="mt-2 flex items-start gap-2">
          <div className="min-w-0">
            <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted">
              {t("dianCufeLabel")}
            </div>
            <div className="font-mono text-[11px] break-all text-op-text">
              {cufe}
            </div>
          </div>
          <button
            type="button"
            onClick={copyCufe}
            className="shrink-0 h-7 px-3 rounded-full border border-op-border text-[11px] font-medium hover:bg-op-bg"
          >
            {copied ? t("dianCufeCopied") : t("dianCopyCufe")}
          </button>
        </div>
      )}

      {failed && errors.length > 0 && (
        <details className="mt-2">
          <summary className="text-[11px] text-danger cursor-pointer">
            {t("dianErrorsTitle")}
          </summary>
          <ul className="mt-1 space-y-0.5">
            {errors.map((e, i) => (
              <li key={i} className="font-mono text-[11px] text-danger break-all">
                {e}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function DianBadge({ state }: { state: string | null }) {
  const t = useTranslations("opFacturas");
  let label: string;
  let cls: string;
  switch (state) {
    case "accepted":
      label = t("dianStatusAccepted");
      cls = "bg-ok/15 text-ok";
      break;
    case "rejected":
      label = t("dianStatusRejected");
      cls = "bg-danger/15 text-danger";
      break;
    case "error":
      label = t("dianStatusError");
      cls = "bg-danger/15 text-danger";
      break;
    case "to_send":
    case "sent":
    case "pending":
      label = t("dianStatusInProcess");
      cls = "bg-[#C98A2E]/20 text-[#7F5A1F]";
      break;
    default:
      label = t("dianStatusNone");
      cls = "bg-op-bg text-op-muted";
  }
  return (
    <span
      className={
        "px-2 h-6 inline-flex items-center rounded-full text-[10px] font-medium " +
        cls
      }
    >
      {label}
    </span>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted">
        {label}
      </div>
      <div className="mt-0.5">{children}</div>
    </div>
  );
}

function hoursAgo(
  iso: string,
  t: (key: string, values?: Record<string, string | number>) => string,
): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return t("agoNow");
  if (mins < 60) return t("agoMinutes", { mins });
  const h = Math.floor(mins / 60);
  if (h < 24) return t("agoHours", { hours: h });
  return t("agoDays", { days: Math.floor(h / 24) });
}
