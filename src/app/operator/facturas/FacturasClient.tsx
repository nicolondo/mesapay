"use client";

import { displayOrderCode } from "@/lib/orderCode";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { fmtCOP } from "@/lib/format";

// Flujo MANUAL de solicitudes de factura: el comercio SIN facturación
// electrónica emite desde su propio sistema (Siigo, Alegra…) y marca acá lo
// que ya generó. Con el módulo `einvoicing` esta pantalla no se usa: la
// reemplaza la lista de facturas electrónicas (ElectronicInvoicesClient).
// El HTML de esta cara está fijado por page.test.ts.

/** "Ciudad, Departamento" con lo que haya (solicitudes viejas); "" si no hay. */
function cityDept(req: Pick<Req, "city" | "department">): string {
  return [req.city, req.department].filter(Boolean).join(", ");
}

type Req = {
  id: string;
  customerName: string;
  docType: "CC" | "CE" | "NIT" | "PA";
  docNumber: string;
  /** Sólo en solicitudes viejas: la factura ya no pide dirección. */
  address: string | null;
  city: string | null;
  department: string | null;
  email: string;
  notes: string | null;
  createdAt: string;
  order: {
    shortCode: string;
    totalCents: number;
    paidAt: string | null;
  };
  /** Tirilla generada de la orden — habilita "Imprimir en datáfono". */
  simpleInvoiceId: string | null;
};

type GeneratedReq = Req & {
  generatedAt: string | null;
  generatedByEmail: string | null;
};

type Tab = "pending" | "generated";

export function FacturasClient({
  tab,
  pending,
  generated,
}: {
  tab: Tab;
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
}: {
  req: Req;
  busy: boolean;
  onMark: (id: string, status: "generated" | "rejected") => void;
}) {
  const t = useTranslations("opFacturas");
  function copyAll() {
    const where = [req.address, cityDept(req)].filter(Boolean).join(", ");
    const text = [
      `${req.customerName}`,
      `${req.docType}: ${req.docNumber}`,
      ...(where ? [where] : []),
      `${t("copyEmail")}: ${req.email}`,
      `${t("copyOrder")}: ${displayOrderCode(req.order.shortCode)} · ${fmtCOP(req.order.totalCents)}`,
    ].join("\n");
    navigator.clipboard.writeText(text).catch(() => {});
  }

  return (
    <li className="rounded-2xl border border-op-border bg-op-surface p-5">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <div className="font-display text-xl">{req.customerName}</div>
          <div className="font-mono text-[11px] tracking-wider uppercase text-op-muted mt-0.5">
            {t("orderPrefix")} {displayOrderCode(req.order.shortCode)} ·{" "}
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
        {req.address && <Row label={t("fieldAddress")}>{req.address}</Row>}
        {cityDept(req) && <Row label={t("fieldCityDept")}>{cityDept(req)}</Row>}
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
          className="mp-btn mp-btn--sm mp-btn--secondary"
        >
          {t("copyData")}
        </button>
        <button
          type="button"
          onClick={() => {
            if (confirm(t("rejectConfirm"))) onMark(req.id, "rejected");
          }}
          disabled={busy}
          className="mp-btn mp-btn--sm mp-btn--danger"
        >
          {t("reject")}
        </button>
      </div>

      {req.simpleInvoiceId && <PrintOnTerminalButton invoiceId={req.simpleInvoiceId} />}
    </li>
  );
}

function GeneratedCard({
  req,
  busy,
  onReopen,
}: {
  req: GeneratedReq;
  busy: boolean;
  onReopen: () => void;
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
            {t("orderPrefix")} {displayOrderCode(req.order.shortCode)} ·{" "}
            {fmtCOP(req.order.totalCents)}
          </div>
        </div>
        <span className="px-2 h-6 inline-flex items-center rounded-full text-[10px] font-medium bg-ok/15 text-ok shrink-0">
          {t("badgeGenerated")}
        </span>
      </div>
      <div className="text-xs text-op-muted">
        {req.email}
        {cityDept(req) ? ` · ${cityDept(req)}` : ""}
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

      {req.simpleInvoiceId && <PrintOnTerminalButton invoiceId={req.simpleInvoiceId} />}
    </li>
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

/**
 * "Imprimir en datáfono" — manda la tirilla al SmartPOS vía el Print API
 * cloud de Kushki. Si el comercio tiene varios datáfonos, el endpoint
 * responde 409 choose_device con la lista y acá se muestra el picker.
 */
function PrintOnTerminalButton({ invoiceId }: { invoiceId: string }) {
  const t = useTranslations("opFacturas");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [devices, setDevices] = useState<Array<{ id: string; label: string }> | null>(null);

  async function send(deviceId?: string) {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/operator/invoices/${invoiceId}/print`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(deviceId ? { deviceId } : {}),
      });
      const j = (await res.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
        devices?: Array<{ id: string; label: string }>;
      };
      if (res.ok) {
        setDevices(null);
        setSent(true);
        setTimeout(() => setSent(false), 3000);
      } else if (j.error === "choose_device" && j.devices?.length) {
        setDevices(j.devices);
      } else if (j.error === "no_devices") {
        setErr(t("printNoDevices"));
      } else {
        setErr(j.message ?? t("printError"));
      }
    } catch {
      setErr(t("printError"));
    }
    setBusy(false);
  }

  return (
    <div className="mt-3">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => send()}
          disabled={busy}
          className="mp-btn mp-btn--sm mp-btn--secondary"
        >
          {busy
            ? t("printSending")
            : sent
              ? t("printSent")
              : t("printOnTerminal")}
        </button>
        {devices && (
          <>
            {devices.map((d) => (
              <button
                key={d.id}
                type="button"
                onClick={() => send(d.id)}
                disabled={busy}
                className="mp-chip"
              >
                {d.label}
              </button>
            ))}
          </>
        )}
      </div>
      {err && <div className="mt-1 text-[11px] text-danger">{err}</div>}
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
